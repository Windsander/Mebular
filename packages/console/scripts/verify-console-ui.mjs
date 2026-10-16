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

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  // UX-2 收口联调用料（全在沙箱 home 内）：
  // ① opencode 配置存在但无 mebular 键 → 「未接入」行（hasVerify=true，可点行内验证）
  await mkdir(join(home, '.config', 'opencode'), { recursive: true });
  await writeFile(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ theme: 'dark' }, null, 2), 'utf-8');
  // ② 自定义助手落面文件（{} 无 mebular 键）→ 登记后「未接入」
  await writeFile(join(home, 'custom-mcp.json'), '{}\n', 'utf-8');
  // ③ 补丁 3 接入失败实证用料：坏 JSON（connect 走「配置无法解析」不写入路径，零写入风险）
  await writeFile(join(home, 'broken-mcp.json'), '{ bad json', 'utf-8');
  return storagePath;
}

function spawnServe(home, port) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', String(port)], {
    env: { ...process.env, MEBULAR_HOME: home, MEBULAR_USER_HOME: home },
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
    const match = handle.getOut().match(/(?:PROVISION_READY|SERVE_READY) (\{.*\})/);
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
      '--use-mock-keychain',
      '--password-store=basic',
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

/**
 * Chrome 启动重试：CI runner 偶发 CDP/dbus 启动抖动（stderr 形如
 * "Could not parse server address: Unknown address type"）——杀掉重来，最多 3 次。
 */
async function launchChromeRetry(executablePath, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    let handle = null;
    try {
      handle = await launchChrome(executablePath);
      return handle;
    } catch (error) {
      lastError = error;
      try { handle?.proc?.kill('SIGKILL'); } catch { /* 已退出 */ }
      await rm(handle?.userDataDir, { recursive: true, force: true }).catch(() => undefined);
      await sleep(500 * (i + 1));
    }
  }
  throw lastError;
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
  await seedHome(home);
  // G-ML-1：播种一条记忆，供记忆生命周期视图用例。
  // 必须在 serve 启动**之前**直接写存储：serve 持锁后 CLI 会改走 HTTP，而
  // config.json 里 mcp.http.port=0（真实端口来自 --port 参数）→ 连接失败。
  try {
    execFileSync(process.execPath, [bin, 'memory_write', '--input', JSON.stringify({ items: [{ type: 'fact', content: 'UI 生命周期记忆' }] })], {
      env: { ...process.env, MEBULAR_HOME: home },
      encoding: 'utf-8',
    });
  } catch (error) {
    console.log(`  ⚠ G-ML-1 播种记忆失败（后续记忆视图断言将随之失败）：${String(error?.message ?? error).split('\n')[0].slice(0, 160)}`);
  }
  const handle = spawnServe(home, port);
  let chromeHandle = null;
  let cdp = null;
  try {
    const ready = await waitReady(handle);
    check('serve 启动（SERVE_READY）', Number.isInteger(ready.port) && ready.port > 0, `port=${ready.port}`);
    const base = `http://127.0.0.1:${ready.port}`;
    check('GET /console/ 200', (await waitHttp(`${base}/console/`)) === 200);

    chromeHandle = await launchChromeRetry(chrome);
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
    // UX-2 首屏叠加层（只读；星图本体不改）
    check('UX-2 首屏状态总览条可见（纯只读：守护/对端/记忆）', await waitFor('(() => { const p = document.querySelector("#status-pill"); return Boolean(p) && p.hidden === false && /守护/.test(p.textContent) && /对端/.test(p.textContent) && /记忆/.test(p.textContent); })()'));
    check('UX-2「需要注意」浮卡条件渲染（无事不出现；有事则条目可点）', await evalJs('(() => { const c = document.querySelector("#attention-card"); return Boolean(c) && (c.hidden === true || c.querySelectorAll("[data-attention-action]").length > 0); })()'));

    // §7：导航序与命名（星图 / 共享 / 记忆 / 审计；data-view 驱动切换，顺序不影响行为）
    check('§7 导航：tab 顺序与命名 = 星图/共享/记忆/审计',
      await evalJs(`(() => {
        const labels = Array.from(document.querySelectorAll('#view-nav .view-label')).map((el) => el.textContent);
        return JSON.stringify(labels) === JSON.stringify(['星图', '共享', '记忆', '审计']);
      })()`));

    // 选项卡切换（曾因误删 setView 失效）
    await evalJs('document.querySelector("#view-nav li:nth-of-type(2) button").click()');
    check('切换到域视图（#domains-view 可见）', await waitFor('document.querySelector("#domains-view")?.hidden === false'));
    await evalJs('document.querySelector("#view-nav li:nth-of-type(1) button").click()');
    check('切回星图视图', await waitFor('document.querySelector("#domains-view")?.hidden === true'));

    // G-ML-1：记忆生命周期视图（动作式：归档 / 解除归档 / 删除；默认过滤已删除与已归档）
    await evalJs('document.querySelector("#view-nav li:nth-of-type(3) button").click()');
    check('切换到记忆视图（#memories-view 可见）', await waitFor('document.querySelector("#memories-view")?.hidden === false'));
    check('记忆视图含过滤器 + 记忆行 + 归档/删除动作按钮',
      await waitFor('(() => { const v = document.querySelector("#memories-view"); return Boolean(v) && Boolean(v.querySelector("#mem-filter-archived")) && Boolean(v.querySelector("#mem-filter-deleted")) && v.querySelectorAll(".mem-row").length >= 1 && Boolean(v.querySelector("[data-mem-action=archive]")) && Boolean(v.querySelector("[data-mem-action=delete]")); })()'));
    check('记忆视图说明人话化（归档可逆不参与回忆；删除不可逆；无内部术语）',
      await evalJs('(() => { const t = document.querySelector("#memories-view")?.textContent ?? ""; return /归档/.test(t) && /不再参与回忆/.test(t) && /不可逆/.test(t) && !/metadata/.test(t) && !/CSRF/.test(t) && !/scope/.test(t); })()'));
    // 归档：默认过滤下该行要么消失，要么按钮翻转为「解除归档」
    await evalJs('(() => { const b = document.querySelector("#memories-list [data-mem-action=archive]"); if (b) b.click(); })()');
    check('记忆视图：归档动作生效（行被过滤或按钮翻转）',
      await waitFor('(() => { const list = document.querySelector("#memories-list"); if (!list) return false; return Boolean(list.querySelector("[data-mem-action=unarchive]")) || list.querySelectorAll(".mem-row").length === 0; })()', 30000)); // 写后收敛可能受 serve 同步探针拖慢（断言内容不变）
    // 勾选「显示已归档」→ 出现「已归档」徽标与「解除归档」
    await evalJs('document.querySelector("#mem-filter-archived").click()');
    check('记忆视图：显示已归档后出现「已归档」徽标与「解除归档」',
      await waitFor('(() => { const v = document.querySelector("#memories-view"); return Boolean(v.querySelector("[data-mem-action=unarchive]")) && /已归档/.test(v.textContent); })()', 30000));
    // 解除归档（可逆）后关掉过滤，视图仍可交互
    await evalJs('(() => { const b = document.querySelector("#memories-list [data-mem-action=unarchive]"); if (b) b.click(); })()');
    await evalJs('document.querySelector("#mem-filter-archived").click()');
    check('记忆视图：解除归档后视图仍可交互（刷新按钮就位）',
      await waitFor('Boolean(document.querySelector("#memories-view")) && Boolean(document.querySelector("#mem-refresh"))'));
    await evalJs('document.querySelector("#view-nav li:nth-of-type(1) button").click()');
    check('从记忆视图切回星图', await waitFor('document.querySelector("#memories-view")?.hidden === true'));

    // H-1/UX-2：设置 · AI 助手专区（连接页已收编进设置；单列表 + 行内闭环）
    await evalJs('document.querySelector("#open-settings").click()');
    check('设置弹层打开', await waitFor('document.querySelector("#settings")?.hidden === false'));
    check('常驻运行行归设置 · 常用（状态 + 动作按钮）',
      await waitFor('(() => { const r = document.querySelector("#settings-resident"); return Boolean(r) && /常驻/.test(r.textContent) && r.querySelectorAll("[data-svc-action]").length >= 1; })()'));
    await evalJs('document.querySelector("[data-settings-tab=assistants]").click()');
    check('AI 助手页打开（assistants 面板可见）', await waitFor('document.querySelector("#settings-panel-assistants")?.hidden === false'));
    check('AI 助手单列表渲染（≥5 行 + 状态词 + 每行一个动作）',
      await waitFor('(() => { const p = document.querySelector("#settings-panel-assistants"); return Boolean(p) && p.querySelectorAll(".asst-row").length >= 5 && p.querySelectorAll("[data-cli-action]").length >= 1 && /未安装|未接入|已接入/.test(p.textContent); })()'));
    // 行内「详情 ›」（opencode：沙箱已置配置但无 mebular 键 → 未接入）→ 次级动作 → 「查看改动」diff 预览
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-cli-action=details][data-cli-id=opencode]"); if (b) b.click(); })()');
    check('行内「详情 ›」展开次级动作（含 hasVerify 行的「验证」）',
      await waitFor('Boolean(document.querySelector("#settings-panel-assistants [data-cli-action=preview][data-cli-id=opencode]")) && Boolean(document.querySelector("#settings-panel-assistants [data-cli-action=verify][data-cli-id=opencode]"))'));
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-cli-action=preview][data-cli-id=opencode]"); if (b) b.click(); })()');
    check('「查看改动」→ diff 预览出现', await waitFor('(() => { const d = document.querySelector("#settings-panel-assistants .connect-diff"); return Boolean(d) && (d.textContent ?? "").trim().length > 0; })()'));

    // UX-2 收口 ②行内 verify：沙箱回读必败（无 mebular 键）→ 验证未过黄态一行 + 重新验证 + 详情含输出
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-cli-action=verify][data-cli-id=opencode]"); if (b) b.click(); })()');
    const verifyOk = await waitFor('(() => { const v = document.querySelector("#settings-panel-assistants [data-asst-verify=opencode]"); return Boolean(v) && /回读校验/.test(v.textContent) && /CLI 验证/.test(v.textContent); })()', 20000);
    check('行内验证：steps[] 展开（回读校验 + CLI 验证）', verifyOk);
    if (!verifyOk) {
      console.log('  · [诊断] verify 块:', await evalJs('document.querySelector("#settings-panel-assistants [data-asst-verify=opencode]")?.outerHTML?.slice(0, 400) ?? "（无）"').catch((e) => String(e)));
      console.log('  · [诊断] 行状态:', await evalJs('document.querySelector("#settings-panel-assistants [data-asst-row=opencode]")?.textContent ?? "（无行）"').catch((e) => String(e)));
      console.log('  · [诊断] 页面异常:', await evalJs('JSON.stringify(window.__pageErrors ?? [])').catch((e) => String(e)));
    }
    check('验证未过 = 黄态一行 + 「重新验证」+ 详情含输出',
      await waitFor('(() => { const v = document.querySelector("#settings-panel-assistants [data-asst-verify=opencode]"); if (!v || !/验证未过/.test(v.textContent)) return false; if (!v.querySelector("details")) return false; const row = document.querySelector("#settings-panel-assistants [data-asst-row=opencode]"); return Boolean(row) && /重新验证/.test(row.textContent); })()', 20000));
    check('manual（generic 粘片段）行永不出现自动写「接入」',
      await evalJs('(() => { const row = document.querySelector("#settings-panel-assistants [data-asst-row=generic]"); const xp = document.querySelector("#settings-panel-assistants [data-asst-xp=generic]"); if (!row || !/查看片段/.test(row.textContent)) return false; return !row.querySelector("[data-cli-action=connect]") && !(xp && xp.querySelector("[data-cli-action=connect]")); })()'));

    // UX-2 收口 ①＋新增助手 CRUD：登记（POST）→ 列表即时出现 → 编辑（PUT）→ 移除（POST remove）
    await evalJs('document.querySelector("#asst-add").click()');
    check('＋新增助手表单出现（选文件 / 粘片段双模式）',
      await waitFor('(() => { const f = document.querySelector("#asst-add-form"); return Boolean(f) && f.querySelectorAll("input[name=asst-mode]").length === 2 && Boolean(f.querySelector("#asst-add-path")); })()'));
    await evalJs(`(() => {
      document.querySelector('#asst-add-name').value = 'UI 测试助手';
      document.querySelector('#asst-add-id').value = 'ui-test-asst';
      document.querySelector('#asst-add-path').value = ${JSON.stringify(join(home, 'custom-mcp.json'))};
      document.querySelector('#asst-add-format').value = 'mcpServers';
      document.querySelector('#asst-add-submit').click();
    })()`);
    const regOk = await waitFor('(() => { const r = document.querySelector("#settings-panel-assistants [data-asst-row=ui-test-asst]"); return Boolean(r) && /UI 测试助手/.test(r.textContent) && /未接入/.test(r.textContent) && Boolean(r.querySelector(".asst-tag")); })()', 30000); // 写后收敛余量（断言内容不变）
    check('登记后列表即时出现（自定义标记 + 入三态机：未接入）', regOk);
    if (!regOk) {
      // 失败诊断（不中断）：表单错误行 / 表单是否还在 / 当前行集合 / 服务端真实注册表
      console.log('  · [诊断] 表单错误行：', await evalJs('document.querySelector("#asst-add-error")?.textContent ?? "（无）"').catch((e) => String(e)));
      console.log('  · [诊断] 表单仍打开：', await evalJs('Boolean(document.querySelector("#asst-add-form"))').catch((e) => String(e)));
      console.log('  · [诊断] 面板行：', await evalJs('JSON.stringify(Array.from(document.querySelectorAll("#settings-panel-assistants [data-asst-row]")).map((r) => r.dataset.asstRow))').catch((e) => String(e)));
      console.log('  · [诊断] 服务端 custom：', await evalJs('fetch("/admin/api/clients").then((r) => r.json()).then((j) => JSON.stringify((j.clients ?? []).filter((c) => c.kind === "custom").map((c) => [c.id, c.state, c.kind])))').catch((e) => String(e)));
    }
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-cli-action=details][data-cli-id=ui-test-asst]"); if (b) b.click(); })()');
    check('自定义行详情含「编辑」「移除」',
      await waitFor('Boolean(document.querySelector("#settings-panel-assistants [data-asst-edit=ui-test-asst]")) && Boolean(document.querySelector("#settings-panel-assistants [data-asst-remove=ui-test-asst]"))'));
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-asst-edit=ui-test-asst]"); if (b) b.click(); })()');
    check('编辑模式表单预填（id 禁改）',
      await waitFor('(() => { const f = document.querySelector("#asst-add-form"); return Boolean(f) && f.dataset.editId === "ui-test-asst" && document.querySelector("#asst-add-id").disabled === true && document.querySelector("#asst-add-name").value === "UI 测试助手"; })()'));
    await evalJs('(() => { document.querySelector("#asst-add-name").value = "UI 测试助手改"; document.querySelector("#asst-add-submit").click(); })()');
    check('保存修改后列表即时更新（PUT 生效）',
      await waitFor('(() => { const r = document.querySelector("#settings-panel-assistants [data-asst-row=ui-test-asst]"); return Boolean(r) && /UI 测试助手改/.test(r.textContent); })()', 30000));
    await evalJs('window.confirm = () => true'); // 移除的二次确认桩住（headless 无对话框）
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-asst-remove=ui-test-asst]"); if (b) b.click(); })()');
    check('移除后行消失（POST remove 生效）',
      await waitFor('!document.querySelector("#settings-panel-assistants [data-asst-row=ui-test-asst]")', 30000));

    // UX-2 补丁 3 · 接入失败反馈语义（沙箱实证）：坏 JSON 自定义助手 →「接入失败」+ 一行原因，绝不显示「待生效」
    await evalJs('document.querySelector("#asst-add").click()');
    await waitFor('Boolean(document.querySelector("#asst-add-form"))');
    await evalJs(`(() => {
      document.querySelector('#asst-add-name').value = '坏配置助手';
      document.querySelector('#asst-add-id').value = 'ui-broken-asst';
      document.querySelector('#asst-add-path').value = ${JSON.stringify(join(home, 'broken-mcp.json'))};
      document.querySelector('#asst-add-format').value = 'mcpServers';
      document.querySelector('#asst-add-submit').click();
    })()`);
    check('失败用料登记入列（未接入）',
      await waitFor('Boolean(document.querySelector("#settings-panel-assistants [data-asst-row=ui-broken-asst]"))', 30000));
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-asst-row=ui-broken-asst] [data-cli-action=connect]"); if (b) b.click(); })()');
    check('接入失败 →「接入失败」+ 一行原因（配置不是合法 JSON）+「重试」，不显示「待生效」',
      await waitFor('(() => { const r = document.querySelector("#settings-panel-assistants [data-asst-row=ui-broken-asst]"); const xp = document.querySelector("#settings-panel-assistants [data-asst-xp=ui-broken-asst]"); if (!r || !/接入失败/.test(r.textContent)) return false; if (/待生效/.test(r.textContent)) return false; return Boolean(xp) && /配置不是合法 JSON|无法解析/.test(xp.textContent) && /重试/.test(r.textContent); })()', 30000));
    // 清理：展开详情移除（confirm 已桩住）
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-cli-action=details][data-cli-id=ui-broken-asst]"); if (b) b.click(); })()');
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-asst-remove=ui-broken-asst]"); if (b) b.click(); })()');
    check('失败用料移除（场地清理）',
      await waitFor('!document.querySelector("#settings-panel-assistants [data-asst-row=ui-broken-asst]")', 30000));
    await evalJs('document.querySelector("#settings-close").click()');

    // ---------- 背景层契约（crt-surface / crt-screen 扫描线 ::before 定位） ----------
    // 回归场景（真机反馈：记忆共享 / 连接 AI 助手背景重叠、局部生效）：
    // 卡片基元自身不定位时，::before(absolute inset:0) 逃逸到最近的已定位祖先
    // （面板/弹窗），N 张卡 = N 层全屏扫描线叠加，且锚定滚动内容原点 → 滚动后下方无覆盖。
    // 契约：① 背景画布唯一；② 每个 crt-surface/crt-screen 基元自成定位上下文（非 static）；
    // ③ 三个面板视图的背景样式与扫描线行为完全一致，且扫描线 fixed 钉住可视区（滚动不失效）。
    // （UX-2：连接视图收编进设置弹层，面板视图剩 domains/audit/memories 三个。）
    check('背景画布唯一（canvas.stage-bg 不重复插入）',
      await evalJs('document.querySelectorAll("canvas.stage-bg").length === 1'));

    const probeViewBg = `(async (viewId, cardSelectors) => {
      const view = document.getElementById(viewId);
      if (!view || view.hidden) return null;
      const cs = getComputedStyle(view);
      const before = getComputedStyle(view, '::before');
      const cards = cardSelectors.map((sel) => {
        const els = Array.from(view.querySelectorAll(sel));
        if (els.length === 0) return { sel, missing: true };
        return { sel, positions: els.map((el) => getComputedStyle(el).position) };
      });
      return { viewId, bgColor: cs.backgroundColor, bgImage: cs.backgroundImage, beforePosition: before.position, cards };
    })`;
    const viewTabs = { 'domains-view': 2, 'memories-view': 3, 'audit-view': 4 };
    const viewCards = {
      'domains-view': ['#domains-list', '#domain-detail .sector-readout'],
      'audit-view': [],
      'memories-view': ['#memories-list .mem-row'],
    };
    const bgReports = [];
    for (const [viewId, nth] of Object.entries(viewTabs)) {
      await evalJs(`document.querySelector("#view-nav li:nth-of-type(${nth}) button").click()`);
      await waitFor(`document.getElementById("${viewId}")?.hidden === false`);
      bgReports.push(await evalJs(`${probeViewBg}(${JSON.stringify(viewId)}, ${JSON.stringify(viewCards[viewId])})`));
    }
    check('三个面板视图均激活并探针成功', bgReports.every((r) => r && r.beforePosition),
      JSON.stringify(bgReports.map((r) => r?.viewId ?? null)));
    check('面板扫描线钉住可视区（::before position: fixed，三视图一致）',
      bgReports.every((r) => r.beforePosition === 'fixed'),
      JSON.stringify(bgReports.map((r) => r.beforePosition)));
    check('面板背景样式三视图一致（background-color / background-image）',
      bgReports.every((r) => r.bgColor === bgReports[0].bgColor && r.bgImage === bgReports[0].bgImage));
    const escapedCards = bgReports.flatMap((r) => r.cards
      .filter((c) => !c.missing)
      .flatMap((c) => c.positions.map((p, i) => (p === 'static' ? `${r.viewId} ${c.sel}[${i}]` : null)))
      .filter(Boolean));
    check('卡片基元自成定位上下文（crt-surface/crt-screen 非 static，::before 不逃逸）',
      escapedCards.length === 0 && bgReports.every((r) => r.cards.every((c) => !c.missing || c.sel === '#memories-list .mem-row')),
      escapedCards.slice(0, 3).join(', '));
    // 滚动稳定性：审计视图滚到底部后扫描线仍钉住（fixed ⇒ 不随内容移走）
    await evalJs('document.querySelector("#view-nav li:nth-of-type(4) button").click()');
    await waitFor('document.getElementById("audit-view")?.hidden === false');
    const scrollProbe = await evalJs(`(() => {
      const view = document.getElementById('audit-view');
      // 垫片**确定性制造溢出**，测完移除并还原滚动位——断言强度（scrollTop>0 && fixed）不变。
      const spacer = document.createElement('div');
      spacer.id = 'ui-probe-spacer';
      spacer.style.height = '2000px';
      view.appendChild(spacer);
      view.scrollTop = view.scrollHeight;
      const out = {
        scrollTop: view.scrollTop,
        beforePosition: getComputedStyle(view, '::before').position,
        overflowY: getComputedStyle(view).overflowY,
      };
      spacer.remove();
      view.scrollTop = 0;
      return out;
    })()`);
    check('面板滚动到底后扫描线仍覆盖可视区（fixed 不随滚动失效）',
      scrollProbe.scrollTop > 0 && scrollProbe.beforePosition === 'fixed',
      JSON.stringify(scrollProbe));
    // 跨 3s 轮询：背景契约不回退（重渲染不重建背景层/不掉定位上下文）
    await sleep(3600);
    const repoll = await evalJs(`${probeViewBg}("audit-view", [])`);
    check('跨 3s 轮询背景契约保持（fixed 不丢）',
      Boolean(repoll) && repoll.beforePosition === 'fixed',
      JSON.stringify(repoll?.beforePosition));
    await evalJs('document.querySelector("#view-nav li:nth-of-type(1) button").click()');

    // 设置弹窗（IA：常用/高级/诊断 + 关于本机）
    await evalJs('document.querySelector("#open-settings").click()');
    check('设置弹窗打开（分区页签 + 常用配置编辑器）', await waitFor('document.querySelectorAll("#settings-body .settings-tab").length >= 3 && Boolean(document.querySelector("#settings-body .cfg-editor"))'));

    // 轮询重建回归（修复前：render() 每 3s 整体重建 #settings-body → 原生 <select> 弹层被销毁、选择丢失）
    const authSelector = '#settings-body select[data-cfg-path="mcp.http.auth"]';
    check('设置内存在 auth 下拉', await waitFor(`Boolean(document.querySelector('${authSelector}'))`));
    await evalJs(`window.__settingsProbe = document.querySelector('#settings-body .settings-tabs'); window.__authProbe = document.querySelector('${authSelector}');`);
    await sleep(3600);
    check('跨 3s 轮询设置容器节点引用不变（DOM 未重建）', await evalJs('Boolean(window.__settingsProbe) && window.__settingsProbe === document.querySelector("#settings-body .settings-tabs")'));
    check('跨 3s 轮询 auth 下拉节点引用不变', await evalJs(`Boolean(window.__authProbe) && window.__authProbe === document.querySelector('${authSelector}')`));

    // 简化轮 · 设置三分法：3 tab（诊断并入高级）；订阅域移出；反熵细节不出屏；无「保存」按钮
    check('简化轮：设置 3 页签（常用/AI 助手/高级）且无诊断页签/保存按钮',
      await evalJs('document.querySelectorAll("#settings-body .settings-tab:not(.settings-tab-extra)").length === 3 && !document.querySelector("#settings-panel-diagnostics") && !document.querySelector("[data-cfg-action=save]")'));
    check('简化轮：订阅域与反熵细节不出设置页（grep 断言面）',
      await evalJs(`(() => { const body = document.querySelector("#settings-body"); return !body.querySelector('[data-cfg-path="sync.namespaces"]') && !body.querySelector('[data-cfg-path="sync.antiEntropy.intervalMs"]') && !body.querySelector('[data-cfg-path="sync.antiEntropy.jitterRatio"]') && !body.querySelector('[data-cfg-path="sync.snapshotThreshold"]') && !body.querySelector('[data-cfg-path="semantic.minScore"]') && Boolean(body.querySelector('[data-cfg-path="sync.antiEntropy.enabled"]')); })()`));
    check('简化轮：诊断并入高级底部折叠（cfg-copy-all 就位）',
      await evalJs('(() => { document.querySelector("[data-settings-tab=advanced]")?.click(); const f = document.querySelector("#diag-fold"); return Boolean(f) && Boolean(f.querySelector("#cfg-copy-all")); })()'));
    await evalJs('document.querySelector("[data-settings-tab=common]").click()');

    // 即时生效：改低风险 toggle（joinService.enabled）→ 无草稿态、3s 跨轮询值持久（已写入）
    const toggleSel = '#settings-body input[data-cfg-path="joinService.enabled"]';
    check('即时生效：joinService 开关在常用页', await waitFor(`Boolean(document.querySelector('${toggleSel}'))`));
    const tgOriginal = await evalJs(`document.querySelector('${toggleSel}').checked`);
    await evalJs(`(() => { const el = document.querySelector('${toggleSel}'); el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(1200);
    await sleep(3600);
    check('即时生效：改动即写入且跨轮询持久（无「未保存修改」文案）',
      (await evalJs(`document.querySelector('${toggleSel}').checked`)) === !tgOriginal
        && (await evalJs('!/未保存修改/.test(document.querySelector("#settings-body").textContent)')),
      `checked=${!tgOriginal}`);
    // 复原开关（避免污染后续 pendingRestart 清空断言）
    await evalJs(`(() => { const el = document.querySelector('${toggleSel}'); el.checked = ${tgOriginal}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(1200);

    // G4 自锁：改 auth 下拉 → 品牌确认卡（409 needsConfirmation）→ 取消 → 不写盘值回弹
    const authOriginal = await evalJs(`document.querySelector('${authSelector}').value`);
    await evalJs(`(() => { const sel = document.querySelector('${authSelector}'); sel.value = sel.value === 'none' ? 'bearer' : 'none'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    check('即时生效 · 自锁项：品牌确认卡出现（不再用系统弹窗）', await waitFor('document.querySelector("#modal")?.hidden === false'));
    await evalJs('document.querySelector("#modal-cancel").click()');
    check('自锁取消 → 不写盘，auth 回原值', await waitFor(`document.querySelector('${authSelector}')?.value === ${JSON.stringify(authOriginal)}`));

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
    check(
      'D UI 三元组第三列：待重启横幅含「未生效原因」（服务端计算）',
      await waitFor('/未生效原因/.test(document.querySelector("[data-pending-restart]")?.textContent ?? "")'),
    );
    check(
      'C UI 一键重启按钮就位（待重启横幅内，写权限下可用）',
      await evalJs("(() => { const b = document.querySelector('[data-pending-restart] [data-cfg-action=\"restart\"]'); return Boolean(b) && !b.disabled; })()"),
    );
    const revertedPending = await applyIntervalMs(null);
    check('UI 待重启：改回（删除 intervalMs）→ 200', revertedPending === 200, `status=${revertedPending}`);
    check('UI 待重启：pendingRestart 清空后提示消失', await waitFor('!document.querySelector("[data-pending-restart]")'));
    await evalJs('document.querySelector("#settings-close").click()');
    // 关于本机（点顶栏本机徽标进入）
    await evalJs('document.querySelector("#self-badge").click()');
    check('关于本机打开（身份/运行状态区块）', await waitFor('Boolean(document.querySelector("[data-info-block=identity]")) || /关于本机/.test(document.querySelector("#settings-body")?.textContent ?? "")'));
    await evalJs('document.querySelector("#settings-close").click()');

    // UX-2：?view=connect 别名重定向 → 设置 · AI 助手自动打开
    await send('Page.navigate', { url: `${base}/console/?view=connect` });
    check('别名重定向：?view=connect → 设置 · AI 助手自动打开',
      await waitFor('document.querySelector("#settings")?.hidden === false && document.querySelector("#settings-panel-assistants")?.hidden === false'));
    await evalJs('document.querySelector("#settings-close").click()');
    // 邀请面板（joinService 未启用 → 引导文案；启用 → 令牌。两者都应有内容）
    await evalJs('document.querySelector("#invite-device").click()');
    check('邀请面板打开且渲染内容', await waitFor('(() => { const el = document.querySelector("#invite-body"); return Boolean(el) && el.textContent.trim().length > 0; })()'));
    await evalJs('document.querySelector("#invite-close").click()');

    // ---------- v4 记忆共享（W1-A）：?mock=1 验收路径 + 无审批族 + 参与事实 ----------
    await send('Page.navigate', { url: `${base}/console/?mock=1` });
    check('v4 mock：记忆共享统计新口径 + 左列参与标记',
      await waitFor('(() => { const s = document.querySelector("#domains-stats")?.textContent ?? ""; const list = document.querySelector("#domains-list")?.textContent ?? ""; return /记忆域 3/.test(s) && /参与中 2/.test(s) && /未参与/.test(list); })()'));
    await evalJs('document.querySelector("#domains-list [data-sector=notes]").click()');
    check('v4 mock：域卡 = 参与事实（关系行 + 参与的设备 + 状态文字化；无批准/撤回）',
      await waitFor(`(() => {
        const d = document.querySelector('#domain-detail');
        if (!d) return false;
        const t = d.textContent;
        return /也在参与这个域/.test(t) && /参与的设备/.test(t) && /参与中/.test(t)
          && /退出并交接这个域/.test(t)
          && !d.querySelector('[data-approve]') && !d.querySelector('[data-approve-member]') && !d.querySelector('[data-revoke-ns]')
          && !/批准/.test(t) && !/撤回/.test(t);
      })()`));
    check('v4 mock：无「HASH 平铺」与「成员制 ACTIVE/OFF」标签',
      await evalJs(`(() => { const t = document.querySelector('#domains-view')?.textContent ?? ''; return !/HASH/.test(t) && !/成员制/.test(t) && !/AUTH/.test(t) && !/MEMBERS/.test(t); })()`));
    // 记忆视图：mock 数据缺口已补（不再卡「记忆加载中…」；过滤本地生效；§7 后位于第 3 位）
    await evalJs('document.querySelector("#view-nav li:nth-of-type(3) button").click()');
    check('v4 mock：记忆视图可验收（memories 缺口已补，行渲染）',
      await waitFor('(() => { const v = document.querySelector("#memories-view"); return Boolean(v) && v.querySelectorAll(".mem-row").length >= 2 && !/记忆加载中/.test(v.textContent); })()'));
    await evalJs('document.querySelector("#mem-filter-archived").click()');
    check('v4 mock：显示已归档后出现归档行（本地过滤生效）',
      await waitFor('(() => { const v = document.querySelector("#memories-view"); return v.querySelectorAll(".mem-row").length >= 3 && /已归档/.test(v.textContent); })()'));
    await evalJs('document.querySelector("#mem-filter-archived").click()');
    // §7：审计——自动签发默认折叠为汇总行（展开见明细；人工动作保持显眼；跨轮询不丢展开态）
    await evalJs('document.querySelector("#view-nav li:nth-of-type(4) button").click()');
    check('§7 mock 审计：自动签发折叠为「自动签发 ×3」汇总行，人工行显眼',
      await waitFor(`(() => {
        const view = document.querySelector('#audit-view');
        if (!view || view.hidden) return false;
        const toggle = view.querySelector('.audit-auto-toggle');
        const manual = view.querySelectorAll('.audit-item:not(.audit-auto-head)');
        return Boolean(toggle) && /自动签发 ×3/.test(toggle.textContent)
          && view.querySelectorAll('.audit-auto-rows').length === 0
          && manual.length >= 2
          && /屏蔽设备/.test(view.textContent);
      })()`));
    await evalJs('document.querySelector("#audit-view .audit-auto-toggle").click()');
    check('§7 mock 审计：展开见明细（3 行，行内「自动」标记）',
      await waitFor(`(() => {
        const rows = document.querySelectorAll('#audit-view .audit-auto-rows .audit-item');
        return rows.length === 3 && Array.from(rows).every((row) => /自动/.test(row.textContent));
      })()`));
    await sleep(3600);
    check('§7 mock 审计：跨 3s 轮询展开态不丢（重渲染不折叠）',
      await evalJs('document.querySelectorAll("#audit-view .audit-auto-rows .audit-item").length === 3'));
    // 设备卡（对端）：interop 段为参与事实、无批准/撤回（?select= 深链选中）
    await send('Page.navigate', { url: `${base}/console/?mock=1&select=device-B` });
    check('v4 mock：设备卡对端 = 参与事实（它参与的记忆域 + 参与情况 + 双方/单方陈述）',
      await waitFor(`(() => {
        const b = document.querySelector('#device-card-body');
        if (!b || b.hidden) return false;
        const t = b.textContent;
        return /它参与的记忆域/.test(t) && /参与情况/.test(t)
          && /双方都在参与/.test(t) && /本机参与中 · 它未参与/.test(t)
          && /另有 1 个记忆域双方均未参与/.test(t);
      })()`));
    check('v4 mock：「有参与、零内容」的域在设备卡可见（ledger：不占主列表，协作信号不丢）',
      await evalJs(`(() => {
        const b = document.querySelector('#device-card-body');
        const domains = document.querySelector('#domains-list')?.textContent ?? '';
        const t = b?.textContent ?? '';
        return /ledger/.test(t) && /这个域还没有内容/.test(t) && !/ledger/.test(domains);
      })()`));
    check('v4 mock：设备卡无域级审批动作（批准/撤回按钮整组删除）',
      await evalJs(`(() => { const b = document.querySelector('#device-card-body'); if (!b || b.hidden) return false; const t = b.textContent; return !b.querySelector('[data-approve]') && !b.querySelector('[data-revoke-ns]') && !/批准/.test(t) && !/撤回/.test(t) && !/待你批准/.test(t); })()`));

    // 移动端无横向溢出
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
    const overflow = await evalJs('document.documentElement.scrollWidth - window.innerWidth');
    check('移动视口无横向溢出', overflow <= 1, `overflow=${overflow}`);
    await send('Emulation.clearDeviceMetricsOverride');

    // v4：≤900px 常驻横幅让位（不遮挡面板标题/统计）
    {
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await send('Page.navigate', { url: `${base}/console/` });
      check('v4 窄屏：活体面板视图就位（未启用 P2P 常驻横幅可见）',
        await waitFor('(() => { const b = document.querySelector("#banner"); return Boolean(b) && b.hidden === false && document.querySelector(".stage-wrap")?.classList.contains("has-banner"); })()'));
      await evalJs('document.querySelector("#view-nav li:nth-of-type(2) button").click()');
      await waitFor('document.querySelector("#domains-view")?.hidden === false');
      const bannerOverlap = await evalJs(`(() => {
        const banner = document.querySelector('#banner');
        const head = document.querySelector('#domains-view .view-head h2');
        if (!banner || banner.hidden || !head) return { ok: false, why: 'missing' };
        const b = banner.getBoundingClientRect();
        const h = head.getBoundingClientRect();
        return { ok: b.bottom <= h.top + 1, bannerBottom: Math.round(b.bottom), headTop: Math.round(h.top) };
      })()`);
      check('v4 窄屏：常驻横幅不遮挡面板标题（has-banner 让位）', bannerOverlap.ok === true, JSON.stringify(bannerOverlap));
      await send('Emulation.clearDeviceMetricsOverride');
      await send('Page.navigate', { url: `${base}/console/` });
      await waitFor('document.querySelector("#domains-view")?.hidden === true');
    }

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
    // ---------- F-ONB-2：引导态「建新 → 待重启」UX（前台进程无法自动重启） ----------
    {
      const onboardHome = await mkdtemp(join(tmpdir(), 'mebular-ui-onboard-'));
      const onboardPort = await freePort();
      const onboardHandle = spawnServe(onboardHome, onboardPort);
      try {
        const obReady = await waitReady(onboardHandle);
        const obBase = `http://127.0.0.1:${obReady.port}`;
        await send('Page.navigate', { url: `${obBase}/console/` });
        check('F-ONB-2 UI 引导页呈现（建新/加入两入口）',
          await waitFor('Boolean(document.querySelector("#provision")) && !document.querySelector("#provision").hidden && Boolean(document.querySelector("#provision-create"))'));
        await evalJs('document.querySelector("#provision-create").click()');
        check('F-ONB-2 UI ① 前台建新 → 呈现手动重启命令（不得出现「正在自动重启」）',
          await waitFor('(() => { const panel = document.querySelector("#provision-restart"); const cmd = document.querySelector("#provision-restart-command")?.textContent ?? ""; const all = document.querySelector("#provision")?.textContent ?? ""; return Boolean(panel) && panel.hidden === false && /mebular serve/.test(cmd) && !/正在自动重启/.test(all); })()'));
        await evalJs('document.querySelector("#provision-create").click()');
        check('F-ONB-2 UI ② 重复建新 → 显示「已完成 + 重启指引」（非裸错误）',
          await waitFor('(() => { const t = document.querySelector("#provision")?.textContent ?? ""; return /已完成/.test(t) && /mebular serve/.test(t) && !/失败：/.test(t); })()'));
        await send('Page.navigate', { url: `${obBase}/console/` });
        check('F-ONB-2 UI ③ 刷新 → 进入待重启态（命令 + 隐藏入口）',
          await waitFor('(() => { const panel = document.querySelector("#provision-restart"); const cmd = document.querySelector("#provision-restart-command")?.textContent ?? ""; const choices = document.querySelector("#provision-choices"); return Boolean(panel) && panel.hidden === false && /mebular serve/.test(cmd) && Boolean(choices) && choices.hidden === true; })()'));
      } finally {
        try { onboardHandle.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
        await rm(onboardHome, { recursive: true, force: true }).catch(() => undefined);
      }
    }
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
