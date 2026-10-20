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
import { createHash } from 'node:crypto';
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
  // S3：真实 root + 两条他机会签请求（批准/拒绝写入走真实端点，不靠桩）
  const { Mebular, IdentityManager, POLICY_NAMESPACE } = await import('@mebular/core');
  const { securityActionDigest, pairingCodeForDigest } = await import('@mebular/fleet');
  const master = await new IdentityManager().generateUserMasterKey();
  const defaultFingerprint = `sha256:${createHash('sha256').update(Buffer.from(master.publicKey)).digest('hex').slice(0, 12)}`;
  const keyFile = join(home, 'user-master-key.json');
  await writeFile(keyFile, JSON.stringify({
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath,
    deviceId: 'device-ui',
    encryption: { level: 'none', keyFile },
    network: { enabled: false },
    sync: { autoSync: true, pushOnWrite: true, antiEntropy: { enabled: false }, namespaces: ['notes', 'work'] },
    mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
    joinService: { enabled: true, bind: '0.0.0.0', port: 4013 },
  }, null, 2), 'utf-8');
  {
    const app = new Mebular({
      storagePath,
      deviceId: 'device-ui',
      encryption: { level: 'none', userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: false },
      sync: { autoSync: true, namespaces: ['notes', 'work'] },
    });
    await app.initialize();
    await app.declareNamespace({ namespace: 'notes', note: 'ui seed' });
    await app.declareNamespace({ namespace: 'work', note: 'ui seed' });
    await app.subscribeNamespace('notes');
    // device-C：设备卡/移出用例需要在 collectKnownDevices 里可见。它只收
    // authors / subscriptions / declarations / revokes / restores / handoff / online，
    // 不收 security_approval.target；用一条 C 自己签名的订阅记录种入（不改产品）。
    const cStorage = join(home, 'device-C.jsonl');
    const cApp = new Mebular({
      storagePath: cStorage,
      deviceId: 'device-C',
      encryption: { level: 'none', userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: false },
      sync: { autoSync: false, namespaces: ['notes'] },
    });
    await cApp.initialize();
    const cSubscription = await cApp.declareNamespaceSubscription({ namespace: 'notes', active: true });
    await cApp.shutdown();
    await app.eventLog.appendRemote(cSubscription);
    const now = Date.now();
    const kickNonce = 'ui-seed-kick';
    const kickDigest = securityActionDigest({ op: 'kick', initiator: 'device-peer', subject: 'device-C', nonce: kickNonce });
    await app.eventLog.append({
      type: 'security_approval',
      data: { securityApproval: {
        approvalId: 'ui-seed-kick-approval', op: 'kick', decision: 'request', initiator: 'device-peer',
        target: 'device-C', nonce: kickNonce, digest: kickDigest, pairingCode: pairingCodeForDigest(kickDigest),
        expiresAt: now + 9 * 60_000, issuedAt: now - 20_000, note: 'UI 批准用例',
      } },
      namespace: POLICY_NAMESPACE,
    });
    const joinNonce = 'ui-seed-join';
    const joinDigest = securityActionDigest({ op: 'join', initiator: 'device-peer', namespace: 'notes', nonce: joinNonce });
    await app.eventLog.append({
      type: 'security_approval',
      data: { securityApproval: {
        approvalId: 'ui-seed-join-approval', op: 'join', decision: 'request', initiator: 'device-peer',
        namespace: 'notes', nonce: joinNonce, digest: joinDigest, pairingCode: pairingCodeForDigest(joinDigest),
        expiresAt: now + 8 * 60_000, issuedAt: now - 10_000, note: 'UI 拒绝用例',
      } },
      namespace: POLICY_NAMESPACE,
    });
    await app.shutdown();
  }
  // UX-2 收口联调用料（全在沙箱 home 内）：
  // ① opencode 配置存在但无 mebular 键 → 「未接入」行（hasVerify=true，可点行内验证）
  await mkdir(join(home, '.config', 'opencode'), { recursive: true });
  await writeFile(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ theme: 'dark' }, null, 2), 'utf-8');
  // ② 自定义助手落面文件（{} 无 mebular 键）→ 登记后「未接入」
  await writeFile(join(home, 'custom-mcp.json'), '{}\n', 'utf-8');
  // ③ 补丁 3 接入失败实证用料：坏 JSON（connect 走「配置无法解析」不写入路径，零写入风险）
  await writeFile(join(home, 'broken-mcp.json'), '{ bad json', 'utf-8');
  // E2-A2：忆云注册表（默认当前 + 一台已归档），供卡片/切换兜底/改名/深链用例。
  await mkdir(join(home, 'profiles', 'p_demo0001'), { recursive: true });
  const nowIso = new Date().toISOString();
  await writeFile(join(home, 'profiles.json'), JSON.stringify({
    v: 1,
    current: 'default',
    profiles: [
      {
        id: 'default', name: '忆云 1', home: '.', kind: 'root',
        createdAt: nowIso, lastUsedAt: nowIso,
        masterFingerprint: defaultFingerprint, deviceId: 'device-ui',
      },
      {
        id: 'p_demo0001', name: '忆云 2', home: 'profiles/p_demo0001', kind: 'delegated',
        createdAt: nowIso, lastUsedAt: new Date(Date.now() - 86_400_000).toISOString(),
        masterFingerprint: 'sha256:222222222222', deviceId: 'device-ui',
      },
    ],
  }, null, 2), 'utf-8');
  return storagePath;
}

function spawnServe(home, port) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', String(port)], {
    // E2-A2：显式 CLOUD_ROOT 让临时 home 具备忆云注册表（否则自定义 home 会按设计关闭忆云管理）。
    env: { ...process.env, MEBULAR_HOME: home, MEBULAR_USER_HOME: home, MEBULAR_CLOUD_ROOT: home },
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
    // 验收截图：仅在显式指定 MEBULAR_SCREENSHOT_DIR 时写盘（CI 不产生文件）。
    const shotDir = process.env.MEBULAR_SCREENSHOT_DIR ?? null;
    if (shotDir) await mkdir(shotDir, { recursive: true });
    const capture = async (name, viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }) => {
      if (!shotDir) return null;
      await send('Emulation.setDeviceMetricsOverride', viewport);
      await sleep(250);
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
      await writeFile(join(shotDir, name), Buffer.from(shot.data, 'base64'));
      await send('Emulation.clearDeviceMetricsOverride');
      return join(shotDir, name);
    };

    await send('Page.navigate', { url: `${base}/console/` });
    check('页面加载完成（标题 / #stage）', await waitFor('document.title.includes("控制台") && Boolean(document.querySelector("#stage"))'));
    check('弹窗对齐规范：小弹窗 + 加入忆云 modal-center；其余大面板顶部对齐',
      await evalJs(`(() => {
        const small = ['wizard', 'invite', 'cloud-switch', 'security-action', 'handoff', 'modal', 'auth-token', 'namespace-new-modal', 'cloud-join'];
        const large = ['settings', 'about', 'provision'];
        const boxes = [...document.querySelectorAll('.modal .modal-box')];
        return small.every((id) => document.querySelector('#' + id)?.classList.contains('modal-center'))
          && large.every((id) => !document.querySelector('#' + id)?.classList.contains('modal-center'))
          && boxes.every((box) => box.classList.contains('crt-surface') && box.classList.contains('crt-corners'));
      })()`));
    check('弹窗宽度：邀请/新建域 520（非 wide）；加入忆云 640（wide）',
      await evalJs(`(() => {
        const wide = (id) => document.querySelector('#' + id + ' .modal-box')?.classList.contains('modal-box-wide');
        return wide('invite') === false && wide('namespace-new-modal') === false && wide('cloud-join') === true;
      })()`));
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
    check('E1 顶栏：无「连接已有地址」，仅保留「邀请设备」',
      await evalJs(`(() => {
        const actions = document.querySelector('.topbar-actions');
        return !document.querySelector('#add-device')
          && Boolean(document.querySelector('#invite-device'))
          && !/连接已有地址/.test(actions?.textContent ?? '');
      })()`));
    check('E2-A2 顶栏：忆云徽章取 overview.cloud.name（忆云 1）+ 对称「加入忆云 / 邀请设备」',
      await waitFor(`(() => {
        const badge = document.querySelector('#cloud-badge');
        const actions = document.querySelector('.topbar-actions');
        return Boolean(badge) && badge.hidden === false && /忆云 1/.test(badge.textContent)
          && Boolean(badge.querySelector('.cloud-mark')) && Boolean(badge.querySelector('.cloud-name'))
          && Boolean(document.querySelector('#join-cloud .cloud-mark')) && Boolean(document.querySelector('#invite-device'))
          && /加入忆云/.test(actions?.textContent ?? '') && !document.querySelector('#add-device');
      })()`));
    await capture('e2a2-after-topbar-live.jpg');

    // W-B：共享页新建记忆域（零门槛；默认自订阅；0 条 / 0 对端也可用）
    // U-1 补充 2：共享页只管理记忆域，邀请设备只在顶栏。
    check('U-2 共享页头部：工具栏右上「新建记忆域」+ 空态一行 muted、无邀请/诊断',
      await evalJs(`(() => {
        const btn = document.querySelector('.audit-toolbar #namespace-new');
        const empty = document.querySelector('#domains-empty');
        const note = document.querySelector('#domains-note');
        return Boolean(btn) && /新建记忆域/.test(btn.textContent)
          && Boolean(empty) && empty.tagName === 'P' && /还没有记忆域/.test(empty.textContent)
          && /只有本机也可以新建记忆域并开始记录/.test(note?.textContent ?? '')
          && !document.querySelector('#domains-empty-new')
          && !document.querySelector('#domains-empty-invite')
          && !/邀请设备|诊断与恢复/.test(empty.textContent);
      })()`));
    await evalJs('document.querySelector("#namespace-new").click()');
    check('U-2 新建域弹窗：名称输入 + 创建并订阅（不用 window.prompt）',
      await waitFor('document.querySelector("#namespace-new-modal")?.hidden === false && Boolean(document.querySelector("#namespace-new-name"))'));
    await capture('u3-after-dialog-namespace.jpg');
    await evalJs(`(() => {
      document.querySelector('#namespace-new-name').value = 'ledger-ui';
      document.querySelector('#namespace-new-create').click();
    })()`);
    check('W-B 新建域默认自订阅 + 0 条目录可见',
      await waitFor(`(() => {
        const list = document.querySelector('#domains-list')?.textContent ?? '';
        const detail = document.querySelector('#domain-detail')?.textContent ?? '';
        const banner = document.querySelector('#banner')?.textContent ?? '';
        return /ledger-ui/.test(list) && /0 条/.test(list)
          && (/已订阅/.test(detail) || document.querySelector('#ns-subscribe')?.checked === true)
          && /已创建并订阅「ledger-ui」/.test(banner);
      })()`));

    // 选项卡切换（曾因误删 setView 失效）
    await evalJs('document.querySelector("#view-nav li:nth-of-type(2) button").click()');
    check('切换到域视图（#domains-view 可见）', await waitFor('document.querySelector("#domains-view")?.hidden === false'));
    check('U-1 共享页无「邀请设备」CTA（顶栏仍保留）',
      await evalJs('(() => { const v = document.querySelector("#domains-view"); return Boolean(v) && !/邀请设备/.test(v.textContent) && Boolean(document.querySelector("#invite-device")); })()'));
    await capture('u1-after-shared-list.jpg');
    await evalJs('document.querySelector("#view-nav li:nth-of-type(1) button").click()');
    check('切回星图视图', await waitFor('document.querySelector("#domains-view")?.hidden === true'));

    // G-ML-1：记忆生命周期视图（动作式：归档 / 解除归档 / 删除；默认过滤已删除与已归档）
    await evalJs('document.querySelector("#view-nav li:nth-of-type(3) button").click()');
    check('切换到记忆视图（#memories-view 可见）', await waitFor('document.querySelector("#memories-view")?.hidden === false'));
    check('记忆视图含过滤器 + 记忆行 + 归档/删除动作按钮',
      await waitFor('(() => { const v = document.querySelector("#memories-view"); return Boolean(v) && Boolean(v.querySelector("#mem-filter-archived")) && Boolean(v.querySelector("#mem-filter-deleted")) && v.querySelectorAll(".mem-row").length >= 1 && Boolean(v.querySelector("[data-mem-action=archive]")) && Boolean(v.querySelector("[data-mem-action=delete]")); })()'));
    check('记忆视图说明人话化（归档可逆不再出现在回忆；删除不可逆；无内部术语）',
      await evalJs('(() => { const t = document.querySelector("#memories-view")?.textContent ?? ""; return /归档/.test(t) && /不再出现在回忆/.test(t) && /不可逆/.test(t) && !/metadata/.test(t) && !/CSRF/.test(t) && !/scope/.test(t); })()'));
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
    // U-3 症状①：背板/设置框不滚，只有页签下的 .settings-scroll 滚动；页面滚动锁定
    check('U-3 设置壳：提示在标题下 + 仅内容区滚动 + 右上角 X + 滚动条贴边',
      await evalJs(`(() => {
        const modal = document.querySelector('#settings');
        const box = modal.querySelector('.modal-box');
        const scroller = modal.querySelector('.settings-scroll');
        const close = modal.querySelector('.modal-head #settings-close.modal-x');
        const m = getComputedStyle(modal);
        const b = getComputedStyle(box);
        const s = getComputedStyle(scroller);
        const securityFirst = modal.querySelector('#settings-panel-security .settings-section');
        const spacer = document.createElement('div');
        spacer.style.height = '900px';
        scroller.appendChild(spacer);
        scroller.scrollTop = 120;
        const out = {
          modalOverflow: m.overflowY,
          boxOverflow: b.overflowY,
          scrollOverflow: s.overflowY,
          noteInHead: Boolean(modal.querySelector('.modal-head .settings-apply-note')),
          scrollEdge: Math.abs(scroller.getBoundingClientRect().right - box.getBoundingClientRect().right) <= 1,
          securityTop: securityFirst ? getComputedStyle(securityFirst).borderTopWidth : 'missing',
          scrolled: scroller.scrollTop > 0,
          boxStill: box.scrollTop === 0,
          backdropStill: modal.scrollTop === 0,
          bodyLocked: document.body.classList.contains('modal-open'),
          hasX: Boolean(close) && !modal.querySelector('.modal-actions'),
        };
        spacer.remove();
        scroller.scrollTop = 0;
        return out.modalOverflow === 'hidden' && out.boxOverflow === 'hidden'
          && out.scrollOverflow === 'auto' && out.noteInHead && out.scrollEdge
          && out.securityTop === '0px'
          && out.scrolled && out.boxStill && out.backdropStill && out.bodyLocked && out.hasX;
      })()`));
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
    check('验证未过 = 黄态一行 + 「重新验证」+ 输出内联（无嵌套折叠）',
      await waitFor('(() => { const v = document.querySelector("#settings-panel-assistants [data-asst-verify=opencode]"); if (!v || !/验证未过/.test(v.textContent)) return false; if (!v.querySelector("[data-asst-output]")) return false; if (v.querySelector("details")) return false; const row = document.querySelector("#settings-panel-assistants [data-asst-row=opencode]"); return Boolean(row) && /重新验证/.test(row.textContent); })()', 20000));
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

    // 设置弹窗（E1 IA：常用/安全/AI 助手/MCP 接入/高级 + 关于本机）
    await evalJs('document.querySelector("#open-settings").click()');
    check('E1 设置弹窗打开（5 页签：常用 / 安全 / AI 助手 / MCP 接入 / 高级）', await waitFor(`(() => {
      const tabs = [...document.querySelectorAll('#settings-body .settings-tab:not(.settings-tab-extra)')].map((el) => el.textContent.trim());
      return tabs.join(',') === '常用,安全,AI 助手,MCP 接入,高级' && document.querySelector('#settings')?.hidden === false;
    })()`));
    await evalJs('document.querySelector("[data-settings-tab=common]").click()');
    check('E1 常用页：保留只读状态 + 重启向导；无重复邀请入口', await waitFor(`(() => {
      const common = document.querySelector('#settings-panel-common');
      const topbarInvite = document.querySelector('#invite-device');
      return Boolean(common) && common.hidden === false
        && !common.querySelector('.cfg-editor') && Boolean(common.querySelector('#settings-resident'))
        && Boolean(common.querySelector('[data-settings-common-status]'))
        && !common.querySelector('#settings-invite-device')
        && Boolean(topbarInvite)
        && /高级/.test(common.textContent);
    })()`));
    const foldAudit = await evalJs(`(() => {
      const details = [...document.querySelectorAll('#settings-body details')];
      return { count: details.length, keys: details.map((d) => d.dataset.settingsFold ?? d.className) };
    })()`);
    check('U1 设置折叠预算：≤5 且均为允许类型（邀请无折叠）', Boolean(foldAudit) && foldAudit.count <= 5
      && foldAudit.keys.every((key) => ['mcp-danger', 'diagnostics', 'about-runtime', 'assistants'].includes(key)),
      JSON.stringify(foldAudit));
    check('U-1 设置无退役配置项/引导签发者/授权·签发·参与',
      await evalJs(`(() => {
        const body = document.querySelector('#settings-body');
        const t = body?.textContent ?? '';
        const paths = ['sync.peer' + 'Whitelist', 'sync.' + ['policy', 'Issuers'].join(''), 'sync.' + 'auto' + 'Grant', 'status.invite.' + 'grant' + 'Ttl'];
        const words = ['peer' + 'Whitelist', ['policy', 'Issuers'].join(''), 'auto' + 'Grant', 'grant' + 'Ttl', '引导签发者', '授权', '签发', '参与'];
        return Boolean(body)
          && paths.every((path) => !body.querySelector('[data-cfg-path="' + path + '"]'))
          && !new RegExp(words.join('|')).test(t);
      })()`));
    await capture('u1-after-settings-common.jpg');
    await capture('u1-after-settings-common-390.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

    // E2-A2 · 忆云卡（设置 · 常用）：每行名字/当前|已归档/根指纹/最近使用/动作；当前不可切换
    check('E2-A2 忆云卡：两行（当前 + 已归档）+ 根指纹/最近使用；当前项无切换；无删除入口',
      await waitFor(`(() => {
        const card = document.querySelector('#settings-cloud-card');
        if (!card) return false;
        const current = card.querySelector('[data-cloud-row=default]');
        const archived = card.querySelector('[data-cloud-row=p_demo0001]');
        const common = document.querySelector('#settings-panel-common');
        return Boolean(current) && Boolean(archived)
          && /忆云 1/.test(current.textContent) && /当前/.test(current.textContent)
          && /忆云 2/.test(archived.textContent) && /已归档/.test(archived.textContent)
          && /sha256:[0-9a-f]{12}/.test(current.textContent) && /最近使用/.test(current.textContent)
          && !current.querySelector('[data-cloud-switch]')
          && Boolean(archived.querySelector('[data-cloud-switch]')) && Boolean(archived.querySelector('[data-cloud-rename]'))
          && !card.querySelector('[data-cloud-delete]') && !/删除忆云/.test(card.textContent)
          && /归档保留，不删除/.test(card.textContent)
          && Boolean(common) && common.contains(card)
          && Boolean(common.querySelector('[data-settings-common-status]'))
          && (common.querySelector('[data-settings-common-status]').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      })()`));
    await capture('e2a2-after-settings-clouds.jpg');

    // 改名即时生效（不重启）：当前忆云 忆云 1 → 工作室；顶栏徽章同步；守护进程仍存活
    await evalJs('document.querySelector("[data-cloud-rename=default]").click()');
    check('E2-A2 改名：行内编辑输入就位', await waitFor('Boolean(document.querySelector("[data-cloud-rename-input]"))'));
    await evalJs(`(() => {
      const input = document.querySelector('[data-cloud-rename-input]');
      input.value = '工作室';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-cloud-rename-save]').click();
    })()`);
    check('E2-A2 改名即时生效：卡片与顶栏徽章同步为「工作室」',
      await waitFor('(() => { const card = document.querySelector("#settings-cloud-card"); const badge = document.querySelector("#cloud-badge"); return Boolean(card) && /工作室/.test(card.textContent) && /工作室/.test(badge?.textContent ?? ""); })()', 20000));
    check('E2-A2 改名不重启守护（进程仍存活）', handle.proc.exitCode === null && handle.proc.signalCode === null);
    // 改回默认名（避免影响后续邀请/指纹用例）
    await evalJs('document.querySelector("[data-cloud-rename=default]").click()');
    await waitFor('Boolean(document.querySelector("[data-cloud-rename-input]"))');
    await evalJs(`(() => {
      const input = document.querySelector('[data-cloud-rename-input]');
      input.value = '忆云 1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-cloud-rename-save]').click();
    })()`);
    check('E2-A2 改名可改回（忆云 1）',
      await waitFor('(() => { const card = document.querySelector("#settings-cloud-card"); return Boolean(card) && /忆云 1/.test(card.textContent); })()', 20000));

    // U-1：CSRF 403 自愈——旧 token + 错误 cookie → 重取 /console/ → 原表单内容自动重试一次
    await evalJs('document.querySelector("[data-cloud-rename=default]").click()');
    await waitFor('Boolean(document.querySelector("[data-cloud-rename-input]"))');
    await evalJs(`(() => {
      const input = document.querySelector('[data-cloud-rename-input]');
      input.value = '自愈工作区';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__u1NoReload = 'yes';
      window.__u1FetchCalls = [];
      const orig = window.fetch.bind(window);
      window.__u1OrigFetch = orig;
      window.fetch = (...args) => {
        window.__u1FetchCalls.push(String(args[0]));
        return orig(...args);
      };
      document.cookie = 'mebular_csrf=stale-u1-token; Path=/';
      document.querySelector('[data-cloud-rename-save]').click();
    })()`);
    check('U-1 CSRF 403 自愈：旧 token 自动恢复并成功保存表单内容',
      await waitFor('(() => { const card = document.querySelector("#settings-cloud-card"); return Boolean(card) && /自愈工作区/.test(card.textContent); })()', 20000));
    const csrfRecovery = await evalJs(`(() => {
      const calls = window.__u1FetchCalls ?? [];
      return {
        consoleRefresh: calls.filter((path) => path === '/console/').length,
        renameAttempts: calls.filter((path) => path === '/admin/api/clouds/rename').length,
        noReload: window.__u1NoReload === 'yes',
      };
    })()`);
    check('U-1 CSRF 自愈：只重取一次 token、只重试一次写、页面不重载（表单不丢）',
      Boolean(csrfRecovery) && csrfRecovery.consoleRefresh === 1 && csrfRecovery.renameAttempts === 2 && csrfRecovery.noReload === true,
      JSON.stringify(csrfRecovery));
    await evalJs('window.fetch = window.__u1OrigFetch; delete window.__u1OrigFetch;');
    await evalJs('document.querySelector("[data-cloud-rename=default]").click()');
    await waitFor('Boolean(document.querySelector("[data-cloud-rename-input]"))');
    await evalJs(`(() => {
      const input = document.querySelector('[data-cloud-rename-input]');
      input.value = '忆云 1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-cloud-rename-save]').click();
    })()`);
    await waitFor('(() => { const card = document.querySelector("#settings-cloud-card"); return Boolean(card) && /忆云 1/.test(card.textContent); })()', 20000);

    // 已归档切换：危险确认 → 无 App 桥时给 CLI 兜底（当前忆云不变）
    await evalJs('document.querySelector("[data-cloud-row=p_demo0001] [data-cloud-switch]").click()');
    check('E2-A2 已归档切换：危险确认（说明归档保留、不删除）',
      await waitFor('document.querySelector("#modal")?.hidden === false && /归档保留，不删除/.test(document.querySelector("#modal")?.textContent ?? "")'));
    await evalJs('document.querySelector("#modal-confirm").click()');
    check('E2-A2 无 App 桥兜底：显示 mebular cloud use p_demo0001 + 复制；当前仍是忆云 1',
      await waitFor(`(() => {
        const body = document.querySelector('#cloud-switch-body');
        return document.querySelector('#cloud-switch')?.hidden === false
          && /mebular cloud use p_demo0001/.test(body?.textContent ?? '')
          && Boolean(body?.querySelector('[data-copy]'))
          && /忆云 1/.test(document.querySelector('#cloud-badge')?.textContent ?? '');
      })()`));
    await capture('e2a2-after-cloud-switch-fallback.jpg');
    await evalJs('document.querySelector("#cloud-switch-close").click()');

    // 高级页：3 组（常驻服务/网络/自动化）+ 诊断折叠；MCP 六项独立 tab
    await evalJs('document.querySelector("[data-settings-tab=advanced]").click()');
    check('U-3 高级页：三组就位（常驻服务/网络/自动化），MCP 字段不再混入',
      await waitFor(`(() => {
        const p = document.querySelector('#settings-panel-advanced');
        const sections = [...(p?.querySelectorAll(':scope > .settings-section') ?? [])];
        const ids = sections.map((s) => s.dataset.settingsSection).join(',');
        return Boolean(p) && ids === 'resident,network,automation'
          && sections.every((s) => Boolean(s.querySelector('h3')) && Boolean(s.querySelector('.settings-section-desc')))
          && Boolean(p.querySelector('[data-cfg-path="joinService.enabled"]'))
          && Boolean(p.querySelector('[data-cfg-path="network.enabled"]'))
          && Boolean(p.querySelector('[data-cfg-path="sync.antiEntropy.enabled"]'))
          && !p.querySelector('[data-task]') && !p.querySelector('[data-cfg-path="mcp.http.host"]')
          && !p.querySelector('[data-cfg-path="sync.peerWhitelist"]');
      })()`));
    const advancedText = await evalJs(`(() => {
      const p = document.querySelector('#settings-panel-advanced');
      const clone = p.cloneNode(true);
      clone.querySelector('#diag-fold')?.remove();
      const text = (clone.textContent ?? '').replace(/\\s+/g, '');
      return { ok: text.length <= 1200, length: text.length };
    })()`);
    check('U-3 高级主区文本 ≤1200 字（不含诊断折叠）', advancedText.ok, `${advancedText.length} 字`);
    await capture('u3-after-settings-advanced.jpg');
    await capture('u3-after-settings-advanced-390.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evalJs('document.querySelector("#diag-fold").open = true; document.querySelector("#diag-fold").scrollIntoView({ block: "start" })');
    await capture('u3-after-settings-advanced-diagnostics.jpg');
    await evalJs('document.querySelector("#diag-fold").open = false');
    check('E1 诊断 · 手动连接：入口在诊断折叠内（文案=传输修复）',
      await evalJs(`(() => {
        const fold = document.querySelector('#diag-fold');
        if (fold) fold.open = true;
        const btn = document.querySelector('#diag-open-wizard');
        return Boolean(btn) && /手动连接/.test(btn.textContent) && /不改变入网信任|不改动入网信任/.test(fold?.textContent ?? '');
      })()`));
    await evalJs('document.querySelector("[data-settings-tab=mcp]").click()');
    check('U-3 MCP 接入：连接/TLS 两组 + 一个「危险与自救」折叠；六字段齐全',
      await waitFor(`(() => {
        const p = document.querySelector('#settings-panel-mcp');
        const sections = [...(p?.querySelectorAll(':scope > .settings-section') ?? [])];
        const ids = sections.map((s) => s.dataset.settingsSection).join(',');
        const paths = ['mcp.http.port', 'mcp.http.auth', 'mcp.http.host', 'mcp.http.tls', 'mcp.http.tlsKey', 'mcp.http.tlsCert'];
        return Boolean(p) && ids === 'connection,tls'
          && paths.every((path) => Boolean(p.querySelector('[data-cfg-path="' + path + '"]')))
          && !p.querySelector('.settings-danger') && !p.querySelector('[data-task]')
          && /token grant|config\\.json/.test(p.querySelector('#mcp-danger-fold')?.textContent ?? '')
          && /bearer/.test(p.querySelector('#mcp-danger-fold')?.textContent ?? '');
      })()`));
    const mcpText = await evalJs(`(() => {
      const p = document.querySelector('#settings-panel-mcp');
      const clone = p.cloneNode(true);
      clone.querySelector('#mcp-danger-fold')?.remove();
      const text = (clone.textContent ?? '').replace(/\\s+/g, '');
      return { ok: text.length <= 700, length: text.length };
    })()`);
    check('U-3 MCP 主区文本 ≤700 字（不含危险折叠）', mcpText.ok, `${mcpText.length} 字`);
    check('U-3 MCP 字段帮助一行化（每条 ≤36 字）',
      await evalJs(`(() => {
        const helps = [...document.querySelectorAll('#settings-panel-mcp .cfg-help')].map((el) => el.textContent.trim()).filter(Boolean);
        return helps.length >= 3 && helps.every((text) => text.replace(/\\s+/g, '').length <= 36);
      })()`));
    await evalJs('document.querySelector("#mcp-danger-fold").open = true');
    await capture('u3-after-settings-mcp-danger.jpg');
    await evalJs('document.querySelector("#mcp-danger-fold").open = false');
    await capture('u3-after-settings-mcp.jpg');
    await capture('u3-after-settings-mcp-390.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(250);
    check('U-1 390px 设置（MCP 危险项 + 内联帮助）无横向溢出',
      await evalJs('(() => { const box = document.querySelector("#settings .modal-box"); const b = document.body; return Boolean(box) && box.scrollWidth <= box.clientWidth + 1 && b.scrollWidth <= b.clientWidth + 1; })()'));
    await send('Emulation.clearDeviceMetricsOverride');

    // 轮询重建回归（修复前：render() 每 3s 整体重建 #settings-body → 原生 <select> 弹层被销毁、选择丢失）
    const authSelector = '#settings-body select[data-cfg-path="mcp.http.auth"]';
    check('设置内存在 auth 下拉（MCP 接入 tab）', await waitFor(`Boolean(document.querySelector('${authSelector}'))`));
    await evalJs(`window.__settingsProbe = document.querySelector('#settings-body .settings-tabs'); window.__authProbe = document.querySelector('${authSelector}');`);
    await sleep(3600);
    check('跨 3s 轮询设置容器节点引用不变（DOM 未重建）', await evalJs('Boolean(window.__settingsProbe) && window.__settingsProbe === document.querySelector("#settings-body .settings-tabs")'));
    check('跨 3s 轮询 auth 下拉节点引用不变', await evalJs(`Boolean(window.__authProbe) && window.__authProbe === document.querySelector('${authSelector}')`));

    // E1 · 设置分层：5 tab；诊断并入高级；订阅域移出；反熵细节不出屏；无「保存」按钮
    check('E1 设置 5 页签（常用/安全/AI 助手/MCP 接入/高级）且无诊断页签/保存按钮',
      await evalJs('document.querySelectorAll("#settings-body .settings-tab:not(.settings-tab-extra)").length === 5 && !document.querySelector("#settings-panel-diagnostics") && !document.querySelector("[data-cfg-action=save]")'));
    check('简化轮：订阅域与反熵细节不出设置页（grep 断言面）',
      await evalJs(`(() => { const body = document.querySelector("#settings-body"); return !body.querySelector('[data-cfg-path="sync.namespaces"]') && !body.querySelector('[data-cfg-path="sync.antiEntropy.intervalMs"]') && !body.querySelector('[data-cfg-path="sync.antiEntropy.jitterRatio"]') && !body.querySelector('[data-cfg-path="sync.snapshotThreshold"]') && !body.querySelector('[data-cfg-path="semantic.minScore"]') && Boolean(body.querySelector('[data-cfg-path="sync.antiEntropy.enabled"]')); })()`));
    check('简化轮：诊断并入高级底部折叠（cfg-copy-all 就位）',
      await evalJs('(() => { document.querySelector("[data-settings-tab=advanced]")?.click(); const f = document.querySelector("#diag-fold"); return Boolean(f) && Boolean(f.querySelector("#cfg-copy-all")); })()'));
    await evalJs('document.querySelector("[data-settings-tab=mcp]").click()');
    // 轮 C 症状③：常态不占行；异常才完整三元组；帮助聚焦出现；空值提示进 placeholder
    check('轮 C 呈现分级：常态不占行，异常自动出现完整三元组',
      await evalJs(`(() => {
        const body = document.querySelector('#settings-body');
        const ok = body.querySelectorAll('[data-cfg-state=ok]').length;
        // 专指 mcp.http.port 的「已配置 0 / 实际 <port>」例外：避免被 join 端点回环等其它异常行抢先
        const row = body.querySelector('[data-cfg-path="mcp.http.port"]')?.closest('.cfg-row');
        const ex = row?.querySelector('[data-cfg-state=exception]');
        return ok === 0 && !/生效中/.test(body.textContent)
          && Boolean(ex) && /已配置/.test(ex.textContent) && /实际/.test(ex.textContent) && /不一致/.test(ex.textContent);
      })()`));
    check('U-1 呈现分级：帮助聚焦时出现、空值默认/短提示进 placeholder',
      await evalJs(`(() => {
        const panel = document.querySelector('#settings-panel-mcp');
        const row = panel?.querySelector('.cfg-row');
        const help = row?.querySelector('.cfg-control > .cfg-help');
        const input = row?.querySelector('input, select');
        if (!help || !input) return false;
        const hidden = getComputedStyle(help).display === 'none';
        input.focus();
        const shown = getComputedStyle(help).display !== 'none';
        input.blur();
        const cert = panel.querySelector('[data-cfg-path="mcp.http.tlsCert"]');
        return hidden && shown && Boolean(cert) && /cert\\.pem/.test(cert.placeholder)
          && !panel.querySelector('details.cfg-more') && !/这是什么/.test(panel.textContent);
      })()`));
    await evalJs('document.querySelector("[data-settings-tab=security]").click()');
    check('U-3 安全 tab：三段式（等级/动态码种子/恢复码）+ 当前档 + 短边界',
      await evalJs(`(() => {
        const panel = document.querySelector('#settings-panel-security');
        const s = document.querySelector('#settings-security-slot');
        if (!panel || panel.hidden || !s || s.hidden) return false;
        const sections = [...s.querySelectorAll(':scope > .settings-section')];
        const t = s.textContent;
        return s.dataset.settingsSlot === 'security'
          && sections.map((el) => el.dataset.settingsSection).join(',') === 'security-level,security-totp,security-recovery'
          && /安全等级/.test(t) && /低（默认）/.test(t) && /中 · 动态码/.test(t) && /高 · 设备会签/.test(t)
          && /防顺手/.test(t) && /挡手不挡钥匙/.test(t)
          && Boolean(s.querySelector('[data-security-current]')) && /当前/.test(s.querySelector('[data-security-current]').textContent)
          && Boolean(s.querySelector('[data-security-tier=low].is-current'))
          && !/totp_not_configured/.test(t);
      })()`));

    // 即时生效：改低风险 toggle（joinService.enabled；高级 · 常驻服务组）→ 无草稿态、3s 跨轮询值持久（已写入）
    await evalJs('document.querySelector("[data-settings-tab=advanced]").click()');
    const toggleSel = '#settings-body input[data-cfg-path="joinService.enabled"]';
    check('即时生效：joinService 开关在高级 · 常驻服务组', await waitFor(`Boolean(document.querySelector('${toggleSel}'))`));
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
    // 轮 C：Esc = 取消（绝不等于确认）；危险语义保持
    await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    check('轮 C 确认弹层：Esc = 取消（不写盘）', await waitFor('document.querySelector("#modal")?.hidden === true'));
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

    // E2-A2 · 加入忆云弹层：预填名字、当前忆云提示、坏令牌可读错误、当前忆云不变
    await evalJs('document.querySelector("#join-cloud").click()');
    const joinModalOk = await waitFor(`(() => {
        const modal = document.querySelector('#cloud-join');
        return Boolean(modal) && modal.hidden === false
          && document.querySelector('#cloud-join-name')?.value === '忆云 3'
          && /当前忆云(?:仍是)?「忆云 1」/.test(document.querySelector('#cloud-join-warning')?.textContent ?? '')
          && /归档保留，不删除/.test(modal.textContent);
      })()`);
    if (!joinModalOk) {
      const diag = await evalJs(`(() => {
        const modal = document.querySelector('#cloud-join');
        return {
          hidden: modal?.hidden,
          name: document.querySelector('#cloud-join-name')?.value,
          warning: document.querySelector('#cloud-join-warning')?.textContent,
          modalText: (modal?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 500),
          badge: document.querySelector('#cloud-badge')?.textContent,
          rows: document.querySelectorAll('[data-cloud-row]').length,
        };
      })()`);
      console.log('  [diag] E2-A2 join modal:', JSON.stringify(diag));
    }
    check('E2-A2 加入弹层：名字预填「忆云 3」+ 当前忆云归档提示 + 终端兜底文案', joinModalOk);
    await capture('e2a2-after-cloud-join-modal.jpg');
    await capture('u3-after-dialog-cloud-join.jpg');
    await evalJs(`(() => {
      document.querySelector('#cloud-join-token').value = 'not-a-join-token';
      document.querySelector('#cloud-join-token').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#cloud-join-submit').click();
    })()`);
    check('E2-A2 坏令牌：可读错误（令牌格式不对）+ 令牌输入保留 + 当前忆云不变',
      await waitFor(`(() => {
        const err = document.querySelector('#cloud-join-error');
        return err && err.hidden === false && /令牌格式不对/.test(err.textContent)
          && document.querySelector('#cloud-join-token')?.value === 'not-a-join-token'
          && /忆云 1/.test(document.querySelector('#cloud-badge')?.textContent ?? '');
      })()`));
    await evalJs('document.querySelector("#cloud-join-close").click()');
    check('E2-A2 加入弹层可关闭且清空令牌', await waitFor('document.querySelector("#cloud-join")?.hidden === true && document.querySelector("#cloud-join-token")?.value === ""'));

    // E2-A2 · 深链：?view=settings&focus=clouds 直接打开常用并聚焦忆云卡
    await send('Page.navigate', { url: `${base}/console/?view=settings&focus=clouds` });
    check('E2-A2 深链 focus=clouds：设置常用打开并聚焦忆云卡',
      await waitFor('document.querySelector("#settings")?.hidden === false && document.querySelector("#settings-panel-common")?.hidden === false && document.activeElement?.id === "settings-cloud-card"', 20000));
    await evalJs('document.querySelector("#settings-close").click()');

    // E2-A2 · 重复加入：用当前忆云的邀请令牌 → CLOUD_ALREADY_JOINED → 已有忆云 + 切换入口
    await evalJs('document.querySelector("#invite-device").click()');
    check('E2-A2 准备重复加入用的邀请令牌', await waitFor('Boolean(document.querySelector("#invite-body [data-copy]")?.dataset.copy)', 20000));
    const duplicateToken = await evalJs('document.querySelector("#invite-body [data-copy]")?.dataset.copy ?? ""');
    await evalJs('document.querySelector("#invite-close").click()');
    await evalJs('document.querySelector("#join-cloud").click()');
    await evalJs(`(() => {
      document.querySelector('#cloud-join-token').value = ${JSON.stringify(duplicateToken)};
      document.querySelector('#cloud-join-token').dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    check('E2-A2 重复加入：识别已加入「忆云 1」+ 主按钮变切换入口，不创建重复项',
      await waitFor(`(() => {
        const box = document.querySelector('#cloud-join-inspect');
        return /这台设备已加入「忆云 1」/.test(box?.textContent ?? '')
          && /切换到「忆云 1」/.test(document.querySelector('#cloud-join-submit')?.textContent ?? '');
      })()`, 20000));
    await evalJs('document.querySelector("#cloud-join-close").click()');

    // 轮 C 症状②：Esc 只关最上层；点空白关闭；设置/关于叠加时顺序正确
    await evalJs('document.querySelector("#open-settings").click()');
    await waitFor('document.querySelector("#settings")?.hidden === false');
    await evalJs('document.querySelector("#self-badge").click()');
    await waitFor('document.querySelector("#about")?.hidden === false');
    await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    check('轮 C 弹层关闭：Esc 只关最上层（关于关、设置留）',
      await evalJs('document.querySelector("#about")?.hidden === true && document.querySelector("#settings")?.hidden === false'));
    await evalJs(`(() => {
      const el = document.querySelector('#settings');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    check('轮 C 弹层关闭：点空白（backdrop target===currentTarget）关闭设置',
      await waitFor('document.querySelector("#settings")?.hidden === true && !document.body.classList.contains("modal-open")'));
    // 关于本机（点顶栏本机徽标进入）
    await evalJs('document.querySelector("#self-badge").click()');
    check('关于本机打开（身份/存储/收敛；运行状态收一个折叠）', await waitFor(`(() => {
      const body = document.querySelector('#about-body');
      const folds = body?.querySelectorAll('details') ?? [];
      return Boolean(body) && Boolean(body.querySelector('[data-info-block=identity]'))
        && Boolean(body.querySelector('[data-info-block=convergence]'))
        && folds.length === 1 && folds[0].dataset.settingsFold === 'about-runtime'
        && body.textContent.includes('运行状态');
    })()`));
    check('轮 C 配套：写盘路径/.bak 收进关于本机、设置常用页不再重复',
      await evalJs('(() => { const t = document.querySelector("#about-body")?.textContent ?? ""; const s = document.querySelector("#settings-body")?.textContent ?? ""; return /配置文件/.test(t) && /\\.bak/.test(t) && !/修改写入/.test(s); })()'));
    check('U-1 关于本机无引导签发者/授权/签发/参与残留',
      await evalJs('(() => { const t = document.querySelector("#about-body")?.textContent ?? ""; return !/引导签发者|授权|签发|参与/.test(t); })()'));
    await capture('u1-after-about.jpg');
    await evalJs('document.querySelector("#about-close").click()');

    // UX-2：?view=connect 别名重定向 → 设置 · AI 助手自动打开
    await send('Page.navigate', { url: `${base}/console/?view=connect` });
    check('别名重定向：?view=connect → 设置 · AI 助手自动打开',
      await waitFor('document.querySelector("#settings")?.hidden === false && document.querySelector("#settings-panel-assistants")?.hidden === false'));
    await evalJs('document.querySelector("#settings-close").click()');
    // 邀请面板（joinService 未启用 → 就地启用；启用 → 令牌。两者都应有内容）
    await evalJs('document.querySelector("#invite-device").click()');
    check('邀请面板打开且渲染内容（令牌或未启用提示）', await waitFor('(() => { const b = document.querySelector("#invite-body"); return Boolean(b?.querySelector("[data-copy]")) || /加入服务未启用/.test(b?.textContent ?? ""); })()'));
    await capture('u3-after-dialog-invite.jpg');
    check('E1 邀请单屏：令牌 + 二维码/降级 + 忆云身份 + TTL；无详情/端点编辑/CLI 命令', await evalJs(`(() => {
      const body = document.querySelector('#invite-body');
      if (!body) return false;
      const ttl = document.querySelector('#invite-ttl');
      const options = ttl ? [...ttl.options].map((o) => [o.value, o.textContent]) : [];
      const expected = [['300000','5 分钟'],['900000','15 分钟'],['1200000','20 分钟'],['7200000','2 小时'],['21600000','6 小时'],['43200000','12 小时'],['86400000','24 小时']];
      const tokenBlock = Boolean(body.querySelector('.invite-token-block [data-copy]'));
      const qr = Boolean(body.querySelector('.qr-img')) || /二维码不可用/.test(body.textContent);
      return body.querySelectorAll('details').length === 0
        && !body.querySelector('#invite-endpoint') && !/fleet join/.test(body.textContent)
        && !/join 端点|默认记忆域|订阅/.test(body.textContent)
        && tokenBlock && qr && /本忆云/.test(body.textContent) && /根指纹/.test(body.textContent)
        && Boolean(ttl) && ttl.value === '900000' && JSON.stringify(options) === JSON.stringify(expected)
        && Boolean(document.querySelector('#invite-regenerate'));
    })()`));
    const beforeTtlToken = await evalJs('document.querySelector("#invite-body [data-copy]")?.dataset.copy ?? ""');
    await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      select.value = '7200000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      window.confirm = () => true;
      document.querySelector('#invite-regenerate').click();
    })()`);
    check('E1 重新生成：选中 2 小时后新令牌，选择保持（ttlMs 透传生效）',
      await waitFor(`(() => {
        const select = document.querySelector('#invite-ttl');
        const token = document.querySelector('#invite-body [data-copy]')?.dataset.copy ?? '';
        return select?.value === '7200000' && token.length > 0 && token !== ${JSON.stringify(beforeTtlToken)};
      })()`, 20000));
    const allFoldKeys = await evalJs(`(() => [...document.querySelectorAll('#settings-body details, #about-body details, #invite-body details')]
      .map((el) => el.dataset.settingsFold ?? el.className))()`);
    check('U-1 全域折叠预算：设置 + 关于 ≤5 且均为白名单类型（邀请无折叠）', Array.isArray(allFoldKeys)
      && allFoldKeys.length <= 5
      && allFoldKeys.every((key) => ['mcp-danger', 'diagnostics', 'about-runtime', 'assistants'].includes(key)),
      JSON.stringify(allFoldKeys));
    check('E1 邀请面板无「去设置启用」旧指路（未启用时就地一键启用）',
      await evalJs(`(() => {
        const html = document.querySelector('#invite')?.outerHTML ?? '';
        return !/去设置启用/.test(html) && !/设置 → 常用/.test(html);
      })()`));
    check('E2-A2 邀请单屏：本忆云名 + 根指纹 + 「加入忆云」指路（取 overview.cloud）',
      await evalJs(`(() => {
        const line = document.querySelector('#invite-cloud-identity');
        const body = document.querySelector('#invite-body')?.textContent ?? '';
        return Boolean(line) && /本忆云：忆云 1/.test(line.textContent)
          && /sha256:[0-9a-f]{12}/.test(line.textContent)
          && /让 TA 在控制台点「加入忆云」粘贴此令牌/.test(body);
      })()`));
    await capture('e2a2-after-invite-cloud-line.jpg');
    await capture('e1-after-invite-single-screen.jpg');
    check('E1 邀请卡：详情/端点/命令/默认域与订阅说明不再出现',
      await evalJs('(() => { const t = document.querySelector("#invite-body")?.textContent ?? ""; return !/join 端点|默认记忆域|新设备.*fleet join|订阅/.test(t) && /有效期/.test(t) && /重新生成/.test(t); })()'));
    await evalJs('document.querySelector("#invite-close").click()');

    // ---------- S3 · 安全三档（活体：真实端点；先红后绿） ----------
    const { totpFingerprint, totpCodeAt, generateRecoveryCode } = await import('@mebular/fleet');
    const SEC_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    check('S3 活体：顶栏只读徽章显示「🛡 安全：低」',
      await waitFor('(() => { const b = document.querySelector("#security-badge"); return Boolean(b) && /🛡 安全：低/.test(b.textContent); })()'));
    // 低档：移出仍是「更多操作」折叠内的次级动作
    await send('Page.navigate', { url: `${base}/console/?select=device-C` });
    check('S3 低档移出布局：移出留在「更多操作」折叠内（防误触）',
      await waitFor(`(() => {
        const b = document.querySelector('#device-card-body');
        if (!b || b.hidden) return false;
        const adv = b.querySelector('.card-advanced');
        const btn = b.querySelector('[data-action=revoke-device]');
        const main = b.querySelector(':scope > .card-actions');
        return Boolean(adv) && Boolean(btn) && adv.contains(btn) && !(main?.contains(btn));
      })()`));
    check('E1 设备卡「连不上」语境：手动连接入口可见（传输修复）',
      await evalJs(`(() => {
        const b = document.querySelector('#device-card-body');
        const manual = b?.querySelector('[data-action=manual-connect]');
        return Boolean(manual) && /连不上|手动连接/.test(manual.textContent);
      })()`));
    await send('Page.navigate', { url: `${base}/console/` });
    await waitFor('document.querySelector("#memory-badge") && !/…/.test(document.querySelector("#memory-badge").textContent)');
    await evalJs('document.querySelector("#open-settings").click()');
    await waitFor('document.querySelector("#settings")?.hidden === false');
    await evalJs('document.querySelector("[data-settings-tab=security]").click()');

    // 批准侧：种子请求（他机发起）→ 配对号核对 → 批准/拒绝写入
    check('S3 批准侧：安全卡顶部待批准入口 + 配对号 aria-live',
      await waitFor(`(() => {
        const s = document.querySelector('#settings-security-slot');
        const rows = s?.querySelectorAll('[data-security-approve]') ?? [];
        const pair = s?.querySelector('[data-security-pairing]');
        return rows.length >= 2 && Boolean(pair) && pair.getAttribute('aria-live') === 'polite' && /^\\d{3}-\\d{3}$/.test(pair.textContent.trim());
      })()`));
    await evalJs('document.querySelector("#settings-security-slot [data-security-approve]").click()');
    check('S3 批准：确认卡展示配对号与「配对号一致，批准」',
      await waitFor('document.querySelector("#modal")?.hidden === false && /配对号一致，批准/.test(document.querySelector("#modal-confirm")?.textContent ?? "")'));
    await evalJs('document.querySelector("#modal-confirm").click()');
    check('S3 批准写入生效（待批准行减少）',
      await waitFor('document.querySelectorAll("#settings-security-slot [data-security-approve]").length === 1', 20000));
    await evalJs('document.querySelector("#settings-security-slot [data-security-deny]").click()');
    check('S3 拒绝：确认卡出现（拒绝写入前二次确认）',
      await waitFor('document.querySelector("#modal")?.hidden === false && /拒绝/.test(document.querySelector("#modal-confirm")?.textContent ?? "")'));
    await evalJs('document.querySelector("#modal-confirm").click()');
    check('S3 拒绝写入生效（待批准清零；发起侧可见「已被拒绝」）',
      await waitFor('document.querySelectorAll("#settings-security-slot [data-security-approve]").length === 0', 20000));

    // 中档动态码：导入 → 卡片显示 fingerprint；未导入时用一句人话说明
    check('U-3 动态码未导入：提示会拒绝敏感动作，不显示内部错误码',
      await waitFor('(() => { const s = document.querySelector("#settings-security-slot"); return Boolean(s) && /未导入/.test(s.textContent) && /中档敏感操作会被拒绝/.test(s.textContent) && !/totp_not_configured/.test(s.textContent); })()'));
    const securityText = await evalJs(`(() => {
      const s = document.querySelector('#settings-panel-security');
      const text = (s.textContent ?? '').replace(/\\s+/g, '');
      return { ok: text.length <= 350, length: text.length };
    })()`);
    check('U-3 安全 tab 文本 ≤350 字（待批准已清零）', securityText.ok, `${securityText.length} 字`);
    await capture('u3-after-settings-security.jpg');
    await capture('u3-after-settings-security-390.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const overflowTabs = [];
    for (const tab of ['security', 'mcp', 'advanced']) {
      await evalJs(`document.querySelector("[data-settings-tab=${tab}]").click()`);
      await sleep(200);
      const ok = await evalJs('(() => { const box = document.querySelector("#settings .modal-box"); const b = document.body; return Boolean(box) && box.scrollWidth <= box.clientWidth + 1 && b.scrollWidth <= b.clientWidth + 1; })()');
      if (!ok) overflowTabs.push(tab);
    }
    check('U-3 390px：安全 / MCP / 高级均无横向溢出', overflowTabs.length === 0, overflowTabs.join(',') || 'ok');
    await send('Emulation.clearDeviceMetricsOverride');
    await evalJs('document.querySelector("[data-settings-tab=security]").click()');

    // 低→中（显式确认）→ 未导入种子进入星图「需要注意」→ 导入 → 异常退场
    await evalJs('document.querySelector("#settings-security-slot [data-security-action=upgrade][data-level=medium]").click()');
    await waitFor('document.querySelector("#modal")?.hidden === false');
    await capture('u3-after-settings-security-dialog.jpg');
    await evalJs('document.querySelector("#modal-confirm").click()');
    check('S3 低→中：安全卡当前档与顶栏徽章同步',
      await waitFor('document.querySelector("#settings-security-slot")?.dataset.securityLevel === "medium" && /🛡 安全：中/.test(document.querySelector("#security-badge")?.textContent ?? "")', 20000));
    check('S3 中档未导入种子 → 星图「需要注意」抬显',
      await waitFor('document.querySelector("#attention-card")?.textContent.includes("动态码种子未导入")', 20000));
    await evalJs('document.querySelector("#settings-security-slot [data-security-action=totp-import]").click()');
    check('S3 导入种子弹层（粘贴分组文本 / otpauth）', await waitFor('Boolean(document.querySelector("#security-totp-secret"))'));
    await evalJs(`(() => { document.querySelector('#security-totp-secret').value = ${JSON.stringify(SEC_TOTP_SECRET)}; document.querySelector('#security-action-confirm').click(); })()`);
    const totpImportOk = await waitFor(`(() => { const s = document.querySelector('#settings-security-slot'); return Boolean(s) && /已导入/.test(s.textContent) && s.textContent.includes(${JSON.stringify(totpFingerprint(SEC_TOTP_SECRET))}) && !document.querySelector('#attention-card')?.textContent.includes('动态码种子未导入'); })()`, 20000);
    check('S3 导入成功：安全卡显示已导入 + fingerprint；注意项退场', totpImportOk);
    if (!totpImportOk) {
      const diag = await evalJs(`(async () => {
        const slot = document.querySelector('#settings-security-slot');
        const attention = document.querySelector('#attention-card');
        const banner = document.querySelector('#banner');
        let security = null;
        try { security = await fetch('/admin/api/security').then((r) => r.json()); } catch (e) { security = { error: String(e) }; }
        return JSON.stringify({
          slot: slot?.textContent ?? null,
          slotLevel: slot?.dataset.securityLevel ?? null,
          attention: attention?.textContent ?? null,
          banner: banner?.textContent ?? null,
          security,
        });
      })()`);
      console.log('  · [诊断] S3 导入:', diag);
    }

    // 中档邀请要码 → 中档移出提级
    await evalJs('document.querySelector("#invite-device").click()');
    check('S3 中档邀请改道：先输入 6 位动态码（不直接签发令牌）',
      await waitFor('Boolean(document.querySelector("#security-code")) && document.querySelector("#invite")?.hidden === true'));
    const mediumCode = totpCodeAt(SEC_TOTP_SECRET, Math.floor(Date.now() / 30_000));
    await evalJs(`(() => { document.querySelector('#security-code').value = ${JSON.stringify(mediumCode)}; document.querySelector('#security-action-confirm').click(); })()`);
    check('S3 中档邀请：码通过后出令牌（旧流程复用）',
      await waitFor('(() => { const t = document.querySelector("#invite-body")?.textContent ?? ""; return /令牌/.test(t) && t.length > 40; })()', 20000));
    await evalJs('document.querySelector("#invite-close").click()');
    await evalJs('document.querySelector("#settings-close").click()');
    await send('Page.navigate', { url: `${base}/console/?select=device-C` });
    check('S3 中档移出布局：移出提级为一等动作（btn-crt-danger，与同步同排）',
      await waitFor(`(() => {
        const b = document.querySelector('#device-card-body');
        if (!b || b.hidden) return false;
        const mainRow = b.querySelector(':scope > .card-actions');
        const main = mainRow?.querySelector('[data-action=revoke-device]');
        const adv = b.querySelector('.card-advanced');
        return Boolean(main) && main.classList.contains('btn-crt-danger') && (!adv || !adv.contains(main));
      })()`));

    // 中→低（要码）→ 低→高（强制恢复码展示+回执）→ 高档邀请等待会签
    await send('Page.navigate', { url: `${base}/console/` });
    await waitFor('document.querySelector("#security-badge") && /🛡 安全：中/.test(document.querySelector("#security-badge").textContent) && !/…/.test(document.querySelector("#memory-badge")?.textContent ?? "…")', 20000);
    await evalJs('document.querySelector("#open-settings").click()');
    await evalJs('document.querySelector("[data-settings-tab=security]").click()');
    check('S3 中档凭条：设置打开且安全卡就位（降级入口内联在卡尾）',
      await waitFor('document.querySelector("#settings")?.hidden === false && Boolean(document.querySelector("#settings-security-slot [data-security-action=downgrade][data-level=low]"))', 20000));
    await evalJs('document.querySelector("#settings-security-slot [data-security-action=downgrade][data-level=low]").click()');
    await waitFor('Boolean(document.querySelector("#security-code"))');
    const downCode = totpCodeAt(SEC_TOTP_SECRET, Math.floor(Date.now() / 30_000) + 1);
    await evalJs(`(() => { document.querySelector('#security-code').value = ${JSON.stringify(downCode)}; document.querySelector('#security-action-confirm').click(); })()`);
    check('S3 中→低：动态码通过后回到低档',
      await waitFor('document.querySelector("#settings-security-slot")?.dataset.securityLevel === "low"', 20000));
    await evalJs('document.querySelector("#settings-security-slot [data-security-action=upgrade][data-level=high]").click()');
    await waitFor('document.querySelector("#modal")?.hidden === false');
    await evalJs('document.querySelector("#modal-confirm").click()');
    const onceOk = await waitFor('Boolean(document.querySelector("[data-security-once]"))', 20000);
    const onceText = onceOk ? await evalJs('document.querySelector("[data-security-once]").textContent.trim()') : '';
    check('S3 低→高：恢复码只显示一次（格式分组 + 焦点在展示区 + 回执按钮）',
      onceOk && /[0-9A-Z]{4}/.test(onceText)
        && (await evalJs('document.activeElement?.closest("[data-security-once]") !== null || document.activeElement?.id === "security-recovery-once"'))
        && (await evalJs('Boolean(document.querySelector("[data-security-ack]"))')));
    check('S3 恢复码展示：禁止截图/数字化文案（诚实）',
      await evalJs('(() => { const t = document.querySelector("#security-action-body")?.textContent ?? ""; return /离线介质/.test(t) && /不要截图/.test(t); })()'));
    await evalJs('document.querySelector("[data-security-ack]").click()');
    check('S3 回执后：高档开卡（恢复码 keyId 前 8 + 轮换入口）',
      await waitFor('document.querySelector("#settings-security-slot")?.dataset.securityLevel === "high" && /恢复码/.test(document.querySelector("#settings-security-slot")?.textContent ?? "") && Boolean(document.querySelector("#settings-security-slot [data-security-action=recovery-rotate]"))', 20000));
    check('S3 顶栏徽章与高档同步（🛡 安全：高）', await waitFor('/🛡 安全：高/.test(document.querySelector("#security-badge")?.textContent ?? "")'));
    await evalJs('document.querySelector("#invite-device").click()');
    check('S3 高档邀请改道：配对号 + 等待状态（aria-live；批准后自动出令牌）',
      await waitFor(`(() => {
        const p = document.querySelector('#security-action-body [data-security-pairing]');
        const t = document.querySelector('#security-action-body')?.textContent ?? '';
        return Boolean(p) && p.getAttribute('aria-live') === 'polite' && /^\\d{3}-\\d{3}$/.test(p.textContent.trim())
          && /等待/.test(t) && /批准/.test(t);
      })()`));
    await evalJs('document.querySelector("#security-action-close").click()');

    // S4：高档移出「用恢复码执行」路径（原确认 + 会签等待保留；码一次性、不回显）
    await send('Page.navigate', { url: `${base}/console/?select=device-C` });
    check('S4 高档移出前置：设备卡移出入口就位',
      await waitFor('(() => { const b = document.querySelector("#device-card-body"); return Boolean(b) && !b.hidden && Boolean(b.querySelector("[data-action=revoke-device]")); })()'));
    await evalJs('document.querySelector("#device-card-body [data-action=revoke-device]").click()');
    check('S4 高档移出：先保留原确认与警告',
      await waitFor('document.querySelector("#modal")?.hidden === false && /高 · 设备会签/.test(document.querySelector("#modal")?.textContent ?? "")'));
    await evalJs('document.querySelector("#modal-confirm").click()');
    check('S4 高档移出：会签等待弹层提供「用恢复码执行」入口',
      await waitFor('document.querySelector("#security-action")?.hidden === false && Boolean(document.querySelector("[data-security-recovery-switch]")) && /等待另一台设备批准/.test(document.querySelector("#security-action")?.textContent ?? "")'));
    await evalJs('document.querySelector("[data-security-recovery-switch]").click()');
    check('S4 恢复码弹层：密码型输入 + 不回显/不落浏览器存储提示',
      await waitFor(`(() => {
        const input = document.querySelector('#security-recovery-code');
        const t = document.querySelector('#security-action-body')?.textContent ?? '';
        return Boolean(input) && input.type === 'password' && /不写入浏览器存储/.test(t) && /提交后输入框即清空/.test(t);
      })()`));
    await capture('after-high-kick-recovery-code.jpg');
    const wrongRecoveryCode = generateRecoveryCode().code;
    await evalJs(`(() => { document.querySelector('#security-recovery-code').value = ${JSON.stringify(wrongRecoveryCode)}; document.querySelector('#security-action-confirm').click(); })()`);
    check('S4 错恢复码映射人话（不匹配当前 keyId）',
      await waitFor('/不匹配当前 keyId/.test(document.querySelector("#security-action-error")?.textContent ?? "")'));
    check('S4 错码后输入框已清空（不回显、不保留）',
      (await evalJs('document.querySelector("#security-recovery-code")?.value ?? ""')) === '');
    await evalJs(`(() => { document.querySelector('#security-recovery-code').value = ${JSON.stringify(onceText)}; document.querySelector('#security-action-confirm').click(); })()`);
    check('S4 正确恢复码 → 移出写入并关闭弹层（toast 标注恢复码）',
      await waitFor('document.querySelector("#security-action")?.hidden === true && /恢复码/.test(document.querySelector("#banner")?.textContent ?? "")', 20000));
    const kickAudit = await evalJs(`(async () => {
      const rows = await fetch('/admin/api/policy').then((r) => r.json());
      const row = (rows ?? []).find((e) => e.type === 'device_revoke' && e.subject === 'device-C');
      return { has: Boolean(row), keyId: row?.breakGlassKeyId ?? null };
    })()`);
    check('S4 移出审计行标注恢复码（breakGlassKeyId）', kickAudit.has === true && typeof kickAudit.keyId === 'string');

    // S4：高档降档「用恢复码执行」路径
    await evalJs('document.querySelector("#open-settings").click()');
    await evalJs('document.querySelector("[data-settings-tab=security]").click()');
    check('S4 高档降档前置：安全卡为高档 + 降级入口就位',
      await waitFor('document.querySelector("#settings")?.hidden === false && document.querySelector("#settings-security-slot")?.dataset.securityLevel === "high" && Boolean(document.querySelector("#settings-security-slot [data-security-action=downgrade][data-level=low]"))', 20000));
    await evalJs('document.querySelector("#settings-security-slot [data-security-action=downgrade][data-level=low]").click()');
    check('S4 高档降档：会签等待弹层提供「用恢复码执行」入口',
      await waitFor('Boolean(document.querySelector("[data-security-recovery-switch]")) && /降级到低/.test(document.querySelector("#security-action-title")?.textContent ?? "")'));
    await evalJs('document.querySelector("[data-security-recovery-switch]").click()');
    await waitFor('Boolean(document.querySelector("#security-recovery-code"))');
    await evalJs(`(() => { document.querySelector('#security-recovery-code').value = ${JSON.stringify(onceText)}; document.querySelector('#security-action-confirm').click(); })()`);
    check('S4 高档降档用恢复码 → 回到低档',
      await waitFor('document.querySelector("#settings-security-slot")?.dataset.securityLevel === "low"', 20000));
    const tierAudit = await evalJs(`(async () => {
      const rows = await fetch('/admin/api/policy').then((r) => r.json());
      const row = (rows ?? []).find((e) => e.type === 'security_tier' && typeof e.breakGlassKeyId === 'string');
      return { level: row?.level ?? null, keyId: row?.breakGlassKeyId ?? null };
    })()`);
    check('S4 降档审计行标注恢复码（低档 + breakGlassKeyId）',
      tierAudit.level === 'low' && typeof tierAudit.keyId === 'string');
    await evalJs('document.querySelector("#settings-close").click()');

    // 审计：安全事件标签 / 过滤器 / 详情
    await evalJs('document.querySelector("#settings-close").click()');
    await evalJs('document.querySelector("#view-nav li:nth-of-type(4) button").click()');
    check('S3 审计：过滤器含安全事件项（等级变更/设备会签/恢复码/动态码）',
      await waitFor(`(() => {
        const sel = document.querySelector('#audit-filter-action');
        const values = Array.from(sel?.options ?? []).map((o) => o.value);
        return ['security_tier', 'security_approval', 'security_recovery', 'security_totp'].every((v) => values.includes(v));
      })()`));
    // 触发一次「安全等级变更」过滤，断言行标签与详情
    await evalJs(`(() => { const sel = document.querySelector('#audit-filter-action'); sel.value = 'security_tier'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    check('S3 审计：安全等级变更行标签 + 「低 → 中/中 → 低/低 → 高」详情',
      await waitFor(`(() => {
        const t = document.querySelector('#audit-view')?.textContent ?? '';
        return /安全等级变更/.test(t) && /低 → 中/.test(t) && /中 → 低/.test(t) && /低 → 高/.test(t);
      })()`));
    await evalJs(`(() => { const sel = document.querySelector('#audit-filter-action'); sel.value = 'security_approval'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    check('S3 审计：设备会签行（批准/拒绝 + 配对号 + 对象）',
      await waitFor(`(() => {
        const t = document.querySelector('#audit-view')?.textContent ?? '';
        return /设备会签/.test(t) && /批准/.test(t) && /拒绝/.test(t) && /\\d{3}-\\d{3}/.test(t);
      })()`));
    await evalJs(`(() => { const sel = document.querySelector('#audit-filter-action'); sel.value = 'security_recovery'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    check('S3 审计：恢复码行（keyId 前 8 + 登记/轮换）',
      await waitFor(`(() => { const t = document.querySelector('#audit-view')?.textContent ?? ''; return /恢复码/.test(t) && /[0-9a-f]{8}/.test(t) && /(登记|轮换)/.test(t); })()`));

    // ---------- v4 记忆共享：?mock=1 验收路径 + 无审批族 + 订阅事实 ----------
    await send('Page.navigate', { url: `${base}/console/?mock=1` });
    check('v4 mock：记忆共享统计新口径 + 左列订阅标记',
      await waitFor('(() => { const s = document.querySelector("#domains-stats")?.textContent ?? ""; const list = document.querySelector("#domains-list")?.textContent ?? ""; return /记忆域 4/.test(s) && /已订阅 3/.test(s) && /未订阅/.test(list); })()'));
    await evalJs('document.querySelector("#domains-list [data-sector=notes]").click()');
    check('v4 mock：域卡 = 订阅事实（关系行 + 订阅的设备 + 状态文字化；无批准/撤回）',
      await waitFor(`(() => {
        const d = document.querySelector('#domain-detail');
        if (!d) return false;
        const t = d.textContent;
        return /也在订阅这个域/.test(t) && /订阅的设备/.test(t) && /已订阅/.test(t)
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
    await evalJs('document.querySelector("#view-nav li:nth-of-type(4) button").click()');
    check('§7 mock 审计：订阅/公告/移出事件可见，无自动签发折叠',
      await waitFor(`(() => {
        const view = document.querySelector('#audit-view');
        if (!view || view.hidden) return false;
        const t = view.textContent;
        return /订阅变更/.test(t) && /域公告/.test(t) && /移出设备/.test(t)
          && !view.querySelector('.audit-auto-toggle') && !/自动签发/.test(t);
      })()`));

    // S3 mock：高档安全卡（待批准 / 恢复码 / 拒绝原因）+ 星图注意 + 审计拒绝原因
    // 注意卡只在星图视图渲染；前一步停在审计视图，先切回星图再断言（不依赖隐藏卡残留）。
    await evalJs('document.querySelector("#view-nav li:nth-of-type(1) button").click()');
    check('S3 mock：顶栏徽章高 + 星图「需要注意」安全项（待批准 / 拒绝）',
      await waitFor(`(() => {
        const t = document.querySelector('#attention-card')?.textContent ?? '';
        return /🛡 安全：高/.test(document.querySelector('#security-badge')?.textContent ?? '')
          && /待批准 1 项/.test(t) && /1 条安全操作被拒绝/.test(t);
      })()`));
    await evalJs('document.querySelector("#open-settings").click()');
    await evalJs('document.querySelector("[data-settings-tab=security]").click()');
    check('S3 mock：高档安全卡 = 当前高 + 恢复码 keyId 前 8 + 可会签设备',
      await waitFor(`(() => {
        const s = document.querySelector('#settings-security-slot');
        const t = s?.textContent ?? '';
        return s?.dataset.securityLevel === 'high' && /当前/.test(s.querySelector('[data-security-current]')?.textContent ?? '')
          && Boolean(s.querySelector('[data-security-tier=high].is-current'))
          && /恢复码/.test(t) && /a1b2c3d4/.test(t) && /可会签设备/.test(t);
      })()`));
    await capture('e1-after-settings-security-mock.jpg');
    check('S3 mock：待批准行（配对号 aria-live + 批准/拒绝 + 到期提示）',
      await waitFor(`(() => {
        const s = document.querySelector('#settings-security-slot');
        const p = s?.querySelector('[data-security-pairing]');
        return Boolean(p) && p.getAttribute('aria-live') === 'polite' && /^\\d{3}-\\d{3}$/.test(p.textContent.trim())
          && Boolean(s.querySelector('[data-security-approve]')) && Boolean(s.querySelector('[data-security-deny]'))
          && /有效至|过期/.test(s.textContent);
      })()`));
    check('S3 mock：拒绝原因抬头可见（映射为中文，不静默）',
      await evalJs('(() => { const s = document.querySelector("#settings-security-slot"); return /1 条安全操作被拒绝/.test(s.textContent) && /缺少会签证明/.test(s.textContent); })()'));
    await evalJs('document.querySelector("#settings-close").click()');
    await evalJs('(() => { const sel = document.querySelector("#audit-filter-action"); sel.value = "security_tier"; sel.dispatchEvent(new Event("change", { bubbles: true })); })()');
    check('S3 mock 审计：安全等级行 + 拒绝原因（抬头可见）',
      await waitFor(`(() => {
        const t = document.querySelector('#audit-view')?.textContent ?? '';
        return /安全等级变更/.test(t) && /低 → 高/.test(t) && /缺少会签证明/.test(t);
      })()`));
    await evalJs('(() => { const sel = document.querySelector("#audit-filter-action"); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); })()');
    check('S3 mock 审计：设备会签 + 恢复码 + 动态码行标签齐备',
      await waitFor(`(() => {
        const t = document.querySelector('#audit-view')?.textContent ?? '';
        return /设备会签/.test(t) && /恢复码/.test(t) && /动态码/.test(t) && /482-917/.test(t);
      })()`));

    // S3 窄屏：安全卡弹层无横向溢出（配对号/恢复码/按钮换行）
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evalJs('document.querySelector("#open-settings").click()');
    await evalJs('document.querySelector("[data-settings-tab=security]").click()');
    check('S3/E1 窄屏：安全卡与 5 页签不横向溢出（390px）',
      await waitFor(`(() => {
        const box = document.querySelector('#settings .modal-box');
        const card = document.querySelector('#settings-security-slot');
        const tabs = document.querySelector('#settings-body .settings-tabs');
        if (!box || !card || !tabs) return false;
        return box.scrollWidth <= box.clientWidth + 1 && card.scrollWidth <= card.clientWidth + 1
          && tabs.scrollWidth <= tabs.clientWidth + 1
          && document.documentElement.scrollWidth <= window.innerWidth + 1;
      })()`));
    await capture('e1-after-settings-security-narrow-390.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evalJs('document.querySelector("#settings-close").click()');
    await send('Emulation.clearDeviceMetricsOverride');

    // 设备卡（对端）：interop 段为订阅事实、无批准/撤回（?select= 深链选中）
    await send('Page.navigate', { url: `${base}/console/?mock=1&select=device-B` });
    check('v4 mock：设备卡对端 = 订阅事实（它订阅的记忆域 + 订阅情况 + 双方/单方陈述）',
      await waitFor(`(() => {
        const b = document.querySelector('#device-card-body');
        if (!b || b.hidden) return false;
        const t = b.textContent;
        return /它订阅的记忆域/.test(t) && /订阅情况/.test(t)
          && /双方都已订阅/.test(t) && /本机已订阅 · 它未订阅/.test(t)
          && /它已订阅 · 本机未订阅/.test(t);
      })()`));
    check('v4 mock：目录中的空域在设备卡可见（ledger：公告可见、无内容也不丢）',
      await evalJs(`(() => {
        const b = document.querySelector('#device-card-body');
        const domains = document.querySelector('#domains-list')?.textContent ?? '';
        const t = b?.textContent ?? '';
        return /ledger/.test(t) && /ledger/.test(domains);
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
      check('E2-A2 窄屏：两枚入口折叠为图标（等宽）+ 忆云徽章可见 + 无横向溢出',
        await waitFor(`(() => {
          const labels = [...document.querySelectorAll('.topbar-actions .btn-label')];
          const buttons = [...document.querySelectorAll('.topbar-actions .btn')];
          return labels.length >= 3 && labels.every((el) => getComputedStyle(el).display === 'none')
            && buttons.every((el) => Math.abs(el.getBoundingClientRect().width - 34) <= 2)
            && document.querySelector('#cloud-badge')?.hidden === false
            && document.documentElement.scrollWidth <= window.innerWidth + 1;
        })()`));
      await capture('e2a2-after-topbar-narrow-390.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
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
        await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
        check('轮 C 引导态不响应 Esc（必须先建新/加入）',
          await evalJs('document.querySelector("#provision")?.hidden === false'));
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
