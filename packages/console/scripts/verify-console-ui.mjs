// 控制台 UI 浏览器冒烟（零依赖：CDP over 系统 Chrome / Chromium）
//
// 为什么需要：E1（verify-console.mjs）覆盖静态托管与 /admin/api 契约，但不执行前端 JS；
// 一次批量编辑曾误删前端函数而 E1 全绿。本脚本在真实浏览器里加载 /console/，
// 断言：无页面异常、星图渲染、选项卡切换、设置弹窗与邀请面板可开、移动端无横向溢出。
//
// 环境变量：
//   CHROME_PATH  显式指定 Chrome/Chromium 可执行文件
//   无浏览器时 SKIP（exit 0），保证本地/受限环境可跑

/* global WebSocket */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, '..', '..', 'mcp', 'bin', 'mebular.mjs');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function seedHome(home) {
  const storagePath = join(home, 'store.jsonl');
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath,
    deviceId: 'device-ui',
    encryption: { level: 'none' },
    network: { enabled: false },
    sync: { autoSync: true, pushOnWrite: true, antiEntropy: { enabled: false } },
    mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
  }, null, 2), 'utf-8');
  return storagePath;
}

function spawnServe(home, port) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', String(port)], {
    env: { ...process.env, MEBULAR_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  return { proc, getOut: () => out, getErr: () => err };
}

async function waitReady(handle, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = handle.getOut().match(/SERVE_READY (\{.*\})/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // 继续等待完整输出
      }
    }
    if (handle.proc.exitCode !== null) throw new Error(`serve 提前退出：${handle.getErr().slice(-400)}`);
    await sleep(120);
  }
  throw new Error(`serve 就绪超时：${handle.getErr().slice(-400)}`);
}

function waitHttp(url, timeoutMs = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`HTTP 未就绪：${url}`));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

/** 启动系统 Chrome 的 headless CDP，返回 ws 端点与清理函数 */
function launchChrome(executablePath) {
  return new Promise((resolve, reject) => {
    const userDataDir = join(tmpdir(), `mebular-ui-smoke-${process.pid}-${Date.now()}`);
    const proc = spawn(executablePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const started = Date.now();
    const timer = setInterval(() => {
      const match = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearInterval(timer);
        resolve({ proc, wsUrl: match[1], userDataDir });
      } else if (proc.exitCode !== null || Date.now() - started > 15000) {
        clearInterval(timer);
        reject(new Error(`Chrome 未就绪（exit=${proc.exitCode}）：${err.slice(-300)}`));
      }
    }, 100);
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.once('error', (error) => { clearInterval(timer); reject(error); });
  });
}

/** 极简 CDP 客户端（依赖 Node 内建 WebSocket） */
function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (event) => reject(new Error(`CDP 连接失败：${event?.message ?? 'error'}`));
  });
  ws.onmessage = (event) => {
    let msg = null;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const handler = pending.get(msg.id);
      pending.delete(msg.id);
      handler(msg);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, (msg) => {
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { ws, ready, send, events };
}

async function main() {
  console.log('Mebular 控制台 UI 冒烟（headless Chrome / CDP）');

  const chrome = findChrome();
  if (!chrome) {
    console.log('  ⚠ 未找到 Chrome/Chromium（可用 CHROME_PATH 指定）→ SKIP');
    process.exit(0);
  }

  const home = await mkdtemp(join(tmpdir(), 'mebular-ui-home-'));
  const port = await freePort();
  const handle = spawnServe(home, port);
  let chromeHandle = null;
  let cdp = null;
  try {
    await seedHome(home);
    const ready = await waitReady(handle);
    check('serve 启动（SERVE_READY）', Number.isInteger(ready.port) && ready.port > 0, `port=${ready.port}`);
    const base = `http://127.0.0.1:${ready.port}`;
    check('GET /console/ 200', (await waitHttp(`${base}/console/`)) === 200);

    chromeHandle = await launchChrome(chrome);
    cdp = connectCdp(chromeHandle.wsUrl);
    await cdp.ready;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    const evalJs = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    };
    const waitFor = async (expression, timeoutMs = 15000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await evalJs(expression)) return true;
        await sleep(200);
      }
      return false;
    };

    await send('Page.navigate', { url: `${base}/console/` });
    check('页面加载完成（标题 / #stage）', await waitFor('document.title.includes("控制台") && Boolean(document.querySelector("#stage"))'));
    check('星图画布已渲染（尺寸 > 0）', await evalJs('(() => { const c = document.querySelector("#stage"); return c.width > 0 && c.height > 0; })()'));
    check('首屏数据到达（记忆徽标非占位）', await waitFor('!/…/.test(document.querySelector("#memory-badge")?.textContent ?? "…")'));

    // 选项卡切换（曾因误删 setView 失效）
    await evalJs('document.querySelector("#view-nav li:nth-of-type(2) button").click()');
    check('切换到域视图（#domains-view 可见）', await waitFor('document.querySelector("#domains-view")?.hidden === false'));
    await evalJs('document.querySelector("#view-nav li:nth-of-type(1) button").click()');
    check('切回星图视图', await waitFor('document.querySelector("#domains-view")?.hidden === true'));

    // 设置弹窗（IA：常用/高级/诊断 + 关于本机）
    await evalJs('document.querySelector("#open-settings").click()');
    check('设置弹窗打开（分区页签 + 常用配置编辑器）', await waitFor('document.querySelectorAll("#settings-body .settings-tab").length >= 3 && Boolean(document.querySelector("#settings-body .cfg-editor"))'));

    // 待重启：页面内写配置（CSRF 取自 document.cookie）→ 设置弹窗出现「待重启」并含变更项；改回后清空
    const applyIntervalMs = async (value) => evalJs(`(async () => {
      const raw = document.cookie.match(/(?:^|; )mebular_csrf=([^;]*)/);
      const csrf = raw ? decodeURIComponent(raw[1]) : '';
      const body = JSON.stringify({ patch: { sync: { antiEntropy: { intervalMs: ${value} } } } });
      const res = await fetch('/admin/api/config', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf }, body });
      return res.status;
    })()`);
    const wrotePending = await applyIntervalMs(123456);
    check('UI 待重启：页面内写 sync.antiEntropy.intervalMs → 200', wrotePending === 200, `status=${wrotePending}`);
    check(
      'UI 待重启：设置弹窗出现「待重启」并含变更项（反熵间隔）',
      await waitFor('(() => { const el = document.querySelector("[data-pending-restart]"); return Boolean(el) && /待重启/.test(el.textContent) && /反熵间隔/.test(el.textContent) && /sync\\.antiEntropy\\.intervalMs/.test(el.textContent); })()'),
    );
    check(
      'UI 待重启：设置入口徽标标注「待重启 N 项」',
      await waitFor('/待重启/.test(document.querySelector("#settings-pending-badge")?.textContent ?? "")'),
    );
    const revertedPending = await applyIntervalMs(null);
    check('UI 待重启：改回（删除 intervalMs）→ 200', revertedPending === 200, `status=${revertedPending}`);
    check('UI 待重启：pendingRestart 清空后提示消失', await waitFor('!document.querySelector("[data-pending-restart]")'));

    await evalJs('document.querySelector("#settings-close").click()');
    // 关于本机（点顶栏本机徽标进入）
    await evalJs('document.querySelector("#self-badge").click()');
    check('关于本机打开（身份/运行状态区块）', await waitFor('Boolean(document.querySelector("[data-info-block=identity]")) || /关于本机/.test(document.querySelector("#settings-body")?.textContent ?? "")'));
    await evalJs('document.querySelector("#settings-close").click()');

    // 邀请面板（joinService 未启用 → 引导文案；启用 → 令牌。两者都应有内容）
    await evalJs('document.querySelector("#invite-device").click()');
    check('邀请面板打开且渲染内容', await waitFor('(() => { const el = document.querySelector("#invite-body"); return Boolean(el) && el.textContent.trim().length > 0; })()'));
    await evalJs('document.querySelector("#invite-close").click()');

    // 移动端无横向溢出
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
    const overflow = await evalJs('document.documentElement.scrollWidth - window.innerWidth');
    check('移动视口无横向溢出', overflow <= 1, `overflow=${overflow}`);
    await send('Emulation.clearDeviceMetricsOverride');

    // 页面异常（pageerror / console.error / Log error）
    const pageErrors = cdp.events.filter((event) => {
      if (event.method === 'Runtime.exceptionThrown') return true;
      if (event.method === 'Runtime.consoleAPICalled') return event.params?.type === 'error';
      // network 类日志不视为前端异常（如邀请未启用时的预期 409）
      if (event.method === 'Log.entryAdded') {
        return event.params?.entry?.level === 'error' && event.params?.entry?.source !== 'network';
      }
      return false;
    });
    check(
      '无页面异常 / error 级日志',
      pageErrors.length === 0,
      pageErrors.slice(0, 2).map((event) => event.params?.exceptionDetails?.exception?.description ?? event.params?.entry?.text ?? event.method).join(' | '),
    );
  } catch (error) {
    check('UI 冒烟执行', false, String(error?.message ?? error));
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      // 忽略
    }
    try {
      chromeHandle?.proc.kill('SIGKILL');
    } catch {
      // 忽略
    }
    try {
      handle.proc.kill('SIGKILL');
    } catch {
      // 忽略
    }
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log('===============================');
  if (failed === 0) {
    console.log(`✓ 控制台 UI 冒烟通过（${passed} 项）`);
    process.exit(0);
  }
  console.log(`✗ 控制台 UI 冒烟失败（${failed}/${passed + failed}）`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`✗ UI 冒烟异常：${error?.message ?? error}`);
  process.exit(1);
});
