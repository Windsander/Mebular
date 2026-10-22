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
import { existsSync, readFileSync } from 'node:fs';
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
  const joinServicePort = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath,
    deviceId: 'device-ui',
    encryption: { level: 'none', keyFile },
    network: { enabled: false },
    sync: { autoSync: true, pushOnWrite: true, antiEntropy: { enabled: false }, namespaces: ['notes', 'work'] },
    mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
    joinService: { enabled: true, bind: '0.0.0.0', port: joinServicePort },
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
  throw new Error(`serve 就绪超时：${handle.getErr().slice(-400)} / out=${handle.getOut().slice(-400)}`);
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
  console.log('Mebular UI 冒烟（headless Chrome / CDP）');

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
    // 当前视口截图（不改 device metrics）；用于同一档位先断言后落盘，避免断言与截图视口不一致。
    const captureNow = async (name) => {
      if (!shotDir) return null;
      await sleep(200);
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
      await writeFile(join(shotDir, name), Buffer.from(shot.data, 'base64'));
      return join(shotDir, name);
    };
    const setViewport = async (viewport) => {
      await send('Emulation.setDeviceMetricsOverride', viewport);
      await sleep(250);
    };
    const clearViewport = async () => {
      await send('Emulation.clearDeviceMetricsOverride');
      await sleep(100);
    };

    await send('Page.navigate', { url: `${base}/console/` });
    check('页面加载完成（标题 / #stage）', await waitFor('document.title.includes("Mebular") && Boolean(document.querySelector("#stage"))'));
    check('弹窗对齐规范：小弹窗 + 加入忆云 modal-center；其余大面板顶部对齐',
      await evalJs(`(() => {
        const small = ['wizard', 'invite', 'cloud-switch', 'security-action', 'handoff', 'modal', 'auth-token', 'namespace-new-modal', 'cloud-join', 'onboard-create', 'onboard-join'];
        const large = ['settings', 'about', 'provision'];
        const boxes = [...document.querySelectorAll('.modal .modal-box')];
        return small.every((id) => document.querySelector('#' + id)?.classList.contains('modal-center'))
          && large.every((id) => !document.querySelector('#' + id)?.classList.contains('modal-center'))
          && boxes.every((box) => box.classList.contains('crt-surface') && box.classList.contains('crt-corners'));
      })()`));
    check('弹窗宽度类别：邀请/新建域 非 wide；加入忆云 wide（打开态宽度另测）',
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
    const memDropdown = await evalJs(`(() => {
      const select = document.querySelector('#mem-filter-namespace');
      const trigger = document.querySelector('#mem-filter-namespace-trigger');
      const menu = document.querySelector('#mem-filter-namespace-menu');
      if (!select || !trigger || !menu) return { ok: false };
      const before = select.value;
      trigger.click();
      const result = {
        ok: true,
        options: menu.querySelectorAll('[role=option]').length,
        nativeOptions: select.options.length,
        text: menu.textContent,
        selected: menu.querySelector('[role=option][aria-selected=true]')?.textContent.trim() ?? '',
        fixed: getComputedStyle(menu).position === 'fixed',
      };
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      result.closed = menu.hidden && document.activeElement === trigger && select.value === before;
      return result;
    })()`);
    check('下拉框 · 记忆域筛选：动态域选项镜像原生 select，Esc 关闭且不改筛选值',
      memDropdown.ok && memDropdown.options === memDropdown.nativeOptions
        && memDropdown.options >= 2 && /全部域/.test(memDropdown.text)
        && /全部域/.test(memDropdown.selected) && memDropdown.fixed && memDropdown.closed,
      JSON.stringify(memDropdown));
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
    const verifyFailedOk = await waitFor('(() => { const v = document.querySelector("#settings-panel-assistants [data-asst-verify=opencode]"); if (!v || !/验证未过/.test(v.textContent)) return false; if (!v.querySelector("[data-asst-output]")) return false; if (v.querySelector("details")) return false; const row = document.querySelector("#settings-panel-assistants [data-asst-row=opencode]"); return Boolean(row) && /重新验证/.test(row.textContent); })()', 20000);
    check('验证未过 = 黄态一行 + 「重新验证」+ 输出内联（无嵌套折叠）', verifyFailedOk,
      verifyFailedOk ? '' : await evalJs('(() => { const v = document.querySelector("#settings-panel-assistants [data-asst-verify=opencode]"); const row = document.querySelector("#settings-panel-assistants [data-asst-row=opencode]"); return JSON.stringify({ verify: v?.textContent?.slice(0, 240) ?? null, row: row?.textContent?.slice(0, 240) ?? null, state: window.__mebularDebug?.clientVerify?.["opencode"] ?? null }); })()').catch((e) => String(e)));
    check('manual（generic 粘片段）行永不出现自动写「接入」',
      await evalJs('(() => { const row = document.querySelector("#settings-panel-assistants [data-asst-row=generic]"); const xp = document.querySelector("#settings-panel-assistants [data-asst-xp=generic]"); if (!row || !/查看片段/.test(row.textContent)) return false; return !row.querySelector("[data-cli-action=connect]") && !(xp && xp.querySelector("[data-cli-action=connect]")); })()'));

    // UX-2 收口 ①＋新增助手 CRUD：登记（POST）→ 列表即时出现 → 编辑（PUT）→ 移除（POST remove）
    await evalJs('document.querySelector("#asst-add").click()');
    check('＋新增助手表单出现（选文件 / 粘片段双模式）',
      await waitFor('(() => { const f = document.querySelector("#asst-add-form"); return Boolean(f) && f.querySelectorAll("input[name=asst-mode]").length === 2 && Boolean(f.querySelector("#asst-add-path")); })()'));
    const asstDropdown = await evalJs(`(() => {
      const select = document.querySelector('#asst-add-format');
      const trigger = document.querySelector('#asst-add-format-trigger');
      const menu = document.querySelector('#asst-add-format-menu');
      if (!select || !trigger || !menu) return { ok: false };
      trigger.click();
      const opened = {
        options: menu.querySelectorAll('[role=option]').length,
        nativeOptions: select.options.length,
        labels: [...menu.querySelectorAll('[role=option]')].map((el) => el.textContent.trim()),
        fixed: getComputedStyle(menu).position === 'fixed',
        below: menu.getBoundingClientRect().top >= trigger.getBoundingClientRect().bottom,
        flipped: menu.getBoundingClientRect().bottom <= trigger.getBoundingClientRect().top - 2,
        menuTop: menu.getBoundingClientRect().top,
        triggerBottom: trigger.getBoundingClientRect().bottom,
      };
      menu.querySelectorAll('[role=option]')[1].click();
      const after = {
        value: select.value,
        text: trigger.textContent.trim(),
        closed: menu.hidden,
        focused: document.activeElement === trigger,
      };
      trigger.click();
      menu.querySelectorAll('[role=option]')[0].click();
      return { ok: true, opened, after, restored: select.value };
    })()`);
    check('下拉框 · 助手配置格式：表单渲染后增强，菜单选项 = 原生 options，选中回写并保持表单可用',
      asstDropdown.ok && asstDropdown.opened.options === asstDropdown.opened.nativeOptions
        && asstDropdown.opened.fixed && (asstDropdown.opened.below || asstDropdown.opened.flipped)
        && asstDropdown.opened.labels.some((label) => /opencode/.test(label))
        && asstDropdown.after.value === 'opencode' && /opencode/.test(asstDropdown.after.text)
        && asstDropdown.after.closed && asstDropdown.after.focused
        && asstDropdown.restored === 'mcpServers',
      JSON.stringify(asstDropdown));
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
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-asst-remove=ui-test-asst]"); if (b) b.click(); })()');
    check('移除走应用内确认（#modal，非原生 confirm）',
      await waitFor('(() => { const m = document.querySelector("#modal"); return Boolean(m) && m.hidden === false && /移除自定义助手/.test(document.querySelector("#modal-title")?.textContent ?? ""); })()'));
    await evalJs('document.querySelector("#modal-confirm").click()');
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
    // 清理：展开详情移除（应用内确认）
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-cli-action=details][data-cli-id=ui-broken-asst]"); if (b) b.click(); })()');
    await evalJs('(() => { const b = document.querySelector("#settings-panel-assistants [data-asst-remove=ui-broken-asst]"); if (b) b.click(); })()');
    await waitFor('document.querySelector("#modal")?.hidden === false');
    await evalJs('document.querySelector("#modal-confirm").click()');
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
    check('下拉框 · 静态审计/记忆筛选器均已增强（原生 select 保留为隐藏兼容层）',
      await waitFor(`(() => {
        const ids = ['audit-filter-action', 'audit-filter-device', 'audit-filter-namespace', 'audit-filter-time', 'mem-filter-namespace'];
        return ids.every((id) => {
          const select = document.getElementById(id);
          const trigger = document.getElementById(id + '-trigger');
          return Boolean(select && trigger)
            && select.getAttribute('aria-hidden') === 'true' && select.tabIndex === -1
            && trigger.getAttribute('role') === 'combobox'
            && trigger.getAttribute('aria-haspopup') === 'listbox'
            && document.getElementById(id + '-menu')?.parentElement === document.body;
        });
      })()`));
    const auditDropdown = await evalJs(`(() => {
      const select = document.querySelector('#audit-filter-action');
      const trigger = document.querySelector('#audit-filter-action-trigger');
      const menu = document.querySelector('#audit-filter-action-menu');
      trigger.focus();
      trigger.click();
      const t = trigger.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      const opened = {
        expanded: trigger.getAttribute('aria-expanded'),
        role: menu.getAttribute('role'),
        options: menu.querySelectorAll('[role=option]').length,
        nativeOptions: select.options.length,
        fixed: getComputedStyle(menu).position === 'fixed',
        below: Math.abs(m.top - (t.bottom + 6)) <= 2,
        flipped: m.bottom <= t.top - 2,
        menuTop: m.top,
        triggerBottom: t.bottom,
        innerHeight: window.innerHeight,
        active: trigger.getAttribute('aria-activedescendant') === menu.querySelector('[role=option].is-active')?.id,
      };
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const moved = trigger.getAttribute('aria-activedescendant') === menu.querySelectorAll('[role=option]')[1]?.id;
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const selected = {
        value: select.value,
        closed: menu.hidden,
        focused: document.activeElement === trigger,
        filtered: /订阅变更/.test(document.querySelector('#audit-list')?.textContent ?? ''),
      };
      trigger.focus();
      trigger.click();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const escaped = { closed: menu.hidden, focused: document.activeElement === trigger };
      trigger.click();
      document.body.click();
      const outside = { closed: menu.hidden, expanded: trigger.getAttribute('aria-expanded') };
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { opened, moved, selected, escaped, outside };
    })()`);
    check('下拉框 · 审计动作：打开重建/固定定位在 trigger 下方/↑↓+Enter/Esc/点击外部关闭/焦点回 trigger',
      auditDropdown.opened.expanded === 'true' && auditDropdown.opened.role === 'listbox'
        && auditDropdown.opened.options === auditDropdown.opened.nativeOptions
        && auditDropdown.opened.fixed && (auditDropdown.opened.below || auditDropdown.opened.flipped)
        && auditDropdown.opened.active
        && auditDropdown.moved
        && auditDropdown.selected.value === 'namespace_subscription' && auditDropdown.selected.closed
        && auditDropdown.selected.focused && auditDropdown.selected.filtered
        && auditDropdown.escaped.closed && auditDropdown.escaped.focused
        && auditDropdown.outside.closed && auditDropdown.outside.expanded === 'false',
      JSON.stringify(auditDropdown));
    const auditDynamic = await evalJs(`(() => {
      const select = document.querySelector('#audit-filter-device');
      const trigger = document.querySelector('#audit-filter-device-trigger');
      const menu = document.querySelector('#audit-filter-device-menu');
      const option = document.createElement('option');
      option.value = 'device-dynamic-probe';
      option.textContent = '动态设备探针';
      select.append(option);
      const nativeOptions = select.options.length;
      trigger.click();
      const seen = {
        options: menu.querySelectorAll('[role=option]').length,
        text: /动态设备探针/.test(menu.textContent),
        lastText: [...menu.querySelectorAll('[role=option]')].at(-1)?.textContent.trim() ?? '',
      };
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      option.remove();
      trigger.click();
      const gone = !/动态设备探针/.test(menu.textContent);
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { nativeOptions, seen, gone };
    })()`);
    check('下拉框 · 动态选项：每次打开从原生 select 重建（新增设备/域立即可见，移除即消失）',
      auditDynamic.seen.options === auditDynamic.nativeOptions
        && auditDynamic.seen.text && /动态设备探针/.test(auditDynamic.seen.lastText)
        && auditDynamic.gone,
      JSON.stringify(auditDynamic));
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
          && Boolean(archived.querySelector('[data-cloud-switch]')) && !archived.querySelector('[data-cloud-rename]')
          && /切换到该忆云后可改名/.test(archived.textContent)
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

    // 设备名：关于本机 → 身份与存储 → 改名；保存后设备列表/概览都显示新名字
    await evalJs('document.querySelector("#settings-close").click()');
    await evalJs('document.querySelector("#self-badge").click()');
    check('设备名：关于本机提供「改名」入口',
      await waitFor('Boolean(document.querySelector("#about-body [data-device-rename]"))'));
    await evalJs('document.querySelector("#about-body [data-device-rename]").click()');
    check('设备名：行内输入就位', await waitFor('Boolean(document.querySelector("[data-device-rename-input]"))'));
    await evalJs(`(() => {
      const input = document.querySelector('[data-device-rename-input]');
      input.value = '演示笔记本';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-device-rename-save]').click();
    })()`);
    check('设备名：保存后关于本机显示新名字',
      await waitFor('(() => { const body = document.querySelector("#about-body"); return Boolean(body) && /演示笔记本/.test(body.textContent); })()', 20000));
    check('设备名：设备列表返回最新 name（deviceId 仍是唯一标识）', await evalJs(`(async () => {
      const res = await fetch('/admin/api/devices', { headers: { accept: 'application/json' } });
      const rows = await res.json();
      const self = rows.find((row) => row.deviceId === 'device-ui');
      return Boolean(self) && self.name === '演示笔记本';
    })()`));
    await evalJs('document.querySelector("#about-close").click()');
    // 设备名用例从关于本机返回后，恢复设置弹层（后续 CSRF/待重启用例依赖它保持打开）。
    await evalJs('document.querySelector("#open-settings").click()');
    await evalJs('document.querySelector("[data-settings-tab=common]").click()');
    await waitFor('document.querySelector("#settings")?.hidden === false');

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
    const mcpDropdown = await evalJs(`(() => {
      const select = document.querySelector('${authSelector}');
      const trigger = document.querySelector('#cfg-mcp-http-auth-trigger');
      const menu = document.querySelector('#cfg-mcp-http-auth-menu');
      if (!select || !trigger || !menu) return { ok: false };
      const before = select.value;
      trigger.click();
      const result = {
        ok: true,
        fixed: getComputedStyle(menu).position === 'fixed',
        options: menu.querySelectorAll('[role=option]').length,
        nativeOptions: select.options.length,
        labels: [...menu.querySelectorAll('[role=option]')].map((el) => el.textContent.trim()),
        selected: menu.querySelector('[role=option][aria-selected=true]')?.textContent.trim() ?? '',
        width: Math.round(trigger.getBoundingClientRect().width),
        controlWidth: Math.round(trigger.closest('.cfg-control').getBoundingClientRect().width),
        nativeHidden: select.getAttribute('aria-hidden') === 'true' && select.tabIndex === -1,
        menuCount: document.querySelectorAll('#cfg-mcp-http-auth-menu').length,
        triggerCount: document.querySelectorAll('#cfg-mcp-http-auth-trigger').length,
        menuSelectId: menu.id,
        triggerOpen: trigger.getAttribute('aria-expanded'),
      };
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      result.closed = menu.hidden && document.activeElement === trigger;
      result.valueUnchanged = select.value === before;
      return result;
    })()`);
    check('下拉框 · MCP auth：配置 select 渲染后增强（全宽 trigger / 选项镜像 / Esc 不改值）',
      mcpDropdown.ok && mcpDropdown.fixed && mcpDropdown.nativeHidden
        && mcpDropdown.options === mcpDropdown.nativeOptions
        && mcpDropdown.labels.some((label) => /none/.test(label))
        && mcpDropdown.labels.some((label) => /bearer/.test(label))
        && mcpDropdown.selected.length > 0
        && Math.abs(mcpDropdown.width - mcpDropdown.controlWidth) <= 2
        && mcpDropdown.closed && mcpDropdown.valueUnchanged,
      JSON.stringify(mcpDropdown));

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
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalJs('document.querySelector("#join-cloud").click()');
    const joinModalOk = await waitFor(`(() => {
        const modal = document.querySelector('#cloud-join');
        return Boolean(modal) && modal.hidden === false
          && document.querySelector('#cloud-join-name')?.value === '忆云 3'
          && /当前忆云(?:仍是)?「忆云 1」/.test(document.querySelector('#cloud-join-warning')?.textContent ?? '')
          && /归档保留/.test(modal.textContent);
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
    const joinDesktop = await evalJs(`(() => {
      const modal = document.querySelector('#cloud-join');
      const box = modal?.querySelector('.modal-box');
      const fields = modal?.querySelector('.cloud-join-fields');
      const inspect = modal?.querySelector('#cloud-join-inspect');
      const x = modal?.querySelector('.modal-head #cloud-join-x.modal-x');
      if (!box || !fields || !inspect) return { ok: false };
      const labels = [...fields.querySelectorAll('label')].map((el) => el.textContent.trim());
      const token = modal.querySelector('#cloud-join-token');
      const name = modal.querySelector('#cloud-join-name');
      return {
        ok: true,
        vw: window.innerWidth,
        singleColumn: !modal.querySelector('.cloud-join-side')
          && !modal.querySelector('.cloud-join-grid')
          && !modal.querySelector('.cloud-join-preview'),
        noPreviewCopy: !/令牌预览/.test(modal.textContent),
        inspectHidden: inspect.hidden === true,
        labels,
        tokenFirst: token.getBoundingClientRect().top < name.getBoundingClientRect().top,
        fullWidthFields: Math.abs(token.getBoundingClientRect().width - name.getBoundingClientRect().width) <= 1,
        hasX: Boolean(x) && x.getBoundingClientRect().width > 0,
        boxWidth: Math.round(box.getBoundingClientRect().width),
        noOverflow: box.scrollWidth <= box.clientWidth + 1
          && document.documentElement.scrollWidth <= window.innerWidth + 1,
      };
    })()`);
    check('加入忆云桌面：标题/关闭 X + 单列输入流（无空预览侧栏）+ token→name + 无横向溢出',
      joinDesktop.ok
        && joinDesktop.singleColumn
        && joinDesktop.noPreviewCopy
        && joinDesktop.inspectHidden
        && joinDesktop.hasX
        && joinDesktop.boxWidth === 560
        && joinDesktop.tokenFirst
        && joinDesktop.fullWidthFields
        && joinDesktop.labels.length === 2
        && joinDesktop.labels[0].includes('加入令牌')
        && joinDesktop.labels[1].includes('忆云名字')
        && joinDesktop.noOverflow,
      JSON.stringify(joinDesktop));
    check('加入忆云按钮层级：底部仅取消 + 一个主操作；结果/状态/错误不同时出现', await evalJs(`(() => {
      const modal = document.querySelector('#cloud-join');
      const actions = [...modal.querySelectorAll('.modal-actions .btn')];
      const primary = [...modal.querySelectorAll('.btn-primary')];
      return actions.length === 2
        && actions[0].id === 'cloud-join-close' && actions[0].hidden === false && actions[0].disabled === false
        && actions[1].id === 'cloud-join-submit' && actions[1].classList.contains('btn-primary')
        && primary.length === 1 && primary[0] === actions[1]
        && document.querySelector('#cloud-join-result')?.hidden === true
        && document.querySelector('#cloud-join-error')?.hidden === true
        && document.querySelector('#cloud-join-steps')?.hidden === true;
    })()`));
    check('加入忆云标题无「一次性令牌」tag：标题/lead 左对齐、X 与标题同排', await evalJs(`(() => {
      const h2 = document.querySelector('#cloud-join-title');
      const lead = document.querySelector('#cloud-join .cloud-join-lead');
      const x = document.querySelector('#cloud-join-x');
      return Boolean(h2) && !h2.querySelector('.crt-tag') && !/一次性令牌/.test(h2.textContent)
        && Math.abs(h2.getBoundingClientRect().left - lead.getBoundingClientRect().left) <= 1
        && x.getBoundingClientRect().top <= h2.getBoundingClientRect().top + 8;
    })()`));
    const warningLine = await evalJs(`(() => {
      const warning = document.querySelector('#cloud-join-warning');
      const style = warning ? getComputedStyle(warning) : null;
      return {
        ok: Boolean(warning)
          && /加入后(?:切换到新忆云|仍需按提示切换)；当前忆云「忆云 1」归档保留。/.test(warning.textContent)
          && warning.getBoundingClientRect().height <= 22
          && style?.whiteSpace !== 'nowrap',
        text: warning?.textContent ?? '',
        height: warning?.getBoundingClientRect().height ?? 0,
        whiteSpace: style?.whiteSpace ?? '',
      };
    })()`);
    check('加入忆云提示（560px 桌面）单行：加入后切换 + 当前忆云归档保留', warningLine.ok, JSON.stringify(warningLine));
    await capture('e2a2-after-cloud-join-modal.jpg');
    await capture('u3-after-dialog-cloud-join.jpg');
    await capture('p8-cloud-join-desktop.jpg');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(150);
    const join390 = await evalJs(`(() => {
      const modal = document.querySelector('#cloud-join');
      const box = modal?.querySelector('.modal-box');
      const fields = modal?.querySelector('.cloud-join-fields');
      const inspect = modal?.querySelector('#cloud-join-inspect');
      const token = document.querySelector('#cloud-join-token');
      const name = document.querySelector('#cloud-join-name');
      if (!box || !fields || !inspect || !token || !name) return { ok: false };
      const x = modal.querySelector('.modal-head #cloud-join-x.modal-x');
      return {
        ok: true,
        singleColumn: !modal.querySelector('.cloud-join-side') && !modal.querySelector('.cloud-join-grid'),
        inspectHidden: inspect.hidden === true,
        fieldsStacked: name.getBoundingClientRect().top >= token.getBoundingClientRect().bottom - 1,
        tokenFirst: token.getBoundingClientRect().top < name.getBoundingClientRect().top,
        xVisible: Boolean(x) && x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().right <= window.innerWidth,
        noBoxOverflow: box.scrollWidth <= box.clientWidth + 1,
        noPageOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      };
    })()`);
    check('加入忆云 390px：单列字段 token→name + 无空预览侧栏 + 关闭 X 可见 + 弹框/页面无横向溢出',
      join390.ok && join390.singleColumn && join390.inspectHidden && join390.fieldsStacked
        && join390.tokenFirst && join390.xVisible
        && join390.noBoxOverflow && join390.noPageOverflow,
      JSON.stringify(join390));
    await capture('p8-cloud-join-390.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.clearDeviceMetricsOverride');
    await sleep(100);
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
    check('加入忆云错误态：只显示错误，不叠状态/结果；底部仍是取消 + 主操作', await evalJs(`(() => {
      const err = document.querySelector('#cloud-join-error');
      const steps = document.querySelector('#cloud-join-steps');
      const result = document.querySelector('#cloud-join-result');
      const actions = [...document.querySelectorAll('#cloud-join .modal-actions .btn')];
      return Boolean(err) && err.hidden === false
        && steps?.hidden === true && result?.hidden === true
        && actions.length === 2 && actions[0].hidden === false && actions[1].classList.contains('btn-primary');
    })()`));
    await evalJs('document.querySelector("#cloud-join-x").click()');
    check('E2-A2 加入弹层关闭 X：关闭并清空令牌',
      await waitFor('document.querySelector("#cloud-join")?.hidden === true && document.querySelector("#cloud-join-token")?.value === ""'));

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
          && box?.hidden === false
          && /根指纹/.test(box.textContent) && /邀请设备/.test(box.textContent)
          && /共享域/.test(box.textContent) && /有效期至/.test(box.textContent)
          && !document.querySelector('#cloud-join .cloud-join-side')
          && /切换到「忆云 1」/.test(document.querySelector('#cloud-join-submit')?.textContent ?? '');
      })()`, 20000));
    await capture('p8-cloud-join-inspect-desktop.jpg');
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
    // 延迟邀请请求，让骨架停留足够久以截图（截完立即恢复）。
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: false, latency: 2500, downloadThroughput: -1, uploadThroughput: -1 });
    const inviteOpen = await evalJs(`(() => {
      document.querySelector('#invite-device').click();
      const body = document.querySelector('#invite-body');
      const box = document.querySelector('#invite .modal-box');
      return {
        skeleton: Boolean(body?.querySelector('.invite-skeleton-qr')),
        lines: body?.querySelectorAll('.invite-skeleton-line').length ?? 0,
        height: box?.getBoundingClientRect().height ?? 0,
      };
    })()`);
    check('邀请首次打开：先出稳定骨架（QR 占位 + 多行占位），不是一行加载提示',
      inviteOpen.skeleton && inviteOpen.lines >= 4 && inviteOpen.height >= 300,
      JSON.stringify(inviteOpen));
    await capture('p6b-invite-skeleton-desktop.jpg');
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    check('邀请面板打开且渲染内容（令牌或未启用提示）', await waitFor('(() => { const b = document.querySelector("#invite-body"); return Boolean(b?.querySelector("[data-copy]")) || /加入服务未启用/.test(b?.textContent ?? ""); })()'));
    const inviteFinalHeight = await evalJs('document.querySelector("#invite .modal-box")?.getBoundingClientRect().height ?? 0');
    check('邀请首次打开：骨架 → 结果高度差 ≤12px（弹框无明显跳动）',
      Math.abs(inviteFinalHeight - inviteOpen.height) <= 12,
      `skeleton=${Math.round(inviteOpen.height)} result=${Math.round(inviteFinalHeight)}`);
    await capture('u3-after-dialog-invite.jpg');
    await capture('p6b-invite-desktop.jpg');
    check('E1 邀请单屏：令牌 + 二维码/降级 + 忆云身份 + TTL；无详情/端点编辑/CLI 命令', await evalJs(`(() => {
      const body = document.querySelector('#invite-body');
      if (!body) return false;
      const ttl = document.querySelector('#invite-ttl');
      const options = ttl ? [...ttl.options].map((o) => [o.value, o.textContent]) : [];
      const expected = [['300000','5 分钟'],['900000','15 分钟'],['1200000','20 分钟'],['7200000','2 小时'],['21600000','6 小时'],['43200000','12 小时'],['86400000','24 小时']];
      const tokenBlock = Boolean(body.querySelector('.invite-token-block [data-copy]'));
      const qr = Boolean(body.querySelector('.invite-qr .qr-img')) || /二维码不可用/.test(body.textContent);
      return body.querySelectorAll('details').length === 0
        && !body.querySelector('#invite-endpoint') && !/fleet join/.test(body.textContent)
        && !/join 端点|默认记忆域|订阅/.test(body.textContent)
        && !/对方已用过|新设备|当前令牌有效至|改档后点|令牌即入网权限|扫码即通|本忆云/.test(body.textContent)
        && tokenBlock && qr && /忆云 1/.test(body.textContent) && /根指纹/.test(body.textContent)
        && /扫码加入，或复制令牌发给对方。/.test(body.textContent)
        && /一次性 · 仅当面或可信局域网传递。/.test(body.textContent)
        && /至 (?:\\d{2}\\/\\d{2} )?\\d{2}:\\d{2}/.test(body.textContent)
        && Boolean(body.querySelector('.invite-layout .invite-qr'))
        && Boolean(body.querySelector('.invite-layout .invite-main'))
        && Boolean(document.querySelector('#invite .modal-head #invite-close.modal-x'))
        && !document.querySelector('#invite .modal-actions')
        && Boolean(ttl) && ttl.value === '900000' && JSON.stringify(options) === JSON.stringify(expected)
        && Boolean(document.querySelector('#invite-regenerate'));
    })()`));
    check('E1 邀请按钮层级：复制令牌唯一主操作；重新生成次级；关闭只留右上角 X', await evalJs(`(() => {
      const copy = document.querySelector('#invite-body .invite-token-block [data-copy]');
      const regen = document.querySelector('#invite-regenerate');
      const primary = [...document.querySelectorAll('#invite .btn-primary')];
      const box = document.querySelector('#invite .modal-box');
      return Boolean(copy) && copy.classList.contains('invite-copy')
        && copy.textContent.trim() === '复制令牌' && copy.classList.contains('btn-primary')
        && primary.length === 1 && primary[0] === copy
        && Boolean(regen) && !regen.classList.contains('btn-primary')
        && !regen.classList.contains('btn-crt') && regen.textContent.trim() === '重新生成'
        && !document.querySelector('#invite .modal-actions')
        && /^当前令牌至 (?:\\d{2}\\/\\d{2} )?\\d{2}:\\d{2}$/.test(document.querySelector('#invite-expiry')?.textContent ?? '')
        && Boolean(box) && box.scrollWidth <= box.clientWidth + 1
        && document.documentElement.scrollWidth <= window.innerWidth + 1;
    })()`));
    const crossDayExpiry = await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      const trigger = document.querySelector('#invite-ttl-trigger');
      const expiry = document.querySelector('#invite-expiry');
      const regen = document.querySelector('#invite-regenerate');
      select.value = '86400000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const label = expiry.textContent;
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      const sameRow = Math.abs(mid(trigger) - mid(expiry)) <= 2 && Math.abs(mid(trigger) - mid(regen)) <= 3;
      select.value = '900000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { label, restored: expiry.textContent, ttl: select.value, sameRow };
    })()`);
    check('E1 跨天到期：选 24 小时必须显示日期（MM/DD HH:mm），控件仍同排，恢复 15 分钟后回到当前令牌文案',
      /^重新生成后至 \d{2}\/\d{2} \d{2}:\d{2}$/.test(crossDayExpiry.label)
        && crossDayExpiry.sameRow
        && crossDayExpiry.ttl === '900000'
        && /^当前令牌至 /.test(crossDayExpiry.restored),
      crossDayExpiry.label);
    await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      select.value = '86400000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await capture('e1-invite-expiry-cross-day.jpg');
    await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      select.value = '900000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const inviteControls = await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      const trigger = document.querySelector('#invite-ttl-trigger');
      const expiry = document.querySelector('#invite-expiry');
      const regen = document.querySelector('#invite-regenerate');
      const box = document.querySelector('#invite .modal-box');
      if (!select || !trigger || !expiry || !regen) return { ok: false };
      const s = trigger.getBoundingClientRect();
      const e = expiry.getBoundingClientRect();
      const r = regen.getBoundingClientRect();
      const mid = (b) => b.top + b.height / 2;
      return {
        ok: Math.abs(mid(s) - mid(e)) <= 2 && Math.abs(mid(s) - mid(r)) <= 3 && e.right <= r.left
          && Math.round(box?.getBoundingClientRect().width ?? 0) === 560,
        boxWidth: box?.getBoundingClientRect().width ?? 0,
        select: [Math.round(s.left), Math.round(s.top), Math.round(s.width)],
        expiry: [Math.round(e.left), Math.round(e.top), Math.round(e.width)],
        regen: [Math.round(r.left), Math.round(r.top), Math.round(r.width)],
      };
    })()`);
    check('E1 邀请控件同排：有效期 / 到期时刻 / 重新生成在同一条线上（桌面 560px）', inviteControls.ok, JSON.stringify(inviteControls));
    const inviteDropdown = await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      const trigger = document.querySelector('#invite-ttl-trigger');
      const tokenBefore = document.querySelector('#invite-body [data-copy]')?.dataset.copy ?? '';
      trigger.click();
      const menu = document.querySelector('#invite-ttl-menu');
      const t = trigger.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      const opened = {
        hidden: menu.hidden,
        expanded: trigger.getAttribute('aria-expanded'),
        controls: trigger.getAttribute('aria-controls'),
        role: menu.getAttribute('role'),
        options: menu.querySelectorAll('[role=option]').length,
        selected: menu.querySelector('[role=option][aria-selected=true]')?.textContent.trim() ?? '',
        parentBody: menu.parentElement === document.body,
        fixed: getComputedStyle(menu).position === 'fixed',
        below: Math.abs(m.top - (t.bottom + 6)) <= 2,
        flipped: m.bottom <= t.top - 2,
        menuTop: m.top,
        triggerBottom: t.bottom,
        menuCount: document.querySelectorAll('#invite-ttl-menu').length,
        active: trigger.getAttribute('aria-activedescendant') === menu.querySelector('[role=option][aria-selected=true]')?.id,
        firstOption: menu.querySelector('[role=option]')?.textContent.trim() ?? '',
      };
      menu.querySelectorAll('[role=option]')[6].click();
      const after = {
        value: select.value,
        label: trigger.textContent.trim(),
        expiry: document.querySelector('#invite-expiry')?.textContent ?? '',
        closed: menu.hidden,
        expanded: trigger.getAttribute('aria-expanded'),
        focused: document.activeElement === trigger,
        tokenSame: (document.querySelector('#invite-body [data-copy]')?.dataset.copy ?? '') === tokenBefore,
      };
      select.value = '900000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { opened, after, triggerText: trigger.textContent.trim() };
    })()`);
    check('下拉框 · 邀请 TTL：trigger/listbox/fixed 定位/选中回写与 change/焦点回 trigger/不重发令牌',
      inviteDropdown.opened.hidden === false && inviteDropdown.opened.expanded === 'true'
        && inviteDropdown.opened.controls === 'invite-ttl-menu'
        && inviteDropdown.opened.role === 'listbox' && inviteDropdown.opened.options === 7
        && /15 分钟/.test(inviteDropdown.opened.selected)
        && inviteDropdown.opened.parentBody && inviteDropdown.opened.fixed
        && (inviteDropdown.opened.below || inviteDropdown.opened.flipped)
        && inviteDropdown.opened.active
        && inviteDropdown.after.value === '86400000'
        && /24 小时/.test(inviteDropdown.after.label)
        && /^重新生成后至 /.test(inviteDropdown.after.expiry)
        && inviteDropdown.after.closed && inviteDropdown.after.expanded === 'false'
        && inviteDropdown.after.focused && inviteDropdown.after.tokenSame
        && /15 分钟/.test(inviteDropdown.triggerText),
      JSON.stringify(inviteDropdown));
    const beforeTokenMeta = await evalJs(`(() => ({
      token: document.querySelector('#invite-body [data-copy]')?.dataset.copy ?? '',
      fingerprint: document.querySelector('#invite-token-fingerprint')?.textContent ?? '',
      shown: document.querySelector('#invite-body .invite-token-code')?.textContent ?? '',
      qr: document.querySelector('#invite-body .qr-img')?.src ?? '',
    }))()`);
    const beforeTtlToken = beforeTokenMeta.token;
    check('E1 令牌块可见短指纹：格式「令牌 #8位十六进制」；代码块只显示截断值',
      /^令牌 #[0-9a-f]{8}$/.test(beforeTokenMeta.fingerprint)
        && beforeTokenMeta.shown.length < beforeTokenMeta.token.length
        && beforeTokenMeta.shown.includes('…'),
      beforeTokenMeta.fingerprint);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(150);
    check('E1 邀请 ≤520：两栏上下堆叠（QR 在上、引导/令牌/TTL 在下）', await evalJs(`(() => {
      const qr = document.querySelector('.invite-layout .invite-qr');
      const main = document.querySelector('.invite-layout .invite-main');
      if (!qr || !main) return false;
      return main.getBoundingClientRect().top >= qr.getBoundingClientRect().bottom - 1;
    })()`));
    check('E1 邀请 ≤520：弹框与页面无横向溢出', await evalJs(`(() => {
      const box = document.querySelector('#invite .modal-box');
      return Boolean(box) && box.scrollWidth <= box.clientWidth + 1
        && document.documentElement.scrollWidth <= window.innerWidth + 1;
    })()`));
    const mobileCrossDay = await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      const trigger = document.querySelector('#invite-ttl-trigger');
      const regen = document.querySelector('#invite-regenerate');
      const expiry = document.querySelector('#invite-expiry');
      select.value = '86400000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      return {
        ok: Math.abs(mid(trigger) - mid(expiry)) <= 2 && Math.abs(mid(trigger) - mid(regen)) <= 3,
        label: expiry.textContent,
        rects: [trigger, expiry, regen].map((el) => {
          const r = el.getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width)];
        }),
      };
    })()`);
    check('E1 邀请 ≤520 跨天：日期文案出现且「重新生成」不换行', mobileCrossDay.ok,
      `${mobileCrossDay.label} ${JSON.stringify(mobileCrossDay.rects)}`);
    await capture('p6b-invite-390-cross-day.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      select.value = '900000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await capture('p6b-invite-390.jpg', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.clearDeviceMetricsOverride');
    await sleep(100);
    const ttlChanged = await evalJs(`(() => {
      const select = document.querySelector('#invite-ttl');
      const tokenBefore = document.querySelector('#invite-body [data-copy]')?.dataset.copy ?? '';
      const expiryText = (ts) => {
        const date = new Date(ts);
        const now = new Date();
        const sameDay = date.getFullYear() === now.getFullYear()
          && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
        const options = sameDay
          ? { hour: '2-digit', minute: '2-digit', hour12: false }
          : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
        return new Intl.DateTimeFormat('zh-CN', options).format(date);
      };
      const beforeExpected = '重新生成后至 ' + expiryText(Date.now() + 7200000);
      select.value = '7200000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const afterExpected = '重新生成后至 ' + expiryText(Date.now() + 7200000);
      const label = document.querySelector('#invite-expiry')?.textContent ?? '';
      return {
        label,
        expected: [beforeExpected, afterExpected],
        tokenBefore,
        tokenAfter: document.querySelector('#invite-body [data-copy]')?.dataset.copy ?? '',
        ttl: select.value,
        confirmOpen: document.querySelector('#modal')?.hidden === false,
      };
    })()`);
    check('E1 改档只更新「重新生成后至 now+2h」预估（跨天自动带日期）：旧 token 不变、不弹确认',
      ttlChanged.ttl === '7200000'
        && ttlChanged.expected.includes(ttlChanged.label)
        && ttlChanged.tokenAfter === ttlChanged.tokenBefore
        && ttlChanged.confirmOpen === false,
      JSON.stringify(ttlChanged.label));
    await sleep(900);
    check('E1 改档后等待仍不自动生成：旧 token 原样保留',
      await evalJs(`document.querySelector('#invite-body [data-copy]')?.dataset.copy === ${JSON.stringify(beforeTtlToken)}`));
    const regenBusy = await evalJs(`(() => {
      const box = document.querySelector('#invite .modal-box');
      const before = box.getBoundingClientRect().height;
      const button = document.querySelector('#invite-regenerate');
      button.click();
      const body = document.querySelector('#invite-body');
      return {
        before,
        after: box.getBoundingClientRect().height,
        busy: body.classList.contains('is-busy'),
        ariaBusy: body.getAttribute('aria-busy'),
        disabled: button.disabled,
        ttlDisabled: document.querySelector('#invite-ttl')?.disabled === true,
        ttlTriggerDisabled: document.querySelector('#invite-ttl-trigger')?.disabled === true,
        label: button.textContent,
        confirmOpen: document.querySelector('#modal')?.hidden === false,
      };
    })()`);
    check('E1 重新生成：无二次确认，点击即进入 is-busy/aria-busy + 按钮「正在更新…」',
      regenBusy.busy && regenBusy.ariaBusy === 'true' && regenBusy.disabled
        && regenBusy.ttlDisabled && regenBusy.ttlTriggerDisabled
        && regenBusy.label === '正在更新…' && regenBusy.confirmOpen === false
        && Math.abs(regenBusy.after - regenBusy.before) <= 12,
      `before=${Math.round(regenBusy.before)} after=${Math.round(regenBusy.after)}`);
    check('E1 重新生成：选中 2 小时后新令牌，选择保持（ttlMs 透传生效）',
      await waitFor(`(() => {
        const select = document.querySelector('#invite-ttl');
        const token = document.querySelector('#invite-body [data-copy]')?.dataset.copy ?? '';
        return select?.value === '7200000' && token.length > 0 && token !== ${JSON.stringify(beforeTtlToken)};
      })()`, 20000));
    const regenAfter = await evalJs(`(() => {
      const box = document.querySelector('#invite .modal-box');
      const body = document.querySelector('#invite-body');
      const token = document.querySelector('#invite-body [data-copy]')?.dataset.copy ?? '';
      return {
        height: box.getBoundingClientRect().height,
        busy: body.classList.contains('is-busy'),
        ariaBusy: body.getAttribute('aria-busy'),
        token,
        fingerprint: document.querySelector('#invite-token-fingerprint')?.textContent ?? '',
        shown: document.querySelector('#invite-body .invite-token-code')?.textContent ?? '',
        qr: document.querySelector('#invite-body .qr-img')?.src ?? '',
        toast: document.querySelector('#banner')?.textContent ?? '',
        expiry: document.querySelector('#invite-expiry')?.textContent ?? '',
        confirmOpen: document.querySelector('#modal')?.hidden === false,
      };
    })()`);
    check('E1 重新生成：成功后原地替换结果，高度差 ≤12px，无确认弹框',
      !regenAfter.busy && regenAfter.ariaBusy === null && regenAfter.confirmOpen === false
        && Math.abs(regenAfter.height - regenBusy.before) <= 12
        && regenAfter.token.length > 0,
      `before=${Math.round(regenBusy.before)} after=${Math.round(regenAfter.height)}`);
    check('E1 重新生成后指纹/蓝字/令牌都变：肉眼可确认旧令牌已失效（token 不同、指纹不同、蓝色 code 不同）',
      /^令牌 #[0-9a-f]{8}$/.test(regenAfter.fingerprint)
        && regenAfter.fingerprint !== beforeTokenMeta.fingerprint
        && regenAfter.token !== beforeTtlToken
        && regenAfter.shown !== beforeTokenMeta.shown
        && regenAfter.shown.includes(`#${regenAfter.fingerprint.slice(-8)}`),
      `${beforeTokenMeta.fingerprint} → ${regenAfter.fingerprint}`);
    check('E1 重新生成后到期时间跟随新令牌 TTL（2 小时）',
      /^当前令牌至 (?:\d{2}\/\d{2} )?\d{2}:\d{2}$/.test(regenAfter.expiry),
      regenAfter.expiry);
    check('E1 重新生成后二维码与 toast 同步：新二维码 +「已重新生成，旧令牌已失效」',
      Boolean(beforeTokenMeta.qr) && regenAfter.qr !== beforeTokenMeta.qr
        && /已重新生成，旧令牌已失效/.test(regenAfter.toast),
      regenAfter.toast);
    const tokenState = await (async () => {
      const { decodeJoinToken, readJoinNonceState } = await import('@mebular/fleet');
      const oldToken = decodeJoinToken(beforeTtlToken);
      const newToken = decodeJoinToken(regenAfter.token);
      const joinState = await readJoinNonceState(join(home, 'store.jsonl'));
      return {
        oldNonce: oldToken.nonce,
        newNonce: newToken.nonce,
        newExpiresAt: newToken.expiresAt,
        joinState,
      };
    })();
    const newExpiryLabel = `当前令牌至 ${(() => {
      const date = new Date(tokenState.newExpiresAt);
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
      return new Intl.DateTimeFormat('zh-CN', sameDay
        ? { hour: '2-digit', minute: '2-digit', hour12: false }
        : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    })()}`;
    const newTtlDistance = tokenState.newExpiresAt - Date.now();
    check('E1 重新生成后「当前令牌至」对应新令牌 2h 到期',
      regenAfter.expiry === newExpiryLabel
        && newTtlDistance > 7000000 && newTtlDistance < 7300000,
      `expiry=${regenAfter.expiry} distance=${Math.round(newTtlDistance / 60000)}min`);
    check('E1 重新生成后旧令牌服务端立即失效（active=新 nonce；旧 nonce 进 revoked）',
      tokenState.oldNonce !== tokenState.newNonce
        && tokenState.joinState.active === tokenState.newNonce
        && tokenState.joinState.revoked.includes(tokenState.oldNonce),
      `active=${tokenState.joinState.active?.slice(0, 8)}… revoked=${tokenState.joinState.revoked.length}`);
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
    check('E2-A2 邀请单屏：忆云名 + 根指纹（取 overview.cloud）', await evalJs(`(() => {
        const line = document.querySelector('#invite-cloud-identity');
        const body = document.querySelector('#invite-body')?.textContent ?? '';
        return Boolean(line) && /忆云 1/.test(line.textContent)
          && /sha256:[0-9a-f]{12}/.test(line.textContent)
          && !/本忆云/.test(line.textContent)
          && /扫码加入/.test(body);
      })()`));
    await capture('e2a2-after-invite-cloud-line.jpg');
    await capture('e1-after-invite-single-screen.jpg');
    check('E1 邀请卡：详情/端点/命令/默认域与订阅说明不再出现',
      await evalJs('(() => { const t = document.querySelector("#invite-body")?.textContent ?? ""; return !/join 端点|默认记忆域|新设备.*fleet join|订阅/.test(t) && /有效期/.test(t) && /重新生成/.test(t); })()'));
    await evalJs('document.querySelector("#invite .modal-head #invite-close").click()');
    check('E1 邀请右上角 X：关闭弹框；无底部「关闭」按钮',
      await waitFor('document.querySelector("#invite")?.hidden === true && !document.querySelector("#invite .modal-actions")'));

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
    // toast 只存活 2.5s（CI 慢时可能错过）；稳定断言是弹层关闭 + 下方审计行带 breakGlassKeyId。
    check('S4 正确恢复码 → 移出写入并关闭弹层',
      await waitFor('document.querySelector("#security-action")?.hidden === true', 20000));
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
          // P3：READY 下 #create-cloud 隐藏，只检查可见入口（设置/加入/邀请）
          const buttons = [...document.querySelectorAll('.topbar-actions .btn')].filter((el) => !el.hidden);
          const labels = [...document.querySelectorAll('.topbar-actions .btn-label')]
            .filter((el) => !el.closest('.btn')?.hidden);
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

    // i18n：语言行默认可见（不再依赖 ?i18n=1）；?lang= 打开英文并可在设置内切回中文（不 reload）
    await send('Page.navigate', { url: `${base}/console/` });
    check('i18n 默认入口：html lang=zh-CN（普通用户不被系统英文带入半翻译界面）',
      await waitFor(`document.documentElement?.lang === 'zh-CN' && document.documentElement?.dataset?.consoleReady === '1' && Boolean(document.querySelector('#open-settings')) && document.title.includes('Mebular')`, 30000));
    await evalJs('document.querySelector("#open-settings").click()');
    check('i18n 语言行默认可见：设置·常用专用单行控件、位于常驻运行之前', await waitFor(`(() => {
      const row = document.querySelector('#settings-language');
      const resident = document.querySelector('#settings-resident');
      const panel = document.querySelector('#settings-panel-common');
      const control = row?.querySelector('.settings-language-control');
      const select = row?.querySelector('select[data-language-select]');
      const trigger = row?.querySelector('#settings-language-select-trigger');
      return Boolean(row) && Boolean(resident) && panel?.hidden === false
        && row.parentElement === panel && row === panel.querySelector('.settings-language-row')
        && !row.classList.contains('asst-row') && !row.querySelector('.asst-name, .asst-sp')
        && Boolean(control) && control.querySelector('.crt-select > select[data-language-select]') === select
        && Boolean(trigger) && trigger.getAttribute('role') === 'combobox'
        && Boolean(control.querySelector('.settings-language-chevron'))
        && row.querySelectorAll('select[data-language-select]').length === 1
        && select.value === 'zh-CN'
        && getComputedStyle(select).appearance === 'none'
        && getComputedStyle(select).position === 'absolute'
        && select.getAttribute('aria-hidden') === 'true' && select.tabIndex === -1
        && row.getBoundingClientRect().top < resident.getBoundingClientRect().top;
    })()`));
    await capture('i18n-settings-language-default.jpg');
    const navsBeforeEnglish = cdp.events.filter((event) => event.method === 'Page.frameNavigated').length;
    await evalJs(`(() => {
      const t = document.querySelector('#settings-language-select-trigger');
      t.click();
      const menu = document.querySelector('#settings-language-select-menu');
      const options = [...document.querySelector('#settings-language-select').options];
      const index = options.findIndex((o) => o.value === 'en-US');
      menu.querySelectorAll('[role=option]')[index].click();
    })()`);
    check('i18n 默认语言行选择 English：html lang / 设置页就地切英文，无 reload', await waitFor(`(() => {
      const row = document.querySelector('#settings-language');
      return document.documentElement.lang === 'en-US'
        && document.querySelector('[data-language-select]')?.value === 'en-US'
        && /Language/.test(row?.textContent ?? '')
        && /General/.test(document.querySelector('[data-settings-tab=common]')?.textContent ?? '');
    })()`) && cdp.events.filter((event) => event.method === 'Page.frameNavigated').length === navsBeforeEnglish);
    await evalJs(`(() => { const s = document.querySelector('[data-language-select]'); s.value = 'zh-CN'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.documentElement.lang === 'zh-CN' && /语言/.test(document.querySelector('#settings-language')?.textContent ?? '')`);
    await evalJs('document.querySelector("#settings-close").click()');
    await send('Page.navigate', { url: `${base}/console/?i18n=1&lang=en-US` });
    check('i18n 深链：html lang=en-US + 顶栏/导航英文', await waitFor(`document.documentElement?.dataset?.consoleReady === '1' && document.documentElement?.lang === 'en-US' && document.querySelector('.brand')?.textContent.includes('Mebular') && /Star map/.test(document.querySelector('[data-view=map] .view-label')?.textContent ?? '')`));
    // B · 英文长文案：顶栏动作不产生第二行 / 不横向溢出（1440 / 1024 / 390 三档）。
    const topbarProbe = `(() => {
      const bar = document.querySelector('.topbar');
      const actions = document.querySelector('.topbar-actions');
      const visibleButtons = [...actions.querySelectorAll('.btn')].filter((el) => !el.hidden);
      const labels = visibleButtons.map((el) => el.querySelector('.btn-label')).filter(Boolean);
      const rect = (el) => el.getBoundingClientRect();
      const tops = visibleButtons.map((el) => Math.round(rect(el).top));
      const byId = (id) => document.querySelector('#' + id);
      const labelText = (id) => byId(id)?.querySelector('.btn-label')?.textContent.trim();
      return {
        lang: document.documentElement.lang,
        rows: new Set(tops).size,
        labelsDisplay: labels.length ? getComputedStyle(labels[0]).display : 'none',
        widths: visibleButtons.map((el) => Math.round(rect(el).width)),
        actionRight: Math.round(rect(actions).right),
        actionBottom: Math.round(rect(actions).bottom),
        barBottom: Math.round(rect(bar).bottom),
        barHeight: Math.round(rect(bar).height),
        overflow: bar.scrollWidth > bar.clientWidth + 1
          || document.documentElement.scrollWidth > window.innerWidth + 1,
        invite: { label: labelText('invite-device'), aria: byId('invite-device')?.getAttribute('aria-label'), title: byId('invite-device')?.getAttribute('title') },
        join: { label: labelText('join-cloud'), aria: byId('join-cloud')?.getAttribute('aria-label'), title: byId('join-cloud')?.getAttribute('title') },
        create: { label: labelText('create-cloud'), aria: byId('create-cloud')?.getAttribute('aria-label'), title: byId('create-cloud')?.getAttribute('title') },
      };
    })()`;
    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const topbar1440 = await evalJs(topbarProbe);
    check('i18n 顶栏 1440：英文动作同一行、无横向溢出、短标签 + 完整 aria/title',
      topbar1440.lang === 'en-US' && topbar1440.rows === 1
        && topbar1440.labelsDisplay !== 'none'
        && topbar1440.actionBottom <= topbar1440.barBottom
        && topbar1440.barHeight <= 60 && topbar1440.overflow === false
        && topbar1440.invite.label === 'Invite' && topbar1440.invite.aria === 'Invite device' && topbar1440.invite.title === 'Invite device'
        && topbar1440.join.label === 'Join' && topbar1440.join.aria === 'Join cloud' && topbar1440.join.title === 'Join cloud'
        && topbar1440.create.label === 'New' && topbar1440.create.aria === 'New cloud' && topbar1440.create.title === 'New cloud',
      JSON.stringify(topbar1440));
    await captureNow('i18n-en-topbar-1440.jpg');
    await setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    const topbar1024 = await evalJs(topbarProbe);
    check('i18n 顶栏 1024：英文更早折叠为图标，动作仍同一行、无第二行/横向溢出',
      topbar1024.rows === 1 && topbar1024.labelsDisplay === 'none'
        && topbar1024.widths.every((width) => Math.abs(width - 34) <= 2)
        && topbar1024.actionBottom <= topbar1024.barBottom
        && topbar1024.barHeight <= 60 && topbar1024.overflow === false,
      JSON.stringify(topbar1024));
    await captureNow('i18n-en-topbar-1024.jpg');
    await setViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const topbar390 = await evalJs(topbarProbe);
    check('i18n 顶栏 390：动作保持一行、图标等宽、无横向溢出',
      topbar390.rows === 1 && topbar390.labelsDisplay === 'none'
        && topbar390.widths.every((width) => Math.abs(width - 34) <= 2)
        && topbar390.overflow === false,
      JSON.stringify(topbar390));
    const nav390 = await evalJs(`(() => {
      const nav = document.querySelector('#view-nav');
      const labels = [...document.querySelectorAll('#view-nav .view-label')];
      return {
        labels: labels.map((el) => el.textContent.trim()),
        split: labels.some((el) => el.getBoundingClientRect().height > 18),
        navOverflow: Boolean(nav) && nav.scrollWidth > nav.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`);
    check('i18n 导航 390：英文标签整词显示（Star map 不拆行）+ 无横向溢出',
      nav390.labels.join(',') === 'Star map,Sharing,Memories,Audit'
        && nav390.split === false && nav390.navOverflow === false && nav390.pageOverflow === false,
      JSON.stringify(nav390));
    await captureNow('i18n-en-topbar-390.jpg');

    // B · 设置语言行：专用 wrapper + 固定 chevron，三档都保持单行。
    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalJs('document.querySelector("#open-settings").click()');
    await waitFor('document.querySelector("#settings")?.hidden === false && Boolean(document.querySelector("#settings-language"))');
    const languageProbe = `(() => {
      const row = document.querySelector('#settings-language');
      const resident = document.querySelector('#settings-resident');
      const panel = document.querySelector('#settings-panel-common');
      const control = row?.querySelector('.settings-language-control');
      const select = row?.querySelector('select[data-language-select]');
      const trigger = row?.querySelector('#settings-language-select-trigger');
      if (!row || !resident || !panel || !control || !select || !trigger) return { ok: false, why: 'missing' };
      const rowRect = row.getBoundingClientRect();
      const labelRect = row.querySelector('.settings-language-label').getBoundingClientRect();
      const controlRect = control.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const rowStyle = getComputedStyle(row);
      const selectStyle = getComputedStyle(select);
      const triggerStyle = getComputedStyle(trigger);
      trigger.focus();
      const focusShadow = getComputedStyle(trigger).boxShadow;
      trigger.blur();
      return {
        ok: true,
        lang: document.documentElement.lang,
        panelVisible: panel.hidden === false,
        dedicated: row.classList.contains('settings-language-row') && !row.classList.contains('asst-row')
          && !row.querySelector('.asst-name, .asst-sp'),
        wrapper: control.querySelector('.crt-select > select[data-language-select]') === select
          && Boolean(control.querySelector('.settings-language-chevron')),
        oneLine: Math.abs((labelRect.top + labelRect.height / 2) - (controlRect.top + controlRect.height / 2)) <= 1
          && rowRect.height <= 44,
        order: rowRect.top < resident.getBoundingClientRect().top,
        divider: rowStyle.borderBottomStyle === 'dashed' && parseFloat(rowStyle.borderBottomWidth) >= 1,
        appearance: selectStyle.appearance,
        nativeHidden: selectStyle.position === 'absolute' && select.getAttribute('aria-hidden') === 'true'
          && select.tabIndex === -1,
        triggerRole: trigger.getAttribute('role'),
        triggerHeight: Math.round(triggerRect.height),
        radius: triggerStyle.borderRadius,
        focusShadow,
        options: select.querySelectorAll('option').length,
        value: select.value,
        inRow: triggerRect.right <= rowRect.right + 1 && triggerRect.left >= rowRect.left - 1,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`;
    const language1440 = await evalJs(languageProbe);
    check('i18n 语言行 1440：专用控件、固定 chevron、单行、虚线分隔、焦点环',
      language1440.ok && language1440.lang === 'en-US' && language1440.panelVisible
        && language1440.dedicated && language1440.wrapper && language1440.oneLine
        && language1440.order && language1440.divider
        && language1440.appearance === 'none' && language1440.nativeHidden
        && language1440.triggerRole === 'combobox' && language1440.triggerHeight === 26
        && language1440.radius === '8px' && language1440.focusShadow !== 'none'
        && language1440.options === 2 && language1440.value === 'en-US'
        && language1440.inRow && language1440.overflow === false,
      JSON.stringify(language1440));
    await captureNow('i18n-en-language-1440.jpg');
    await setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    const language1024 = await evalJs(languageProbe);
    check('i18n 语言行 1024：仍为单行控件，无横向溢出',
      language1024.ok && language1024.oneLine && language1024.inRow && language1024.overflow === false,
      JSON.stringify(language1024));
    await captureNow('i18n-en-language-1024.jpg');
    await setViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const language390 = await evalJs(languageProbe);
    check('i18n 语言行 390：仍为单行控件，无横向溢出',
      language390.ok && language390.oneLine && language390.inRow && language390.overflow === false,
      JSON.stringify(language390));
    await captureNow('i18n-en-language-390.jpg');
    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // B · 设置深度页（常用 / 安全 / AI 助手 / MCP / 高级 / 诊断）：英文文案 + 无中文兜底。
    const settingsPanelsProbe = `(() => {
      const panel = (id) => document.querySelector('#settings-panel-' + id)?.innerText ?? '';
      const hasCjk = (text) => /[\\u3400-\\u9fff]/.test(text ?? '');
      const tabs = [...document.querySelectorAll('#settings-body .settings-tab:not(.settings-tab-extra)')].map((el) => el.textContent.trim());
      const extra = document.querySelector('#settings-body .settings-tab-extra')?.textContent.trim() ?? '';
      const out = { lang: document.documentElement.lang, tabs, extra, panels: {}, cjk: {}, open: {} };
      const full = {};
      for (const id of ['common', 'security', 'assistants', 'mcp', 'advanced']) {
        document.querySelector('[data-settings-tab=' + id + ']')?.click();
        const text = panel(id);
        full[id] = text;
        out.panels[id] = text.slice(0, 400);
        out.cjk[id] = hasCjk(text);
      }
      const fold = document.querySelector('#diag-fold');
      if (fold) fold.open = true;
      const diag = document.querySelector('#diag-fold')?.innerText ?? '';
      out.diag = diag.slice(0, 600);
      out.diagCjk = hasCjk(diag);
      out.has = {
        language: /Language/.test(full.common),
        commonStatus: /This device/.test(full.common),
        service: /Resident/.test(full.common),
        securitySections: /Security level/.test(full.security) && /Authenticator seed/.test(full.security) && /Recovery code/.test(full.security),
        assistants: /Add assistant/.test(full.assistants),
        mcp: /Connection/.test(full.mcp) && /TLS/.test(full.mcp) && /Risks and recovery/.test(full.mcp),
        advanced: /Resident service/.test(full.advanced) && /Network/.test(full.advanced) && /Automation/.test(full.advanced) && /Diagnostics and recovery/.test(full.advanced),
        diagnostics: /Version and service status/.test(diag) && /Recovery guide/.test(diag) && /Full configuration/.test(diag),
      };
      document.querySelector('[data-settings-tab=common]')?.click();
      return out;
    })()`;
    const settingsPanels = await evalJs(settingsPanelsProbe);
    check('i18n 设置深度页英文：五个页签 + 通用/安全/AI 助手/MCP/高级 段落文案全英文',
      settingsPanels.lang === 'en-US'
        && settingsPanels.tabs.join(',') === 'General,Security,Assistants,MCP,Advanced'
        && settingsPanels.extra === 'About device'
        && Object.values(settingsPanels.has).every(Boolean)
        && settingsPanels.cjk.security === false,
      JSON.stringify(settingsPanels));
    check('i18n 设置深度页英文：诊断与恢复折叠（版本/完整配置/恢复指引）无中文兜底',
      settingsPanels.has.diagnostics === true
        && !/恢复指引|完整配置|版本与服务状态|最近一次应用结果/.test(settingsPanels.diag ?? ''),
      JSON.stringify({ cjk: settingsPanels.diagCjk, sample: settingsPanels.diag?.slice(0, 200) }));
    await captureNow('i18n-en-settings-deep-1440.jpg');

    // 英文设置页签：每个标签必须单行（不被空格拆成两行），三档视口都不横向溢出。
    const settingsTabsProbe = `(() => {
      const tabs = [...document.querySelectorAll('#settings-body .settings-tab')];
      const container = document.querySelector('#settings-body .settings-tabs');
      if (!container || tabs.length === 0) return { ok: false, why: 'missing' };
      const box = container.getBoundingClientRect();
      return {
        ok: true,
        labels: tabs.map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            text: el.textContent.trim(),
            height: Math.round(rect.height),
            width: Math.round(rect.width),
            wrapped: rect.height > 32 || el.scrollWidth > el.clientWidth + 1,
            outside: rect.right > box.right + 1 || rect.left < box.left - 1,
          };
        }),
        rows: new Set(tabs.map((el) => Math.round(el.getBoundingClientRect().top))).size,
        containerOverflow: container.scrollWidth > container.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`;
    for (const [label, viewport] of [
      ['1440', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
      ['1024', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }],
      ['390', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }],
    ]) {
      await setViewport(viewport);
      const tabsLayout = await evalJs(settingsTabsProbe);
      check(`i18n 设置页签英文 ${label}：每个标签单行、页签条不溢出（1440/1024 同排）`,
        tabsLayout.ok
          && tabsLayout.labels.every((item) => item.wrapped === false && item.outside === false)
          && tabsLayout.containerOverflow === false && tabsLayout.pageOverflow === false
          && (label === '390' || tabsLayout.rows === 1),
        JSON.stringify(tabsLayout));
      await captureNow(`i18n-en-settings-tabs-${label}.jpg`);
    }
    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // 安全流程弹层：TOTP 导入弹层（标题/字段/占位/按钮/帮助全英文，无中文兜底）
    await evalJs(`(() => {
      document.querySelector('[data-settings-tab=security]')?.click();
      document.querySelector('[data-security-action=totp-import]')?.click();
    })()`);
    const securityDialogProbe = `(() => {
      const modal = document.querySelector('#security-action');
      if (!modal || modal.hidden) return { open: false };
      const body = modal.querySelector('#security-action-body');
      const values = [
        document.querySelector('#security-action-title')?.textContent,
        body?.innerText,
        document.querySelector('#security-action-close')?.textContent,
        document.querySelector('#security-action-confirm')?.textContent,
        body?.querySelector('textarea')?.placeholder,
      ];
      return {
        open: true,
        title: document.querySelector('#security-action-title')?.textContent.trim() ?? '',
        body: body?.innerText ?? '',
        placeholder: body?.querySelector('textarea')?.placeholder ?? '',
        close: document.querySelector('#security-action-close')?.textContent.trim() ?? '',
        confirm: document.querySelector('#security-action-confirm')?.textContent.trim() ?? '',
        cjk: values.some((value) => /[\\u3400-\\u9fff]/.test(value ?? '')),
      };
    })()`;
    const securityDialog = await (async () => {
      for (let i = 0; i < 20; i += 1) {
        const probe = await evalJs(securityDialogProbe);
        if (probe.open) return probe;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return evalJs(securityDialogProbe);
    })();
    check('i18n 安全流程弹层英文：TOTP 导入标题/字段/占位/按钮/帮助无中文兜底',
      securityDialog.open === true && securityDialog.cjk === false
        && securityDialog.title === 'Import authenticator seed'
        && /Seed \(grouped text \/ otpauth URI\)/.test(securityDialog.body)
        && /otpauth:\/\//.test(securityDialog.body) && !/<code>|<\/code>/.test(securityDialog.body)
        && /ABCD EFGH IJKL/.test(securityDialog.placeholder)
        && securityDialog.confirm === 'Import' && securityDialog.close === 'Close',
      JSON.stringify(securityDialog));
    await captureNow('i18n-en-security-dialog-1440.jpg');
    await evalJs('document.querySelector("#security-action-close")?.click()');
    await waitFor('document.querySelector("#security-action")?.hidden === true');

    // B · 英文设置页密度：1440 / 1024 / 390 三档无横向溢出，长文案块不撑破弹框。
    // 英文比中文长约 1.8×，只看页面 scrollWidth 会漏掉「弹框内部被长句撑开」；
    // 因此同时断言弹框 / 滚动区 / 页面，以及每个可见文案块自身 scrollWidth <= clientWidth。
    const settingsDensityProbe = `(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
      };
      const box = document.querySelector('#settings .modal-box');
      const scroller = document.querySelector('#settings .settings-scroll');
      const texts = [...document.querySelectorAll(
        '#settings .settings-section-desc, #settings .settings-section-foot, #settings .cfg-help, '
        + '#settings .settings-kv .kv-value, #settings .cloud-intro, #settings .settings-note',
      )].filter(visible);
      const overflow = texts
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => ({
          cls: String(el.className || ''),
          over: el.scrollWidth - el.clientWidth,
          text: (el.textContent || '').trim().slice(0, 48),
        }));
      const boxRight = box ? box.getBoundingClientRect().right : 0;
      const outside = texts.filter((el) => el.getBoundingClientRect().right > boxRight + 1).length;
      const scrollerRight = scroller ? scroller.getBoundingClientRect().right : 0;
      const offenders = scroller
        ? [...scroller.querySelectorAll('*')].filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              cls: String(el.className || '').slice(0, 60),
              over: el.scrollWidth - el.clientWidth,
              rightOver: Math.round(rect.right - scrollerRight),
              width: Math.round(rect.width),
            };
          })
          .filter((entry) => entry.rightOver > 1 || entry.over > 1)
          .slice(0, 10)
        : [];
      return {
        viewport: window.innerWidth,
        boxOver: box ? box.scrollWidth - box.clientWidth : null,
        scrollerOver: scroller ? scroller.scrollWidth - scroller.clientWidth : null,
        pageOver: document.documentElement.scrollWidth - window.innerWidth,
        outside,
        textCount: texts.length,
        overflow: overflow.slice(0, 6),
        offenders,
      };
    })()`;
    const densityViewports = [
      ['1440', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
      ['1024', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }],
      ['390', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }],
    ];
    await evalJs('document.querySelector("[data-settings-tab=common]")?.click()');
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      const density = await evalJs(settingsDensityProbe);
      check(`i18n 设置页密度 ${label}：弹框/滚动区/页面无横向溢出，文案块不越界`,
        density.boxOver <= 0 && density.scrollerOver <= 0 && density.pageOver <= 0
          && density.outside === 0 && density.overflow.length === 0,
        JSON.stringify(density));
      await captureNow(`i18n-en-settings-density-${label}.jpg`);
    }

    // 高级 → 诊断与恢复折叠：四条恢复指引（含命令/错误码）不得横向越界。
    await setViewport(densityViewports[0][1]);
    await evalJs('document.querySelector("[data-settings-tab=advanced]").click()');
    await waitFor('document.querySelector("#settings-panel-advanced")?.hidden === false');
    await evalJs('document.querySelector("#diag-fold").open = true');
    const recoveryDensityProbe = `(() => {
      const block = document.querySelector('#diag-fold [data-info-block=recovery]');
      const box = document.querySelector('#settings .modal-box');
      if (!block || !box) return { ok: false };
      const values = [...block.querySelectorAll('.kv-value')];
      const boxRight = box.getBoundingClientRect().right;
      return {
        ok: true,
        viewport: window.innerWidth,
        count: values.length,
        over: values.filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.scrollWidth - el.clientWidth),
        outside: values.filter((el) => el.getBoundingClientRect().right > boxRight + 1).length,
        lengths: values.map((el) => (el.textContent || '').trim().length),
        boxOver: box.scrollWidth - box.clientWidth,
        pageOver: document.documentElement.scrollWidth - window.innerWidth,
      };
    })()`;
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      await evalJs('document.querySelector("#diag-fold").scrollIntoView({ block: "start" })');
      const recovery = await evalJs(recoveryDensityProbe);
      check(`i18n 高级诊断/恢复折叠 ${label}：四条指引不横向越界`,
        recovery.ok && recovery.count === 4 && recovery.over.length === 0
          && recovery.outside === 0 && recovery.boxOver <= 0 && recovery.pageOver <= 0,
        JSON.stringify(recovery));
      await captureNow(`i18n-en-settings-recovery-${label}.jpg`);
    }
    await evalJs('document.querySelector("#diag-fold").open = false');

    // 文案预算：精简后仍保留恢复命令 / 错误码 / 环境变量，且段落已分行（不再是一整句 400+ 字符）。
    const enMessages = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'locales', 'en-US', 'console.json'), 'utf-8')).messages;
    const copyBudget = {
      'settings.diag.recovery.authBody': 430,
      'settings.diag.recovery.hostBody': 170,
      'settings.diag.recovery.certBody': 200,
      'settings.diag.recovery.consoleBody': 210,
      'settings.cloud.note': 150,
      'settings.restart.confirmBody': 160,
      'settings.security.boundary': 160,
      'settings.security.totp.foot': 140,
      'settings.write.confirmBody': 140,
    };
    const copyOver = Object.entries(copyBudget)
      .filter(([key, max]) => String(enMessages[key] ?? '').length > max)
      .map(([key, max]) => ({ key, length: String(enMessages[key] ?? '').length, max }));
    const authBody = String(enMessages['settings.diag.recovery.authBody'] ?? '');
    const authTokens = [
      'mebular token grant --scope memory.read,memory.admin',
      '401 invalid token',
      '/register',
      '404',
      'MEBULAR_OAUTH_ADMIN_SECRET',
      'MEBULAR_OAUTH_REGISTER_SECRET',
      'mcp.http.auth=none',
      'config.json',
      'mebular serve',
    ];
    const missingTokens = authTokens.filter((token) => !authBody.includes(token));
    check('i18n 英文设置长文案：恢复指引分行、超长段落已收短，命令/错误码/环境变量全部保留',
      copyOver.length === 0 && missingTokens.length === 0
        && (authBody.match(/<br>/g) ?? []).length >= 3
        && String(enMessages['settings.diag.recovery.consoleBody']).includes('MCP_STORAGE_LOCKED')
        && String(enMessages['settings.diag.recovery.certBody']).includes('MCP_INSECURE_CONFIG'),
      JSON.stringify({ copyOver, missingTokens, authLength: authBody.length }));

    // 安全弹层（TOTP 导入）：三档视口内不横向溢出，正文不越界。
    const securityDensityProbe = `(() => {
      const modal = document.querySelector('#security-action');
      const box = modal?.querySelector('.modal-box');
      if (!modal || modal.hidden || !box) return { open: false };
      const visible = (el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
      };
      const texts = [...box.querySelectorAll('p, li, label, .crt-warn')].filter(visible);
      const boxRight = box.getBoundingClientRect().right;
      return {
        open: true,
        viewport: window.innerWidth,
        boxOver: box.scrollWidth - box.clientWidth,
        pageOver: document.documentElement.scrollWidth - window.innerWidth,
        outside: texts.filter((el) => el.getBoundingClientRect().right > boxRight + 1).length,
        overflow: texts.filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => ({ cls: String(el.className || ''), over: el.scrollWidth - el.clientWidth })),
      };
    })()`;
    await evalJs('document.querySelector("[data-settings-tab=security]").click()');
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      await evalJs('document.querySelector("[data-security-action=totp-import]")?.click()');
      await waitFor('document.querySelector("#security-action")?.hidden === false');
      const securityDensity = await evalJs(securityDensityProbe);
      check(`i18n 安全弹层密度 ${label}：弹框与正文不横向越界`,
        securityDensity.open && securityDensity.boxOver <= 0 && securityDensity.pageOver <= 0
          && securityDensity.outside === 0 && securityDensity.overflow.length === 0,
        JSON.stringify(securityDensity));
      await captureNow(`i18n-en-settings-security-${label}.jpg`);
      await evalJs('document.querySelector("#security-action-close")?.click()');
      await waitFor('document.querySelector("#security-action")?.hidden === true');
    }
    await setViewport(densityViewports[0][1]);
    await evalJs('document.querySelector("[data-settings-tab=common]")?.click()');

    await evalJs('document.querySelector("#settings-close").click()');
    await waitFor('document.querySelector("#settings")?.hidden === true');

    // B · 邀请 / 加入弹框动作行：桌面同排，窄屏才允许 wrap；全程无横向溢出。
    const controlsProbe = `(() => {
      const modal = document.querySelector('#invite');
      const box = modal?.querySelector('.modal-box');
      const controls = modal?.querySelector('.invite-controls');
      const tops = controls ? [...controls.children].map((el) => Math.round(el.getBoundingClientRect().top)) : [];
      return {
        open: Boolean(modal) && modal.hidden === false && Boolean(controls),
        spread: tops.length ? Math.max(...tops) - Math.min(...tops) : 999,
        boxOverflow: Boolean(box) && box.scrollWidth > box.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`;
    await evalJs('document.querySelector("#invite-device").click()');
    check('i18n 邀请弹框打开（结果面板就位）',
      await waitFor('document.querySelector("#invite")?.hidden === false && Boolean(document.querySelector("#invite-body .invite-copy"))', 20000));
    const inviteCopyProbe = `(() => {
      const body = document.querySelector('#invite-body');
      const ttl = body?.querySelector('#invite-ttl');
      const label = body?.querySelector('.invite-label')?.textContent.trim() ?? '';
      const lead = body?.querySelector('.invite-lead')?.textContent.trim() ?? '';
      const safety = body?.querySelector('.invite-safety')?.textContent.trim() ?? '';
      const copy = body?.querySelector('.invite-copy');
      const ttlLabel = body?.querySelector('.invite-ttl .invite-label')?.textContent.trim() ?? '';
      const regen = body?.querySelector('#invite-regenerate')?.textContent.trim() ?? '';
      const options = [...(ttl?.options ?? [])].map((option) => option.textContent.trim());
      const values = [label, lead, safety, copy?.textContent, ttlLabel, regen, ...options];
      return {
        lang: document.documentElement.lang,
        title: document.querySelector('#invite h2')?.textContent.trim() ?? '',
        closeAria: document.querySelector('#invite-close')?.getAttribute('aria-label') ?? '',
        label, lead, safety,
        copyLabel: copy?.textContent.trim() ?? '',
        copyTitle: copy?.getAttribute('title') ?? '',
        ttlLabel,
        ttlOptions: options,
        expiry: body?.querySelector('#invite-expiry')?.textContent.trim() ?? '',
        regen,
        cjk: values.some((value) => /[\\u3400-\\u9fff]/.test(value ?? '')),
      };
    })()`;
    const inviteCopy = await evalJs(inviteCopyProbe);
    check('i18n 邀请英文文案：标题/引导/令牌/有效期/重新生成/安全提示无中文兜底',
      inviteCopy.lang === 'en-US' && inviteCopy.cjk === false
        && inviteCopy.title === 'Invite device' && inviteCopy.closeAria === 'Close Invite device'
        && inviteCopy.label === 'One-time token' && inviteCopy.lead === 'Scan to join, or copy the token.'
        && inviteCopy.copyLabel === 'Copy token' && inviteCopy.copyTitle === 'Copy full token'
        && /^One-time use ·/.test(inviteCopy.safety)
        && inviteCopy.ttlLabel === 'Valid'
        && inviteCopy.ttlOptions.join(',') === '5 min,15 min,20 min,2 h,6 h,12 h,24 h'
        && /^(Current|After regeneration): /.test(inviteCopy.expiry)
        && inviteCopy.regen === 'Renew',
      JSON.stringify(inviteCopy));
    const invite1440 = await evalJs(controlsProbe);
    check('i18n 邀请动作行 1440：有效期/到期时刻/重新生成同排，无横向溢出',
      invite1440.open && invite1440.spread <= 8 && invite1440.boxOverflow === false && invite1440.pageOverflow === false,
      JSON.stringify(invite1440));
    await captureNow('i18n-en-invite-1440.jpg');
    // 重新生成前后：令牌块左边界/宽度必须稳定（英文 Renew ↔ Updating… 按钮宽度变化不得推动布局）。
    const tokenRect = `(el) => {
      const rect = el.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.width), Math.round(rect.right)];
    }`;
    const inviteStabilityProbe = `(() => {
      const block = document.querySelector('#invite-body .invite-token-block');
      const controls = document.querySelector('#invite-body .invite-controls');
      const box = document.querySelector('#invite .modal-box');
      if (!block || !controls || !box) return { ok: false, why: 'missing' };
      return {
        ok: true,
        block: (${tokenRect})(block),
        controls: (${tokenRect})(controls),
        box: (${tokenRect})(box),
        boxOverflow: box.scrollWidth > box.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`;
    const inviteBeforeRenew = await evalJs(inviteStabilityProbe);
    await captureNow('i18n-en-invite-renew-before-1440.jpg');
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: false, latency: 1200, downloadThroughput: -1, uploadThroughput: -1 });
    await evalJs('document.querySelector("#invite-regenerate").click()');
    const inviteBusyRenew = await evalJs(`(() => {
      const probe = ${inviteStabilityProbe};
      const button = document.querySelector('#invite-regenerate');
      return {
        ...probe,
        label: button?.textContent.trim() ?? '',
        buttonWidth: button ? Math.round(button.getBoundingClientRect().width) : 0,
        busy: document.querySelector('#invite-body').classList.contains('is-busy'),
      };
    })()`);
    await captureNow('i18n-en-invite-renew-busy-1440.jpg');
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    check('i18n 邀请重新生成（英文）：按钮进入忙态且令牌块左边界/宽度不跳动',
      inviteBusyRenew.busy === true && inviteBusyRenew.label === 'Updating…'
        && Math.abs(inviteBusyRenew.block[0] - inviteBeforeRenew.block[0]) <= 1
        && Math.abs(inviteBusyRenew.block[1] - inviteBeforeRenew.block[1]) <= 1
        && inviteBusyRenew.boxOverflow === false && inviteBusyRenew.pageOverflow === false,
      JSON.stringify({ before: inviteBeforeRenew, busy: inviteBusyRenew }));
    check('i18n 邀请重新生成（英文）：成功后令牌块回到同一左边界/宽度',
      await waitFor('document.querySelector("#invite-body")?.classList.contains("is-busy") === false && Boolean(document.querySelector("#invite-body [data-copy]"))', 20000));
    const inviteAfterRenew = await evalJs(inviteStabilityProbe);
    check('i18n 邀请重新生成后布局稳定：令牌块左边界/宽度与忙态、生成前一致，弹框无横向滚动',
      Math.abs(inviteAfterRenew.block[0] - inviteBeforeRenew.block[0]) <= 1
        && Math.abs(inviteAfterRenew.block[1] - inviteBeforeRenew.block[1]) <= 1
        && Math.abs(inviteAfterRenew.controls[0] - inviteBeforeRenew.controls[0]) <= 1
        && inviteAfterRenew.boxOverflow === false && inviteAfterRenew.pageOverflow === false,
      JSON.stringify({ before: inviteBeforeRenew, after: inviteAfterRenew }));
    await captureNow('i18n-en-invite-renew-after-1440.jpg');
    await setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    const invite1024 = await evalJs(controlsProbe);
    check('i18n 邀请动作行 1024：同排且无横向溢出',
      invite1024.open && invite1024.spread <= 8 && invite1024.boxOverflow === false && invite1024.pageOverflow === false,
      JSON.stringify(invite1024));
    await captureNow('i18n-en-invite-1024.jpg');
    await setViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const invite390 = await evalJs(controlsProbe);
    check('i18n 邀请动作行 390：窄屏仍无横向溢出（同排或自然换行）',
      invite390.open && invite390.boxOverflow === false && invite390.pageOverflow === false,
      JSON.stringify(invite390));
    await captureNow('i18n-en-invite-390.jpg');
    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalJs('document.querySelector("#invite .modal-head #invite-close").click()');
    await waitFor('document.querySelector("#invite")?.hidden === true');

    // 自定义下拉框统一高度：按上下文实测 9 个 trigger 与相邻控件（设置输入/同排按钮）≤1px。
    const dropdownProbe = (pairs) => `(() => {
      const pick = (selector) => {
        const el = selector ? document.querySelector(selector) : null;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { height: rect.height, top: rect.top, width: rect.width };
      };
      const out = {};
      for (const [name, triggerSelector, referenceSelector] of ${JSON.stringify(pairs)}) {
        const trigger = pick(triggerSelector);
        const reference = pick(referenceSelector);
        out[name] = trigger ? {
          height: Math.round(trigger.height * 10) / 10,
          refHeight: reference ? Math.round(reference.height * 10) / 10 : null,
          sameRow: reference ? Math.abs((trigger.top + trigger.height / 2) - (reference.top + reference.height / 2)) <= 8 : null,
        } : null;
      }
      return out;
    })()`;
    const dropdownViewports = [
      ['1440', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
      ['1024', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }],
      ['390', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }],
    ];
    for (const [label, viewport] of dropdownViewports) {
      await setViewport(viewport);
      const measured = {};
      // 设置 · 常用：语言下拉（标准 26px；与同行标签基线对齐/不撑高行）
      await evalJs('document.querySelector("#open-settings").click()');
      await waitFor('document.querySelector("#settings")?.hidden === false && Boolean(document.querySelector("#settings-language-select-trigger"))');
      await evalJs('document.querySelector("[data-settings-tab=common]")?.click()');
      Object.assign(measured, await evalJs(dropdownProbe([['settingsLanguage', '#settings-language-select-trigger', null]])));
      await captureNow(`i18n-en-dropdown-settings-${label}.jpg`);
      // 设置 · MCP：auth 下拉 vs 同组 port 输入框
      await evalJs('document.querySelector("[data-settings-tab=mcp]")?.click()');
      await waitFor('Boolean(document.querySelector("#cfg-mcp-http-auth-trigger")) && Boolean(document.querySelector("#cfg-mcp-http-port"))');
      Object.assign(measured, await evalJs(dropdownProbe([
        ['mcpAuth', '#cfg-mcp-http-auth-trigger', '#cfg-mcp-http-port'],
      ])));
      await captureNow(`i18n-en-dropdown-mcp-${label}.jpg`);
      // 设置 · 助手：配置格式下拉 vs 同排配置文件路径输入框
      await evalJs('document.querySelector("[data-settings-tab=assistants]")?.click()');
      await waitFor('Boolean(document.querySelector("#asst-add"))');
      await evalJs('document.querySelector("#asst-add")?.click()');
      await waitFor('Boolean(document.querySelector("#asst-add-format-trigger")) && Boolean(document.querySelector("#asst-add-path"))');
      Object.assign(measured, await evalJs(dropdownProbe([
        ['assistantFormat', '#asst-add-format-trigger', '#asst-add-path'],
      ])));
      await captureNow(`i18n-en-dropdown-assistants-${label}.jpg`);
      await evalJs('document.querySelector("#asst-add-cancel")?.click()');
      await evalJs('document.querySelector("#settings-close").click()');
      await waitFor('document.querySelector("#settings")?.hidden === true');
      // 审计 4 个 filter vs 同排导出按钮（compact 32px）
      await evalJs('document.querySelector("[data-view=audit]").click()');
      await waitFor('document.querySelector("#audit-view")?.hidden === false && Boolean(document.querySelector("#audit-filter-action-trigger"))');
      Object.assign(measured, await evalJs(dropdownProbe([
        ['auditAction', '#audit-filter-action-trigger', '#audit-export'],
        ['auditDevice', '#audit-filter-device-trigger', '#audit-export'],
        ['auditNamespace', '#audit-filter-namespace-trigger', '#audit-export'],
        ['auditTime', '#audit-filter-time-trigger', '#audit-export'],
      ])));
      await captureNow(`i18n-en-dropdown-audit-${label}.jpg`);
      // 记忆 filter vs 同排刷新按钮（compact 32px）
      await evalJs('document.querySelector("[data-view=memories]").click()');
      await waitFor('document.querySelector("#memories-view")?.hidden === false && Boolean(document.querySelector("#mem-filter-namespace-trigger"))');
      Object.assign(measured, await evalJs(dropdownProbe([
        ['memFilter', '#mem-filter-namespace-trigger', '#mem-refresh'],
      ])));
      await captureNow(`i18n-en-dropdown-memories-${label}.jpg`);
      // 邀请 TTL vs 同排「重新生成」按钮（26px）
      await evalJs('document.querySelector("#invite-device").click()');
      await waitFor('document.querySelector("#invite")?.hidden === false && Boolean(document.querySelector("#invite-ttl-trigger"))', 20000);
      Object.assign(measured, await evalJs(dropdownProbe([
        ['inviteTtl', '#invite-ttl-trigger', '#invite-regenerate'],
      ])));
      await captureNow(`i18n-en-dropdown-invite-${label}.jpg`);
      await evalJs('document.querySelector("#invite .modal-head #invite-close").click()');
      await waitFor('document.querySelector("#invite")?.hidden === true');
      await evalJs('document.querySelector("[data-view=map]").click()');

      const expected = {
        settingsLanguage: 26,
        mcpAuth: 26,
        assistantFormat: 26,
        auditAction: 32,
        auditDevice: 32,
        auditNamespace: 32,
        auditTime: 32,
        memFilter: 32,
        inviteTtl: 26,
      };
      const offenders = Object.entries(expected).filter(([name, height]) => {
        const item = measured[name];
        return !item || Math.abs(item.height - height) > 1
          || (item.refHeight !== null && Math.abs(item.height - item.refHeight) > 1);
      });
      check(`i18n 下拉高度统一 ${label}：9 个控件命中标准/紧凑档，且与相邻输入框/按钮 ≤1px`,
        offenders.length === 0,
        JSON.stringify({ offenders: offenders.map(([name]) => name), measured }));
    }
    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const joinActionsProbe = `(() => {
      const modal = document.querySelector('#cloud-join');
      const box = modal?.querySelector('.modal-box');
      const actions = [...(modal?.querySelectorAll('.modal-actions .btn') ?? [])];
      const tops = actions.map((el) => Math.round(el.getBoundingClientRect().top));
      return {
        open: Boolean(modal) && modal.hidden === false && actions.length === 2,
        rows: new Set(tops).size,
        rowsCount: actions.length,
        actionRight: actions.length ? Math.round(Math.max(...actions.map((el) => el.getBoundingClientRect().right))) : 0,
        boxOverflow: Boolean(box) && box.scrollWidth > box.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        viewport: window.innerWidth,
      };
    })()`;
    await evalJs('document.querySelector("#join-cloud").click()');
    check('i18n 加入弹框打开（底部动作行就位）',
      await waitFor('document.querySelector("#cloud-join")?.hidden === false && document.querySelectorAll("#cloud-join .modal-actions .btn").length === 2'));
    const joinCopyProbe = `(() => {
      const modal = document.querySelector('#cloud-join');
      const labels = [...(modal?.querySelectorAll('.cloud-join-fields .field label') ?? [])].map((el) => el.textContent.trim());
      const placeholders = [...(modal?.querySelectorAll('.cloud-join-fields input, .cloud-join-fields textarea') ?? [])].map((el) => el.placeholder);
      const values = [
        document.querySelector('#cloud-join-title')?.textContent,
        document.querySelector('.cloud-join-lead')?.textContent,
        ...labels, ...placeholders,
        document.querySelector('#cloud-join-close')?.textContent,
        document.querySelector('#cloud-join-submit')?.textContent,
      ];
      return {
        lang: document.documentElement.lang,
        title: document.querySelector('#cloud-join-title')?.textContent.trim() ?? '',
        lead: modal?.querySelector('.cloud-join-lead')?.textContent.trim() ?? '',
        labels, placeholders,
        warning: document.querySelector('#cloud-join-warning')?.textContent.trim() ?? '',
        cancel: document.querySelector('#cloud-join-close')?.textContent.trim() ?? '',
        submit: document.querySelector('#cloud-join-submit')?.textContent.trim() ?? '',
        closeAria: document.querySelector('#cloud-join-x')?.getAttribute('aria-label') ?? '',
        cjk: values.some((value) => /[\\u3400-\\u9fff]/.test(value ?? '')),
      };
    })()`;
    const joinCopy = await evalJs(joinCopyProbe);
    check('i18n 加入英文文案：标题/说明/字段/占位/按钮无中文兜底',
      joinCopy.lang === 'en-US' && joinCopy.cjk === false
        && joinCopy.title === 'Join cloud'
        && /^Paste the one-time token/.test(joinCopy.lead)
        && joinCopy.labels.join('|') === 'Join token|Cloud name'
        && joinCopy.placeholders[0] === 'Paste the token text (or the text from the QR code)…'
        && /^After joining, (this console switches|follow the prompt to switch)/.test(joinCopy.warning)
        && joinCopy.cancel === 'Cancel' && joinCopy.submit === 'Join cloud'
        && joinCopy.closeAria === 'Close Join cloud',
      JSON.stringify(joinCopy));
    const i18nJoin1440 = await evalJs(joinActionsProbe);
    check('i18n 加入动作行 1440：取消 + 加入同排、无横向溢出',
      i18nJoin1440.open && i18nJoin1440.rows === 1 && i18nJoin1440.actionRight <= i18nJoin1440.viewport + 1
        && i18nJoin1440.boxOverflow === false && i18nJoin1440.pageOverflow === false,
      JSON.stringify(i18nJoin1440));
    await captureNow('i18n-en-join-1440.jpg');
    await setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    const i18nJoin1024 = await evalJs(joinActionsProbe);
    check('i18n 加入动作行 1024：仍同排、无横向溢出',
      i18nJoin1024.open && i18nJoin1024.rows === 1 && i18nJoin1024.actionRight <= i18nJoin1024.viewport + 1
        && i18nJoin1024.boxOverflow === false && i18nJoin1024.pageOverflow === false,
      JSON.stringify(i18nJoin1024));
    await captureNow('i18n-en-join-1024.jpg');
    await setViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const i18nJoin390 = await evalJs(joinActionsProbe);
    check('i18n 加入动作行 390：窄屏允许 wrap，但无横向溢出',
      i18nJoin390.open && i18nJoin390.rows <= 2 && i18nJoin390.actionRight <= i18nJoin390.viewport + 1
        && i18nJoin390.boxOverflow === false && i18nJoin390.pageOverflow === false,
      JSON.stringify(i18nJoin390));
    await captureNow('i18n-en-join-390.jpg');
    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalJs('document.querySelector("#cloud-join-x").click()');
    await waitFor('document.querySelector("#cloud-join")?.hidden === true');

    // B · 数据面英文密度（#181）：about / domains / handoff / memories / audit / 设备卡。
    // 英文长句 + 长命令不得把面板或弹层撑出横向滚动；三档视口逐一面板断言。
    const surfaceProbe = (rootSel, textSel) => `(() => {
      const root = document.querySelector(${JSON.stringify(rootSel)});
      const visible = (el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
      };
      if (!root || root.hidden) return { ok: false, lang: document.documentElement.lang, viewport: window.innerWidth };
      const texts = [...root.querySelectorAll(${JSON.stringify(textSel)})].filter(visible);
      const overflow = texts.filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => ({ cls: String(el.className || '').slice(0, 60), over: el.scrollWidth - el.clientWidth }));
      return {
        ok: true,
        lang: document.documentElement.lang,
        viewport: window.innerWidth,
        rootOver: root.scrollWidth - root.clientWidth,
        pageOver: document.documentElement.scrollWidth - window.innerWidth,
        outside: texts.filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length,
        textCount: texts.length,
        overflow: overflow.slice(0, 6),
      };
    })()`;
    const surfaceOk = (report) => report.ok && report.lang === 'en-US'
      && report.rootOver <= 0 && report.pageOver <= 0
      && report.outside === 0 && report.overflow.length === 0;
    const surfaceText = async (selector) => (await evalJs(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)) ?? '';

    // about：长说明（task plane / runtime / paths / tools）与命令
    await send('Page.navigate', { url: `${base}/console/?lang=en-US` });
    await waitFor('document.documentElement?.dataset?.consoleReady === "1" && document.querySelector("#open-settings") !== null');
    await evalJs('document.querySelector("#open-settings").click()');
    await waitFor('document.querySelector("#settings")?.hidden === false && Boolean(document.querySelector("[data-settings-extra=about-modal]"))');
    await evalJs('document.querySelector("[data-settings-extra=about-modal]").click()');
    await waitFor('document.querySelector("#about")?.hidden === false && document.querySelectorAll("#about-body .settings-section").length >= 4');
    // 运行状态/路径/任务面/工具都在「运行状态」折叠内；展开后再测长文案。
    await evalJs('document.querySelector("#about-runtime-fold").open = true');
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      const about = await evalJs(surfaceProbe('#about', '#about-body p, #about-body dd, #about-body .chip-wrap'));
      const aboutText = await surfaceText('#about-body');
      check(`i18n 数据面 about ${label}：长说明/命令不横向越界`,
        surfaceOk(about)
          && /Task plane, not a memory domain/.test(aboutText)
          && /Set at runtime: relay pool/.test(aboutText)
          && /Paths come from the core address book/.test(aboutText)
          && /Agents call the same handlers over MCP/.test(aboutText),
        JSON.stringify({ ...about, sample: aboutText.slice(0, 120) }));
      await captureNow(`i18n-en-data-about-${label}.jpg`);
    }
    await setViewport(densityViewports[0][1]);
    await evalJs('document.querySelector("#about-close").click()');
    await waitFor('document.querySelector("#about")?.hidden === true');
    await evalJs('document.querySelector("#settings-close").click()');
    await waitFor('document.querySelector("#settings")?.hidden === true');

    // domains：面板说明 + 域卡 / 详情行
    await send('Page.navigate', { url: `${base}/console/?lang=en-US` });
    await waitFor('document.documentElement?.dataset?.consoleReady === "1" && document.querySelector("#domains-view") !== null');
    await evalJs('document.querySelector("#view-nav li:nth-of-type(2) button").click()');
    await waitFor('document.querySelector("#domains-view")?.hidden === false && /Who you share with/.test(document.querySelector("#domains-note")?.textContent ?? "")');
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      const domains = await evalJs(surfaceProbe('#domains-view', '#domains-note, .domain-card, .domain-row, .readout-head, .relation, .subscribe-note, .share-hint, .danger-zone .hint'));
      check(`i18n 数据面 domains ${label}：面板/域卡长文案不横向越界`,
        surfaceOk(domains), JSON.stringify(domains));
      await captureNow(`i18n-en-data-domains-${label}.jpg`);
    }

    // handoff：长说明（281 字符）+ 不可逆警告，三档弹层内不越界
    await setViewport(densityViewports[0][1]);
    await evalJs('document.querySelector("#domains-list [data-sector]")?.click()');
    await waitFor('Boolean(document.querySelector("#domain-detail [data-handoff]"))');
    await evalJs('document.querySelector("#domain-detail [data-handoff]").click()');
    await waitFor('document.querySelector("#handoff")?.hidden === false');
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      const handoff = await evalJs(surfaceProbe('#handoff', '#handoff-desc, #handoff .modal-note, #handoff .modal-actions'));
      const handoffText = await surfaceText('#handoff-desc');
      check(`i18n 数据面 handoff ${label}：长说明/警告不横向越界`,
        surfaceOk(handoff)
          && /Leave and hand off/.test(handoffText)
          && /The successor must ack everything first/.test(handoffText),
        JSON.stringify(handoff));
      await captureNow(`i18n-en-data-handoff-${label}.jpg`);
    }
    await setViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evalJs('document.querySelector("#handoff-close")?.click()');
    await waitFor('document.querySelector("#handoff")?.hidden === true');

    // memories：说明 + 行预览 + 删除确认（含“旧快照不可回收”警告）
    await setViewport(densityViewports[0][1]);
    await send('Page.navigate', { url: `${base}/console/?lang=en-US` });
    await waitFor('document.documentElement?.dataset?.consoleReady === "1" && document.querySelector("#memories-view") !== null');
    await evalJs('document.querySelector("#view-nav li:nth-of-type(3) button").click()');
    await waitFor('document.querySelector("#memories-view")?.hidden === false && document.querySelectorAll("#memories-list .mem-row").length >= 1');
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      const memories = await evalJs(surfaceProbe('#memories-view', '.panel-note, .mem-row, .mem-preview, .mem-meta, .mem-actions'));
      const memoriesText = await surfaceText('#memories-view .panel-note');
      check(`i18n 数据面 memories ${label}：说明/行内容不横向越界`,
        surfaceOk(memories) && /Archive/.test(memoriesText) && /irreversible/.test(memoriesText),
        JSON.stringify(memories));
      await captureNow(`i18n-en-data-memories-${label}.jpg`);
    }
    await evalJs('document.querySelector("#memories-list [data-mem-action=delete]")?.click()');
    await waitFor('document.querySelector("#modal")?.hidden === false');
    const deleteDensity = await evalJs(surfaceProbe('#modal', '#modal-body, #modal-title, #modal .modal-actions'));
    const deleteText = await surfaceText('#modal-body');
    check('i18n 数据面删除确认 390：长警告不横向越界',
      surfaceOk(deleteDensity)
        && /Synced tombstone|tombstone/.test(deleteText)
        && /Snapshots already copied by peers cannot be reclaimed/.test(deleteText),
      JSON.stringify({ ...deleteDensity, sample: deleteText.slice(0, 120) }));
    await captureNow('i18n-en-data-delete-390.jpg');
    await evalJs('document.querySelector("#modal-cancel").click()');
    await waitFor('document.querySelector("#modal")?.hidden === true');

    // audit：长事件行（会签/恢复码/移交/移出）三档不越界
    await setViewport(densityViewports[0][1]);
    await evalJs('document.querySelector("#view-nav li:nth-of-type(4) button").click()');
    await waitFor('document.querySelector("#audit-view")?.hidden === false && document.querySelectorAll("#audit-view .audit-item").length >= 1');
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      const audit = await evalJs(surfaceProbe('#audit-view', '.audit-item, .audit-detail, .audit-toolbar'));
      check(`i18n 数据面 audit ${label}：长事件文案不横向越界`,
        surfaceOk(audit), JSON.stringify(audit));
      await captureNow(`i18n-en-data-audit-${label}.jpg`);
    }

    // device card：移除说明 / 本机说明 / 长路径三档不越界
    await setViewport(densityViewports[0][1]);
    await send('Page.navigate', { url: `${base}/console/?lang=en-US&select=device-C` });
    await waitFor('document.documentElement?.dataset?.consoleReady === "1" && document.querySelector("#device-card-body") && document.querySelector("#device-card-body").hidden === false');
    for (const [label, viewport] of densityViewports) {
      await setViewport(viewport);
      const card = await evalJs(surfaceProbe('#device-card', '#device-card-body, .card-help, .path-value, .chip-list li, .kv dd'));
      const cardText = label === '1440' ? await surfaceText('#device-card') : 'This device was removed';
      check(`i18n 数据面 device card ${label}：长说明/路径不横向越界`,
        surfaceOk(card) && /This device was removed/.test(cardText),
        JSON.stringify(card));
      await captureNow(`i18n-en-data-device-card-${label}.jpg`);
    }

    // #181 数据面文案预算：长句已收短，但 DAG / tombstone / epoch / 命令与占位符全部保留。
    const dataCopyBudget = {
      'about.fleet.note': 250,
      'about.statusOnly.desc': 190,
      'about.paths.note': 180,
      'about.tools.note': 190,
      'about.runtime.listenAlarm': 160,
      'about.syncRate.note': 150,
      'handoff.desc': 240,
      'handoff.descStatic': 240,
      'handoff.confirmBody': 165,
      'domains.note': 180,
      'domains.rejoin.confirmBody': 200,
      'domains.unsubscribeSome.body': 190,
      'domains.task.note': 180,
      'memories.delete.body': 180,
      'deviceCard.help.blocked': 175,
      'deviceCard.mine.help': 160,
      'deviceCard.reset.body': 150,
      'audit.event.handoff': 140,
      'audit.event.revoke': 135,
    };
    const dataOver = Object.entries(dataCopyBudget)
      .filter(([key, max]) => String(enMessages[key] ?? '').length > max)
      .map(([key, max]) => ({ key, length: String(enMessages[key] ?? '').length, max }));
    const dataTokens = [
      ['about.fleet.note', ['fleet.config.json', 'DAG']],
      ['handoff.descStatic', ['__policy__', 'watermark', 'ack']],
      ['handoff.confirmBody', ['{namespace}', '{successor}', 'irreversible']],
      ['domains.rejoin.confirmBody', ['{namespace}', 'watermark']],
      ['domains.unsubscribeSome.body', ['{namespace}', '{count}', 'default to unsubscribed']],
      ['memories.delete.body', ['{id}', 'tombstone', 'cannot be reclaimed']],
      ['deviceCard.reset.body', ['{device}', 'watermark']],
      ['audit.event.revoke', ['{issuer}', '{subject}', '{extra}']],
    ];
    const dataMissing = dataTokens.flatMap(([key, tokens]) => tokens
      .filter((token) => !String(enMessages[key] ?? '').includes(token))
      .map((token) => `${key}:${token}`));
    check('i18n 英文数据面长文案：预算内且保留 DAG/墓碑/水位/占位符/危险警告',
      dataOver.length === 0 && dataMissing.length === 0,
      JSON.stringify({ dataOver, dataMissing }));

    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${base}/console/?lang=en-US` });
    await waitFor('document.documentElement?.dataset?.consoleReady === "1" && document.querySelector("#open-settings") !== null');
    await evalJs('document.querySelector("#open-settings").click()');
    check('i18n 语言行：设置·常用单行 + 位于常驻运行之前 + 虚线分隔', await waitFor(`(() => {
      const row = document.querySelector('#settings-language');
      const resident = document.querySelector('#settings-resident');
      const panel = document.querySelector('#settings-panel-common');
      if (!row || !resident || !panel) return false;
      const s = getComputedStyle(row);
      return panel.hidden === false && row.parentElement === panel
        && row === panel.querySelector('.settings-language-row')
        && !row.classList.contains('asst-row')
        && Boolean(row.querySelector('.settings-language-control .crt-select > select[data-language-select]'))
        && Boolean(row.querySelector('#settings-language-select-trigger[role=combobox]'))
        && Boolean(row.querySelector('.settings-language-control .settings-language-chevron'))
        && row.querySelectorAll('select[data-language-select]').length === 1
        && row.querySelectorAll('option').length === 2
        && row.querySelector('select').value === 'en-US'
        && getComputedStyle(row.querySelector('select')).appearance === 'none'
        && row.getBoundingClientRect().top < resident.getBoundingClientRect().top
        && parseFloat(s.borderBottomWidth) >= 1;
    })()`));
    const navsBeforeLocale = cdp.events.filter((event) => event.method === 'Page.frameNavigated').length;
    await evalJs(`(() => { const s = document.querySelector('[data-language-select]'); s.value = 'zh-CN'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    check('i18n 选择即重渲染：中文行/页签/顶栏就地切换，无 reload', await waitFor(`(() => {
      const row = document.querySelector('#settings-language');
      return document.documentElement.lang === 'zh-CN'
        && /Mebular/.test(document.querySelector('.brand')?.textContent ?? '')
        && document.querySelector('[data-language-select]')?.value === 'zh-CN'
        && row !== null
        && /常用/.test(document.querySelector('[data-settings-tab=common]')?.textContent ?? '');
    })()`));
    const navsAfterLocale = cdp.events.filter((event) => event.method === 'Page.frameNavigated').length;
    check('i18n 无 reload 证据：导航次数不变', navsAfterLocale === navsBeforeLocale, `navigations=${navsBeforeLocale}→${navsAfterLocale}`);
    await evalJs('document.querySelector("#settings-close").click()');
    await clearViewport();
    await send('Page.navigate', { url: `${base}/console/` });
    await waitFor('document.querySelector("#settings")?.hidden === true');

    // 下拉框三档截图：语言 / 邀请 TTL / 审计筛选 / 记忆筛选 / 助手格式（打开态，无横向溢出）。
    for (const [name, viewport] of [
      ['1440', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
      ['1024', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }],
      ['390', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }],
    ]) {
      await send('Page.navigate', { url: `${base}/console/` });
      await waitFor('document.documentElement?.dataset?.consoleReady === "1" && document.querySelector("#memories-list") !== null', 20000);
      await setViewport(viewport);
      const probeOpen = (triggerSelector, menuSelector) => evalJs(`(() => {
        const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
        const menu = document.querySelector(${JSON.stringify(menuSelector)});
        if (!trigger || !menu) return { open: false };
        trigger.click();
        const r = menu.getBoundingClientRect();
        const t = trigger.getBoundingClientRect();
        return {
          open: menu.hidden === false,
          role: menu.getAttribute('role'),
          placed: Math.abs(r.top - (t.bottom + 6)) <= 2 || r.bottom <= t.top - 2,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1
            || r.left < -1 || r.right > window.innerWidth + 1,
        };
      })()`);
      const closeMenu = (triggerSelector) => evalJs(`document.querySelector(${JSON.stringify(triggerSelector)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

      await evalJs('document.querySelector("#open-settings").click()');
      await waitFor('document.querySelector("#settings")?.hidden === false && Boolean(document.querySelector("#settings-language"))');
      const languageMenu = await probeOpen('#settings-language-select-trigger', '#settings-language-select-menu');
      await captureNow(`dropdown-language-${name}.jpg`);
      await closeMenu('#settings-language-select-trigger');
      await evalJs('document.querySelector("#settings-close").click()');

      await evalJs('document.querySelector("#invite-device").click()');
      await waitFor('document.querySelector("#invite")?.hidden === false && Boolean(document.querySelector("#invite-body .invite-copy"))', 20000);
      const inviteMenu = await probeOpen('#invite-ttl-trigger', '#invite-ttl-menu');
      await captureNow(`dropdown-invite-ttl-${name}.jpg`);
      await closeMenu('#invite-ttl-trigger');
      await evalJs('document.querySelector("#invite .modal-head #invite-close").click()');

      await evalJs('document.querySelector("#view-nav li:nth-of-type(4) button").click()');
      await waitFor('document.querySelector("#audit-view")?.hidden === false && Boolean(document.querySelector("#audit-filter-action-trigger"))');
      const auditMenu = await probeOpen('#audit-filter-action-trigger', '#audit-filter-action-menu');
      await captureNow(`dropdown-audit-filter-${name}.jpg`);
      await closeMenu('#audit-filter-action-trigger');

      await evalJs('document.querySelector("#view-nav li:nth-of-type(3) button").click()');
      await waitFor('document.querySelector("#memories-view")?.hidden === false && Boolean(document.querySelector("#mem-filter-namespace-trigger"))');
      const memoryMenu = await probeOpen('#mem-filter-namespace-trigger', '#mem-filter-namespace-menu');
      await captureNow(`dropdown-memory-filter-${name}.jpg`);
      await closeMenu('#mem-filter-namespace-trigger');

      await evalJs('document.querySelector("#open-settings").click()');
      await waitFor('document.querySelector("#settings")?.hidden === false');
      await evalJs('document.querySelector("[data-settings-tab=assistants]").click()');
      await waitFor('Boolean(document.querySelector("#asst-add"))');
      await evalJs('document.querySelector("#asst-add").click()');
      await waitFor('Boolean(document.querySelector("#asst-add-format-trigger"))');
      const assistantMenu = await probeOpen('#asst-add-format-trigger', '#asst-add-format-menu');
      await captureNow(`dropdown-assistant-format-${name}.jpg`);
      await closeMenu('#asst-add-format-trigger');
      await evalJs('document.querySelector("#settings-close").click()');

      const states = { languageMenu, inviteMenu, auditMenu, memoryMenu, assistantMenu };
      check(`下拉框截图 ${name}：语言/邀请/审计/记忆/助手格式菜单均可打开且无横向溢出`,
        Object.values(states).every((state) => state.open === true && state.role === 'listbox' && state.placed === true && state.overflow === false),
        JSON.stringify(states));
    }
    await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${base}/console/` });
    await waitFor('document.documentElement?.dataset?.consoleReady === "1"');

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
    // ---------- P3：锁定主控制台 → 新建/加入同页解锁（无 reload / 无 restart） ----------
    {
      const onboardHome = await mkdtemp(join(tmpdir(), 'mebular-ui-onboard-'));
      const onboardPort = await freePort();
      const onboardHandle = spawnServe(onboardHome, onboardPort);
      const joinHome = await mkdtemp(join(tmpdir(), 'mebular-ui-join-'));
      const joinPort = await freePort();
      let joinHandle = null;
      try {
        const obReady = await waitReady(onboardHandle);
        const obBase = `http://127.0.0.1:${obReady.port}`;

        // —— 英文锁定态：顶栏 / 导航 / 横幅 / coach / 新建 / 加入（1440 / 1024 / 390）——
        const lockedLayoutProbe = `(() => {
          const actions = document.querySelector('.topbar-actions');
          const buttons = [...actions.querySelectorAll('.btn')].filter((el) => !el.hidden);
          const tops = buttons.map((el) => Math.round(el.getBoundingClientRect().top));
          return {
            rows: new Set(tops).size,
            overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
            labelsHidden: buttons.every((el) => getComputedStyle(el.querySelector('.btn-label')).display === 'none'),
          };
        })()`;
        const modalLayoutProbe = `((id) => {
          const modal = document.querySelector('#' + id);
          const box = modal?.querySelector('.modal-box');
          if (!modal || !box || modal.hidden) return { open: false };
          const r = box.getBoundingClientRect();
          return {
            open: true,
            boxOverflow: box.scrollWidth > box.clientWidth + 1,
            pageOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
            inViewport: r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
          };
        })`;

        await send('Page.navigate', { url: `${obBase}/console/?lang=en-US` });
        check('i18n 锁定英文：顶栏/导航/横幅/状态词全英文，无中文兜底', await waitFor(`(() => {
          const app = document.querySelector('#app');
          const text = app?.innerText ?? '';
          const navTitles = [...document.querySelectorAll('#view-nav .view-btn[aria-disabled="true"]')].map((el) => el.title);
          const create = document.querySelector('#create-cloud');
          const join = document.querySelector('#join-cloud');
          return document.documentElement.lang === 'en-US'
            && app?.dataset.locked === 'true'
            && create?.getAttribute('aria-label') === 'New cloud'
            && join?.getAttribute('aria-label') === 'Join cloud'
            && create?.querySelector('.btn-label')?.textContent.trim() === 'New'
            && join?.querySelector('.btn-label')?.textContent.trim() === 'Join'
            && /Device · Not initialized/.test(document.querySelector('#self-badge')?.textContent ?? '')
            && /Not initialized/.test(document.querySelector('#online-badge')?.textContent ?? '')
            && /Memories —/.test(document.querySelector('#memory-badge')?.textContent ?? '')
            && /Security: —/.test(document.querySelector('#security-badge')?.textContent ?? '')
            && navTitles.length === 3 && navTitles.every((title) => title === 'Available after you create or join a cloud')
            && /Cloud not initialized/.test(document.querySelector('#banner')?.textContent ?? '')
            && !/[\\u3400-\\u9fff]/.test(text);
        })()`));
        check('i18n 锁定英文：coach 文案英文且指向两个入口', await waitFor(`(() => {
          const coach = document.querySelector('#onboarding-coach');
          const text = coach?.innerText ?? '';
          return Boolean(coach) && coach.hidden === false
            && /Create a cloud or join an existing one/.test(text)
            && /New cloud/.test(text) && /Join cloud/.test(text) && /Got it/.test(text)
            && !/[\\u3400-\\u9fff]/.test(text)
            && coach.getAttribute('aria-live') === 'polite';
        })()`));
        await capture('i18n-en-coach-1440.jpg');
        await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        const locked1440 = await evalJs(lockedLayoutProbe);
        check('i18n 锁定英文 1440：动作同排、无横向溢出',
          locked1440.rows === 1 && locked1440.overflow === true && locked1440.labelsHidden === false,
          JSON.stringify(locked1440));
        await captureNow('i18n-en-locked-1440.jpg');
        await setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
        const locked1024 = await evalJs(lockedLayoutProbe);
        check('i18n 锁定英文 1024：动作同排且折叠为图标、无横向溢出',
          locked1024.rows === 1 && locked1024.overflow === true && locked1024.labelsHidden === true,
          JSON.stringify(locked1024));
        await captureNow('i18n-en-locked-1024.jpg');
        await setViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await send('Page.navigate', { url: `${obBase}/console/?lang=en-US&coach=auto` });
        check('i18n 锁定英文 390：coach 在视口内、无横向溢出', await waitFor(`(() => {
          const coach = document.querySelector('#onboarding-coach');
          if (!coach || coach.hidden || !coach.classList.contains('is-visible')) return false;
          const r = coach.getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth + 1
            && r.top >= document.querySelector('.topbar').getBoundingClientRect().bottom
            && !/[\\u3400-\\u9fff]/.test(coach.innerText)
            && document.documentElement.scrollWidth <= window.innerWidth + 1;
        })()`));
        await captureNow('i18n-en-coach-390.jpg');
        await captureNow('i18n-en-locked-390.jpg');
        await clearViewport();

        await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: `${obBase}/console/?lang=en-US` });
        await waitFor('document.querySelector("#app")?.dataset.locked === "true"');
        await evalJs('document.querySelector("#create-cloud").click()');
        const createCopyProbe = `(() => {
          const modal = document.querySelector('#onboard-create');
          const labels = [...(modal?.querySelectorAll('.field label') ?? [])].map((el) => el.textContent.trim());
          const inputs = [...(modal?.querySelectorAll('input') ?? [])];
          return {
            open: Boolean(modal) && modal.hidden === false,
            title: document.querySelector('#onboard-create-title')?.textContent.trim() ?? '',
            desc: modal?.querySelector('.modal-note')?.textContent.trim() ?? '',
            labels,
            placeholders: inputs.map((el) => el.placeholder),
            cloudValue: inputs[0]?.value ?? '',
            cancel: document.querySelector('#onboard-create-cancel')?.textContent.trim() ?? '',
            submit: document.querySelector('#onboard-create-submit')?.textContent.trim() ?? '',
            closeAria: document.querySelector('#onboard-create-close')?.getAttribute('aria-label') ?? '',
            cjk: /[\\u3400-\\u9fff]/.test(modal?.innerText ?? ''),
          };
        })()`;
        const createCopy = await evalJs(createCopyProbe);
        check('i18n 锁定英文：新建弹框标题/标签/说明/按钮/默认名全英文',
          createCopy.open && createCopy.cjk === false
            && /New cloud/.test(createCopy.title) && /This device is root/.test(createCopy.title)
            && /^Generates the root master key/.test(createCopy.desc)
            && createCopy.labels.join('|') === 'Cloud name|Device name'
            && createCopy.placeholders[0] === 'Cloud 1' && createCopy.placeholders[1] === 'e.g. MacBookPro'
            && /^Cloud \d+$/.test(createCopy.cloudValue)
            && createCopy.cancel === 'Cancel' && createCopy.submit === 'Create cloud'
            && createCopy.closeAria === 'Close New cloud',
          JSON.stringify(createCopy));
        const create1440 = await evalJs(`${modalLayoutProbe}('onboard-create')`);
        check('i18n 锁定英文新建 1440：弹框在视口内、无横向溢出',
          create1440.open && create1440.boxOverflow === false && create1440.pageOverflow === true && create1440.inViewport === true,
          JSON.stringify(create1440));
        await captureNow('i18n-en-onboard-create-1440.jpg');
        await setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
        const create1024 = await evalJs(`${modalLayoutProbe}('onboard-create')`);
        check('i18n 锁定英文新建 1024：无横向溢出',
          create1024.open && create1024.boxOverflow === false && create1024.pageOverflow === true,
          JSON.stringify(create1024));
        await setViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const create390 = await evalJs(`${modalLayoutProbe}('onboard-create')`);
        check('i18n 锁定英文新建 390：弹框在视口内、无横向溢出',
          create390.open && create390.boxOverflow === false && create390.pageOverflow === true && create390.inViewport === true,
          JSON.stringify(create390));
        await captureNow('i18n-en-onboard-create-390.jpg');
        await clearViewport();
        await setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await evalJs('document.querySelector("#onboard-create-cancel").click()');
        await waitFor('document.querySelector("#onboard-create")?.hidden === true');
        await evalJs('document.querySelector("#join-cloud").click()');
        const joinOnboardCopyProbe = `(() => {
          const modal = document.querySelector('#onboard-join');
          const labels = [...(modal?.querySelectorAll('.field label') ?? [])].map((el) => el.textContent.trim());
          const fields = [...(modal?.querySelectorAll('input, textarea') ?? [])];
          return {
            open: Boolean(modal) && modal.hidden === false,
            title: document.querySelector('#onboard-join-title')?.textContent.trim() ?? '',
            lead: modal?.querySelector('.modal-note')?.textContent.trim() ?? '',
            labels,
            placeholders: fields.map((el) => el.placeholder),
            cancel: document.querySelector('#onboard-join-cancel')?.textContent.trim() ?? '',
            submit: document.querySelector('#onboard-join-submit')?.textContent.trim() ?? '',
            closeAria: document.querySelector('#onboard-join-close')?.getAttribute('aria-label') ?? '',
            cjk: /[\\u3400-\\u9fff]/.test(modal?.innerText ?? ''),
          };
        })()`;
        const joinOnboardCopy = await evalJs(joinOnboardCopyProbe);
        check('i18n 锁定英文：加入弹框标题/说明/必填/字段/按钮全英文',
          joinOnboardCopy.open && joinOnboardCopy.cjk === false
            && joinOnboardCopy.title === 'Join cloud'
            && /^Paste the one-time token/.test(joinOnboardCopy.lead)
            && joinOnboardCopy.labels.length === 2
            && /Device name/.test(joinOnboardCopy.labels[0]) && /Required/.test(joinOnboardCopy.labels[0])
            && /Join token/.test(joinOnboardCopy.labels[1]) && /Required/.test(joinOnboardCopy.labels[1])
            && joinOnboardCopy.placeholders[0] === 'e.g. MacBookPro'
            && joinOnboardCopy.placeholders[1] === 'Paste the token text (or the text from the QR code)…'
            && joinOnboardCopy.cancel === 'Cancel' && joinOnboardCopy.submit === 'Join cloud'
            && joinOnboardCopy.closeAria === 'Close Join cloud',
          JSON.stringify(joinOnboardCopy));
        const joinOnboard1440 = await evalJs(`${modalLayoutProbe}('onboard-join')`);
        check('i18n 锁定英文加入 1440：弹框在视口内、无横向溢出',
          joinOnboard1440.open && joinOnboard1440.boxOverflow === false && joinOnboard1440.pageOverflow === true && joinOnboard1440.inViewport === true,
          JSON.stringify(joinOnboard1440));
        await captureNow('i18n-en-onboard-join-1440.jpg');
        await setViewport({ width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
        const joinOnboard1024 = await evalJs(`${modalLayoutProbe}('onboard-join')`);
        check('i18n 锁定英文加入 1024：无横向溢出',
          joinOnboard1024.open && joinOnboard1024.boxOverflow === false && joinOnboard1024.pageOverflow === true,
          JSON.stringify(joinOnboard1024));
        await setViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const joinOnboard390 = await evalJs(`${modalLayoutProbe}('onboard-join')`);
        check('i18n 锁定英文加入 390：弹框在视口内、无横向溢出',
          joinOnboard390.open && joinOnboard390.boxOverflow === false && joinOnboard390.pageOverflow === true && joinOnboard390.inViewport === true,
          JSON.stringify(joinOnboard390));
        await captureNow('i18n-en-onboard-join-390.jpg');
        await clearViewport();
        await evalJs('document.querySelector("#onboard-join-cancel").click()');

        await send('Page.navigate', { url: `${obBase}/console/` });

        // —— 锁定态：主控制台 + 星图 + 导航/卡片禁用 + toast ——
        check('P3 锁定态：主控制台可见（不再用 #provision 遮罩整个 app）', await waitFor(`(() => {
          const app = document.querySelector('#app');
          return Boolean(app) && app.hidden === false && app.dataset.locked === 'true'
            && document.body.classList.contains('is-locked')
            && !document.querySelector('#provision');
        })()`));
        check('P6A 锁定态：星图保留背景，并渲染 ghost 本机地球仪', await waitFor(`(() => {
          const c = document.querySelector('#stage');
          if (!c || c.width <= 0 || c.height <= 0 || c.dataset.scene !== 'locked-ghost') return false;
          const ctx = c.getContext('2d');
          const size = Math.max(40, Math.min(100, Math.floor(c.width * 0.16)));
          const x = Math.floor(c.width / 2 - size / 2);
          const y = Math.floor(c.height / 2 - size / 2);
          const data = ctx.getImageData(x, y, size, size).data;
          let green = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 8 && data[i + 1] > data[i] && data[i + 1] > 60) green += 1;
          }
          return green > 20;
        })()`, 6000));
        check('P3 顶栏：新建忆云替换邀请设备；加入忆云始终显示', await evalJs(`(() => {
          const create = document.querySelector('#create-cloud');
          const invite = document.querySelector('#invite-device');
          const join = document.querySelector('#join-cloud');
          return Boolean(create) && create.hidden === false && /新建忆云/.test(create.textContent)
            && Boolean(invite) && invite.hidden === true
            && Boolean(join) && join.hidden === false && /加入忆云/.test(join.textContent);
        })()`));
        check('P3 锁定导航：共享/记忆/审计 aria-disabled + 星图可用', await evalJs(`(() => {
          const buttons = [...document.querySelectorAll('#view-nav .view-btn')];
          const map = buttons.find((b) => b.dataset.view === 'map');
          const others = buttons.filter((b) => b.dataset.view !== 'map');
          return others.every((b) => b.getAttribute('aria-disabled') === 'true' && b.classList.contains('is-locked'))
            && map.getAttribute('aria-disabled') === null;
        })()`));
        check('P6A 锁定态：设备卡/侧栏整卡退场（不展示占位卡）', await evalJs(`(() => {
          const aside = document.querySelector('.aside');
          const card = document.querySelector('#device-card');
          if (!aside || !card) return false;
          const rect = card.getBoundingClientRect();
          return aside.hidden === true && getComputedStyle(aside).display === 'none'
            && rect.width === 0 && rect.height === 0;
        })()`));
        check('P3 锁定态不请求 admin 数据面（overview/devices/settings 等 409 接口）', await evalJs(`(() => {
          const names = performance.getEntriesByType('resource').map((e) => e.name);
          return !names.some((n) => /\\/admin\\/api\\/(overview|devices|policy|namespaces|settings|config|memories|service|security|clouds)/.test(n));
        })()`));
        check('P3 锁定状态条只显示「未初始化」真值', await evalJs(`(() => {
          const online = document.querySelector('#online-badge')?.textContent ?? '';
          const mem = document.querySelector('#memory-badge')?.textContent ?? '';
          return /未初始化/.test(online) && /记忆 —/.test(mem) && document.querySelector('#status-pill')?.hidden === true;
        })()`));

        // 设置 = 锁定态排错入口（不白屏）
        await evalJs('document.querySelector("#open-settings").click()');
        check('P3 锁定设置：不白屏，给出锁定说明 + 两个入口 + 诊断信息', await waitFor(`(() => {
          const body = document.querySelector('#settings-body');
          return /忆云尚未初始化/.test(body?.textContent ?? '')
            && Boolean(body.querySelector('[data-locked-action="create"]'))
            && Boolean(body.querySelector('[data-locked-action="join"]'))
            && /诊断信息/.test(body.textContent);
        })()`));
        await evalJs('document.querySelector("#settings-close").click()');

        // 禁用导航 → toast（不切视图）
        await evalJs('document.querySelector("#view-nav [data-view=domains]").click()');
        check('P3 点击禁用导航 → toast「请先新建或加入忆云」且不切视图', await waitFor(`(() => {
          const banner = document.querySelector('#banner');
          return document.querySelector('#domains-view')?.hidden === true
            && /请先新建或加入忆云/.test(banner?.textContent ?? '');
        })()`));
        // 星图 ghost 地球仪 → toast
        await evalJs(`(() => {
          const c = document.querySelector('#stage');
          const r = c.getBoundingClientRect();
          c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        })()`);
        check('P6A 点击 ghost 本机地球仪 → toast「请先新建或加入忆云」', await waitFor('/请先新建或加入忆云/.test(document.querySelector("#banner")?.textContent ?? "")'));

        // 引导遮罩：非阻塞、指向两个入口、不盖按钮；ESC 关闭；再次打开自动淡出
        check('P3 引导遮罩：无 current 时出现且指向两个入口（不盖顶栏按钮）', await waitFor(`(() => {
          const coach = document.querySelector('#onboarding-coach');
          if (!coach || coach.hidden || !coach.classList.contains('is-visible')) return false;
          const bar = document.querySelector('.topbar').getBoundingClientRect();
          const create = document.querySelector('#create-cloud').getBoundingClientRect();
          const join = document.querySelector('#join-cloud').getBoundingClientRect();
          const c = coach.getBoundingClientRect();
          return /新建忆云/.test(coach.textContent) && /加入忆云/.test(coach.textContent)
            && c.top >= Math.max(bar.bottom, create.bottom, join.bottom)
            && coach.getAttribute('aria-live') === 'polite';
        })()`));
        await capture('p3-locked-console.jpg');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        check('P3 引导遮罩：ESC 可提前关闭', await waitFor('document.querySelector("#onboarding-coach")?.hidden === true', 3000));
        await capture('p6a-locked-ghost.jpg');
        await send('Page.navigate', { url: `${obBase}/console/?coach=auto` });
        check('P3 引导遮罩：再次打开 App 会显示（每次打开一次）',
          await waitFor('document.querySelector("#onboarding-coach")?.hidden === false'));
        check('P3 引导遮罩：数秒自动淡出（不阻塞）',
          await waitFor('document.querySelector("#onboarding-coach")?.hidden === true', 9000));

        // 窄屏：锁定壳与引导卡可用、无横向溢出
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await send('Page.navigate', { url: `${obBase}/console/?locked=narrow` });
        await waitFor('document.querySelector("#app")?.dataset.locked === "true"');
        check('P3 窄屏：锁定壳无横向溢出 + 新建/加入入口可用 + 设备卡退场', await evalJs(`(() => {
          const create = document.querySelector('#create-cloud');
          const join = document.querySelector('#join-cloud');
          return document.documentElement.scrollWidth <= window.innerWidth + 1
            && Boolean(create) && create.hidden === false && create.getBoundingClientRect().width > 0
            && Boolean(join) && join.hidden === false
            && document.querySelector('.aside')?.hidden === true;
        })()`));
        check('P3 窄屏：引导卡在视口内且不盖顶栏按钮', await waitFor(`(() => {
          const coach = document.querySelector('#onboarding-coach');
          if (!coach || coach.hidden || !coach.classList.contains('is-visible')) return false;
          const r = coach.getBoundingClientRect();
          const bar = document.querySelector('.topbar').getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= bar.bottom;
        })()`));
        await send('Emulation.clearDeviceMetricsOverride');
        await send('Page.navigate', { url: `${obBase}/console/` });
        await waitFor('document.querySelector("#app")?.dataset.locked === "true"');

        // —— 新建：默认名/设备名 → API 校验失败内联 → 成功同页解锁 ——
        await evalJs('window.__p3PageToken = "create-same-page"');
        const navsBeforeCreate = cdp.events.filter((event) => event.method === 'Page.frameNavigated').length;
        await evalJs('document.querySelector("#create-cloud").click()');
        check('P3 新建弹框：忆云名 + 设备名（默认 忆云 N / hostname；复用 modal-center/head/x）', await waitFor(`(() => {
          const modal = document.querySelector('#onboard-create');
          const cloud = document.querySelector('#onboard-create-cloud');
          const device = document.querySelector('#onboard-create-device');
          return Boolean(modal) && modal.hidden === false && modal.classList.contains('modal-center')
            && Boolean(modal.querySelector('.modal-head')) && Boolean(modal.querySelector('.modal-x'))
            && /^忆云 \\d+$/.test(cloud?.value ?? '') && (device?.value ?? '').length > 0;
        })()`));
        await evalJs(`(() => {
          const input = document.querySelector('#onboard-create-cloud');
          input.value = 'bad/name';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#onboard-create-submit').click();
        })()`);
        check('P3 新建名称校验走 P1 API：失败内联错误且保持锁定', await waitFor(`(() => {
          const err = document.querySelector('#onboard-create-error');
          return Boolean(err) && err.hidden === false && /不能包含/.test(err.textContent)
            && document.body.classList.contains('is-locked')
            && document.querySelector('#onboard-create')?.hidden === false;
        })()`, 20000));
        await evalJs(`(() => {
          const cloud = document.querySelector('#onboard-create-cloud');
          cloud.value = 'P3 测试忆云';
          cloud.dispatchEvent(new Event('input', { bubbles: true }));
          const device = document.querySelector('#onboard-create-device');
          device.value = 'p3-create-device';
          device.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#onboard-create-submit').click();
        })()`);
        check('P3 新建成功 → 同页解锁（无 reload / 无 restart / 遮罩消失）', await waitFor(`(() => {
          const app = document.querySelector('#app');
          return Boolean(app) && app.dataset.locked === undefined
            && document.body.classList.contains('is-locked') === false
            && document.querySelector('#onboard-create').hidden === true
            && document.querySelector('#onboarding-coach').hidden === true
            && document.querySelector('#invite-device').hidden === false
            && document.querySelector('#create-cloud').hidden === true
            && document.querySelectorAll('#view-nav .view-btn[aria-disabled="true"]').length === 0
            && window.__p3PageToken === 'create-same-page';
        })()`, 30000));
        check('P3 解锁后：记忆徽标/状态条取真实数据，设备卡恢复可交互', await waitFor(`(() => {
          const mem = document.querySelector('#memory-badge')?.textContent ?? '';
          return /记忆 \\d+/.test(mem)
            && document.querySelector('#status-pill')?.hidden === false
            && document.querySelector('#device-card')?.getAttribute('aria-disabled') === null;
        })()`, 20000));
        check('P6A READY 后：ghost 地球仪消失、星图恢复正常场景、设备卡归位', await waitFor(`(() => {
          const stage = document.querySelector('#stage');
          const aside = document.querySelector('.aside');
          const card = document.querySelector('#device-card');
          if (!stage || !aside || !card) return false;
          const rect = aside.getBoundingClientRect();
          return stage.dataset.scene === 'ready'
            && stage.getAttribute('aria-label') === '对端关系星图（本机视角）'
            && aside.hidden === false && getComputedStyle(aside).display !== 'none'
            && rect.width > 0;
        })()`, 20000));
        const navsAfterCreate = cdp.events.filter((event) => event.method === 'Page.frameNavigated').length;
        check('P3 无 reload 证据：页面实例/导航次数不变（create）', navsAfterCreate === navsBeforeCreate,
          `navigations=${navsBeforeCreate}→${navsAfterCreate}`);
        const stAfter = await (await fetch(`${obBase}/app/provision/status`)).status;
        const ovAfter = await fetch(`${obBase}/admin/api/overview`);
        check('P3 create 同进程/同端口：引导接口消失 + admin 200 + 进程存活',
          stAfter === 404 && ovAfter.status === 200 && onboardHandle.proc.exitCode === null,
          `status=${stAfter} overview=${ovAfter.status}`);
        await capture('p3-unlocked-console.jpg');
        await capture('p6a-ready-console.jpg');

        // —— 加入：用 create 实例邀请 → 新空 home 同页解锁 ——
        const joinToken = await evalJs(`(async () => {
          const m = document.cookie.match(/(?:^|; )mebular_csrf=([^;]*)/);
          const csrf = m ? decodeURIComponent(m[1]) : '';
          const res = await fetch('/admin/api/invite', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf }, body: JSON.stringify({ ttlMs: 120000 }) });
          const data = await res.json().catch(() => null);
          return data?.token ?? null;
        })()`);
        check('P3 准备加入令牌（create 实例邀请）', typeof joinToken === 'string' && joinToken.length > 40);

        joinHandle = spawnServe(joinHome, joinPort);
        const jr = await waitReady(joinHandle);
        const jBase = `http://127.0.0.1:${jr.port}`;
        await send('Page.navigate', { url: `${jBase}/console/` });
        check('P3 加入侧锁定态就位', await waitFor('document.querySelector("#app")?.dataset.locked === "true"'));
        await evalJs('document.querySelector("#join-cloud").click()');
        check('P3 加入弹框：设备名 + token（复用 modal-center/head/x）+ 字段顺序 + 必填语义', await waitFor(`(() => {
          const modal = document.querySelector('#onboard-join');
          const device = document.querySelector('#onboard-join-device');
          const token = document.querySelector('#onboard-join-token');
          const labels = [...(modal?.querySelectorAll('.onboard-join-fields .field label') ?? [])].map((el) => el.textContent.trim());
          return Boolean(modal) && modal.hidden === false && modal.classList.contains('modal-center')
            && Boolean(modal.querySelector('.modal-head')) && Boolean(modal.querySelector('.modal-x'))
            && Boolean(token) && Boolean(device)
            && (device?.value ?? '').length > 0
            && labels.length === 2 && labels[0].includes('设备名') && labels[1].includes('加入令牌')
            && device.required === true && token.required === true
            && device.getBoundingClientRect().top < token.getBoundingClientRect().top
            && modal.querySelector('.modal-box').scrollWidth <= modal.querySelector('.modal-box').clientWidth + 1;
        })()`));
        // 坏令牌：保持锁定 + 内联错误
        await evalJs(`(() => {
          const token = document.querySelector('#onboard-join-token');
          token.value = 'not-a-valid-token';
          token.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#onboard-join-submit').click();
        })()`);
        check('P3 加入失败保持锁定（坏令牌内联错误，不跳转/不刷新）', await waitFor(`(() => {
          const err = document.querySelector('#onboard-join-error');
          return Boolean(err) && err.hidden === false && /失败/.test(err.textContent)
            && document.body.classList.contains('is-locked')
            && document.querySelector('#onboard-join')?.hidden === false;
        })()`, 20000));
        await evalJs('window.__p3JoinPageToken = "join-same-page"');
        const navsBeforeJoin = cdp.events.filter((event) => event.method === 'Page.frameNavigated').length;
        await evalJs(`(() => {
          const token = document.querySelector('#onboard-join-token');
          token.value = ${JSON.stringify(joinToken)};
          token.dispatchEvent(new Event('input', { bubbles: true }));
          const device = document.querySelector('#onboard-join-device');
          device.value = 'p3-join-device';
          device.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#onboard-join-submit').click();
        })()`);
        check('P3 加入成功 → 同页解锁（无 reload / 无 restart）', await waitFor(`(() => {
          const app = document.querySelector('#app');
          return Boolean(app) && app.dataset.locked === undefined
            && document.body.classList.contains('is-locked') === false
            && document.querySelector('#onboard-join').hidden === true
            && document.querySelector('#onboarding-coach').hidden === true
            && document.querySelector('#invite-device').hidden === false
            && document.querySelector('#create-cloud').hidden === true
            && window.__p3JoinPageToken === 'join-same-page';
        })()`, 60000));
        const navsAfterJoin = cdp.events.filter((event) => event.method === 'Page.frameNavigated').length;
        check('P3 无 reload 证据：页面实例/导航次数不变（join）', navsAfterJoin === navsBeforeJoin,
          `navigations=${navsBeforeJoin}→${navsAfterJoin}`);
        const jst = await (await fetch(`${jBase}/app/provision/status`)).status;
        const jov = await fetch(`${jBase}/admin/api/overview`);
        check('P3 join 同进程/同端口：引导接口消失 + admin 200 + 进程存活',
          jst === 404 && jov.status === 200 && joinHandle.proc.exitCode === null,
          `status=${jst} overview=${jov.status}`);
        await send('Page.navigate', { url: `${jBase}/console/` });
        check('P3 解锁后刷新 → 直接进入正常控制台（引导接口已消失）', await waitFor(`(() => {
          const app = document.querySelector('#app');
          return Boolean(app) && app.dataset.locked === undefined
            && document.querySelector('#invite-device').hidden === false
            && document.querySelector('#create-cloud').hidden === true;
        })()`));
      } finally {
        try { onboardHandle.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
        try { joinHandle?.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
        await rm(onboardHome, { recursive: true, force: true }).catch(() => undefined);
        await rm(joinHome, { recursive: true, force: true }).catch(() => undefined);
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
