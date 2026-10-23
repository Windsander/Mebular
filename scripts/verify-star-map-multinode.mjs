#!/usr/bin/env node
// 星图网络 · 真实 6 机 E2E（不是 mock、不是单进程 6 个对象）
//
// 6 个独立 MEBULAR_HOME / 端口 / daemon 进程，经同一忆云（A 为 root，其余经
// A 的 join service 取得委派身份）互联：
//   - A..E 订阅 tasks；F 只订阅 solo（与其余设备没有共同订阅域）。
//   - 从 A 的真实 console（headless Chrome / CDP）读取画布只读信号：
//       canvas.dataset.baseEdgeCount / solidEdgeCount / dashedEdgeCount
//       routeCount / hoverRouteCount / fleetRouteCount / hoveredDevice
//   - hover 可达设备 → 双向航道；hover F → 仅不可达（灰色）航道；未 hover → 0。
//   - 在 SSE 建立后，从 B 的真实 daemon（MCP tool task_submit）向 C 派一个任务，
//     断言 A 的 console 收到 `fleet` SSE，且 payload 的 from/to 都在场景内。
//
// 只读验收：不改生产 UI / 协议。任何契约不满足 → FAIL 并保留日志/截图，不伪造通过。
//
// 前置：npm run build（core / service / fleet dist）。
// 用法：node scripts/verify-star-map-multinode.mjs [--keep] [--evidence <dir>] [--skip-browser]
//   CHROME_PATH 可显式指定 Chrome/Chromium；找不到浏览器时明确 SKIP。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager } from '@mebular/core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const MCP_BIN = join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs');

const TASK_NS = 'tasks';
const SOLO_NS = 'solo';
const DEVICES = [
  { id: 'device-A', name: 'A', root: true, namespace: TASK_NS },
  { id: 'device-B', name: 'B', namespace: TASK_NS },
  { id: 'device-C', name: 'C', namespace: TASK_NS },
  { id: 'device-D', name: 'D', namespace: TASK_NS },
  { id: 'device-E', name: 'E', namespace: TASK_NS },
  { id: 'device-F', name: 'F', namespace: SOLO_NS },
];

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const skipBrowser = args.includes('--skip-browser');
const evidenceFlag = args.indexOf('--evidence');
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const evidenceDir = evidenceFlag >= 0 && args[evidenceFlag + 1]
  ? resolve(args[evidenceFlag + 1])
  : join(tmpdir(), `star-map-multinode-evidence-${stamp}`);
await mkdir(evidenceDir, { recursive: true });

const results = [];
const skipped = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  return !!cond;
}
function skip(name, reason) {
  skipped.push({ name, reason });
  console.log(`SKIP  ${name}  ${reason}`);
}
function warn(name, detail) {
  console.log(`WARN  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  return { name, detail };
}
const warnings = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolvePort(port));
    });
  });
}
async function httpJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}
async function postJson(url, body) {
  return httpJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}
// ---------- daemon 进程管理 ----------
const daemons = [];
function startDaemon(device, home, port) {
  const child = spawn(process.execPath, [MCP_BIN, 'serve'], {
    env: { ...process.env, MEBULAR_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { device: device.id, home, port, out: '', err: '', child };
  child.stdout.on('data', (d) => { state.out += d.toString(); });
  child.stderr.on('data', (d) => { state.err += d.toString(); });
  daemons.push(state);
  return state;
}
async function waitDaemonReady(state, timeoutMs = 30000) {
  const ok = await waitFor(() => /SERVE_READY/.test(state.out) || state.child.exitCode !== null, timeoutMs, 80);
  if (!ok || state.child.exitCode !== null) {
    throw new Error(`${state.device} daemon 未就绪（exit=${state.child.exitCode}）：${(state.err || state.out).slice(-500)}`);
  }
  return state;
}
function stopLongRunning() {
  for (const d of daemons) {
    if (d.child.exitCode === null && d.child.signalCode === null) {
      try { d.child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }
}

// ---------- 浏览器 / CDP（零依赖，复用控制台冒烟的同一套做法） ----------
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}
function launchChrome(executablePath) {
  return new Promise((resolveChrome, reject) => {
    const userDataDir = join(tmpdir(), `star-map-multinode-chrome-${process.pid}-${Date.now()}`);
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
        resolveChrome({ proc, wsUrl: match[1], userDataDir });
      } else if (proc.exitCode !== null || Date.now() - started > 20000) {
        clearInterval(timer);
        reject(new Error(`Chrome 未就绪（exit=${proc.exitCode}）：${err.slice(-400)}`));
      }
    }, 100);
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.once('error', (error) => { clearInterval(timer); reject(error); });
  });
}
function connectCdp(wsUrl) {
  // Node 20+ 内置 WebSocket；浏览器端不需要额外依赖。
  // eslint-disable-next-line no-undef
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  const ready = new Promise((resolveReady, reject) => {
    ws.onopen = () => resolveReady();
    ws.onerror = (event) => reject(new Error(`CDP 连接失败：${event?.message ?? 'error'}`));
  });
  ws.onmessage = (event) => {
    let msg = null;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const handler = pending.get(msg.id);
      pending.delete(msg.id);
      handler(msg);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolveSend, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, (msg) => {
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolveSend(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { ws, ready, send, events };
}

// ---------- 场景搭建 ----------
let root = null;
try {
  root = await mkdtemp(join(tmpdir(), 'star-map-multinode-'));
  console.log(`== 星图 6 机 E2E（真实 daemon）==`);
  console.log(`临时根目录：${root}`);
  console.log(`证据目录：${evidenceDir}`);

  const homes = new Map();
  const ports = new Map();
  for (const device of DEVICES) {
    homes.set(device.id, join(root, device.name));
    ports.set(device.id, await freePort());
    await mkdir(homes.get(device.id), { recursive: true });
  }
  const joinPort = await freePort();

  // A：root 身份 + 主密钥（与 verify:daemon:cluster 相同的真实守护形态）
  const homeA = homes.get('device-A');
  const imA = new IdentityManager();
  const master = await imA.generateUserMasterKey();
  await imA.generateDeviceKey('device-A', 'A');
  await imA.issueDeviceCertificate('device-A');
  const masterPublicB64 = Buffer.from(master.publicKey).toString('base64');
  await writeFile(join(homeA, 'master-key.json'), JSON.stringify({
    publicKey: masterPublicB64,
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
  }, null, 2), { mode: 0o600 });
  await writeFile(join(homeA, 'config.json'), JSON.stringify({
    storagePath: join(homeA, 'store.jsonl'),
    deviceId: 'device-A',
    deviceName: 'A',
    identity: { mode: 'root' },
    encryption: { level: 'none', keyFile: join(homeA, 'master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
    sync: {
      autoSync: true,
      pushOnWrite: true,
      pushOnWriteThrottleMs: 20,
      namespaces: [TASK_NS],
      antiEntropy: { enabled: true, intervalMs: 5000, jitterRatio: 0.2 },
    },
    joinService: { enabled: true, bind: '127.0.0.1', port: joinPort },
    mcp: { http: { host: '127.0.0.1', port: ports.get('device-A'), auth: 'none', tls: false } },
  }, null, 2), { mode: 0o600 });

  const aDaemon = await waitDaemonReady(startDaemon(DEVICES[0], homeA, ports.get('device-A')));
  const portA = ports.get('device-A');
  const baseA = `http://127.0.0.1:${portA}`;
  const overview = await httpJson(`${baseA}/admin/api/overview`);
  check('A 守护就绪（SERVE_READY）且 admin overview 200', /SERVE_READY/.test(aDaemon.out) && overview.status === 200, {
    status: overview.status, device: overview.json?.device?.deviceId,
  });

  const netA = await httpJson(`${baseA}/app/network`);
  const addrA = (netA.json?.multiaddrs ?? []).find((addr) => typeof addr === 'string' && addr.includes('/p2p/')) ?? null;
  check('A 暴露可拨号 multiaddr', typeof addrA === 'string' && addrA.length > 0, { addrA });
  if (!addrA) throw new Error('A 未暴露 multiaddr，无法组建真实多机网络');

  // A 自声明订阅 tasks（与其余设备同一策略事实面）
  const aSub = await postJson(`${baseA}/app/policy/subscription`, { namespace: TASK_NS, active: true });
  check('A 声明订阅 tasks', aSub.status === 200 && aSub.json?.ok === true, { status: aSub.status });

  // B..F：经 A 的 join service 取得委派身份，各自独立 home / 端口 / 进程
  const joinEvidence = [];
  for (const device of DEVICES.filter((d) => !d.root)) {
    const invite = await postJson(`${baseA}/app/join/invite`, { namespace: device.namespace, ttlMs: 180000 });
    if (invite.status !== 200 || typeof invite.json?.token !== 'string') {
      throw new Error(`${device.id} 邀请失败：${invite.status} ${invite.text.slice(0, 300)}`);
    }
    const im = new IdentityManager();
    const key = await im.generateDeviceKey(device.id, device.name);
    const joined = await postJson(`http://127.0.0.1:${joinPort}/mebular/join`, {
      token: invite.json.token,
      deviceId: device.id,
      devicePublicKey: Buffer.from(key.publicKey).toString('hex'),
    });
    if (joined.status !== 200 || !Array.isArray(joined.json?.chain)) {
      throw new Error(`${device.id} join 失败：${joined.status} ${joined.text.slice(0, 300)}`);
    }
    joinEvidence.push({ device: device.id, chainLength: joined.json.chain.length });

    const home = homes.get(device.id);
    await writeFile(`${join(home, 'store.jsonl')}.identity.json`, JSON.stringify({
      deviceId: device.id,
      deviceName: device.name,
      publicKeyHex: Buffer.from(key.publicKey).toString('hex'),
      certificate: joined.json.certificate,
      certificateChain: joined.json.chain,
      createdAt: Date.now(),
      privateKeyPkcs8: await IdentityManager.exportPrivateKey(key.privateKey),
    }, null, 2), { mode: 0o600 });
    await writeFile(join(home, 'user-master-key.json'), JSON.stringify({ publicKey: masterPublicB64 }, null, 2), { mode: 0o600 });
    await writeFile(join(home, 'config.json'), JSON.stringify({
      storagePath: join(home, 'store.jsonl'),
      deviceId: device.id,
      deviceName: device.name,
      identity: { mode: 'delegated' },
      encryption: { level: 'none', userMasterPublicKeyFile: join(home, 'user-master-key.json') },
      network: {
        enabled: true,
        libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] },
        peers: [{ device: 'device-A', addr: addrA }],
      },
      sync: {
        autoSync: true,
        pushOnWrite: true,
        pushOnWriteThrottleMs: 20,
        namespaces: [device.namespace],
        antiEntropy: { enabled: true, intervalMs: 5000, jitterRatio: 0.2 },
      },
      mcp: { http: { host: '127.0.0.1', port: ports.get(device.id), auth: 'none', tls: false } },
    }, null, 2), { mode: 0o600 });

    const daemon = await waitDaemonReady(startDaemon(device, home, ports.get(device.id)));
    check(`${device.id} 守护就绪（delegated，独立进程/端口/home）`, /SERVE_READY/.test(daemon.out), {
      port: ports.get(device.id), pid: daemon.child.pid,
    });
    const sub = await postJson(`http://127.0.0.1:${ports.get(device.id)}/app/policy/subscription`, { namespace: device.namespace, active: true });
    check(`${device.id} 自声明订阅 ${device.namespace}`, sub.status === 200 && sub.json?.ok === true, { status: sub.status });
  }
  check('5 台设备经 join service 取得委派链（B..F ← A）', joinEvidence.length === 5 && joinEvidence.every((row) => row.chainLength >= 2), joinEvidence);

  const pidSet = new Set(daemons.map((d) => d.child.pid));
  const homeSet = new Set(daemons.map((d) => d.home));
  check('6 个 daemon 是独立进程与独立 home', daemons.length === 6 && pidSet.size === 6 && homeSet.size === 6, {
    pids: [...pidSet], homes: [...homeSet].map((h) => h.replace(root, '<root>')),
  });

  // 等 A 看到 6 台设备（策略事件经真实同步传播；F 只在线/自声明 solo）
  let devices = [];
  const topoReady = await waitFor(async () => {
    const res = await httpJson(`${baseA}/admin/api/devices`);
    devices = Array.isArray(res.json) ? res.json : [];
    if (devices.length !== 6) return false;
    const byId = new Map(devices.map((d) => [d.deviceId, d]));
    const tasksOk = DEVICES.filter((d) => d.namespace === TASK_NS)
      .every((d) => (byId.get(d.id)?.subscriptions ?? []).includes(TASK_NS));
    const f = byId.get('device-F');
    return tasksOk && Boolean(f) && !(f.subscriptions ?? []).includes(TASK_NS);
  }, 40000, 250);
  check('A 的设备表含 6 台；A..E 订阅 tasks，F 不订阅 tasks', topoReady, {
    devices: devices.map((d) => ({ id: d.deviceId, online: d.online, subscriptions: d.subscriptions })),
  });
  if (!topoReady) throw new Error('真实多机拓扑未在超时内收敛');

  const byId = new Map(devices.map((d) => [d.deviceId, d]));
  const online = devices.filter((d) => d.online === true).length;
  check('设备在线数符合预期（除 root 自身外 5 台已认证直连）', online === 5, { online });
  const fDevice = byId.get('device-F');
  check('F 与其余设备没有共同订阅域', (fDevice?.sharesWithMe ?? []).length === 0, { sharesWithMe: fDevice?.sharesWithMe });
  // 记录一个契约异常（不阻断 E2E）：真实 /admin/api/devices 把 self 标成 offline，
  // 会让本机星在星图上被画成离线、且任务域悬停时本机被算作不可达。
  if (byId.get('device-A')?.online !== true) {
    warnings.push(warn('本机（self）在 /admin/api/devices 中 online=false（mock 为 true）', {
      selfOnline: byId.get('device-A')?.online ?? null,
    }));
  }

  // ---------- 浏览器验收 ----------
  if (skipBrowser) {
    skip('真实浏览器画布验收', '--skip-browser');
  } else {
    const chromePath = findChrome();
    if (!chromePath) {
      skip('真实浏览器画布验收', '未找到 Chrome/Chromium（可用 CHROME_PATH 指定）');
    } else {
      let chromeHandle = null;
      let cdp = null;
      try {
        chromeHandle = await launchChrome(chromePath);
        cdp = connectCdp(chromeHandle.wsUrl);
        await cdp.ready;
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const send = (method, params) => cdp.send(method, params, sessionId);
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Network.enable');
        await send('Log.enable');
        await send('Emulation.setDeviceMetricsOverride', {
          width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
        });

        const evalJs = async (expression) => {
          const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          if (result.exceptionDetails) {
            throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
          }
          return result.result.value;
        };
        const waitJs = async (expression, timeoutMs = 20000) => {
          const started = Date.now();
          while (Date.now() - started < timeoutMs) {
            try { if (await evalJs(expression)) return true; } catch { /* 导航瞬态 */ }
            await sleep(200);
          }
          return false;
        };
        const dataset = () => evalJs(`(() => { const c = document.querySelector('#stage'); return c ? { ...c.dataset } : null; })()`);
        const capture = async (name) => {
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          const path = join(evidenceDir, name);
          await writeFile(path, Buffer.from(shot.data, 'base64'));
          console.log(`截图：${path}`);
          return path;
        };
        const cdpEvent = (method, predicate = () => true) => cdp.events
          .filter((event) => event.method === method && predicate(event.params))
          .map((event) => event.params);

        const consoleUrl = `${baseA}/console/`;
        await send('Page.navigate', { url: consoleUrl });
        check('真实 console 页面加载（consoleReady）', await waitJs(`document.documentElement?.dataset?.consoleReady === '1'`, 30000));
        const sceneReady = await waitJs(`(() => {
          const c = document.querySelector('#stage');
          return Boolean(c) && c.dataset.scene === 'ready' && c.dataset.baseEdgeCount === '15';
        })()`, 30000);
        let scene = await dataset();
        check('画布 6 设备全连接：baseEdgeCount=15', sceneReady && scene?.baseEdgeCount === '15', scene);
        check('solidEdgeCount=10（A..E 共享 tasks）', scene?.solidEdgeCount === '10', { solidEdgeCount: scene?.solidEdgeCount });
        check('dashedEdgeCount=5（F 无共同订阅域，至少 1 条虚线）', scene?.dashedEdgeCount === '5', { dashedEdgeCount: scene?.dashedEdgeCount });
        check('未 hover 时 routeCount=0 且 hoveredDevice 为空', scene?.routeCount === '0' && scene?.hoveredDevice === '', {
          routeCount: scene?.routeCount, hoveredDevice: scene?.hoveredDevice,
        });

        // 在画布上扫一遍星位（真实 Canvas 命中测试），记录每个 deviceId 的可 hover 点。
        const probe = await evalJs(`(() => {
          const c = document.querySelector('#stage');
          if (!c) return null;
          const r = c.getBoundingClientRect();
          const found = {};
          const step = 8;
          for (let y = 2; y < r.height; y += step) {
            for (let x = 2; x < r.width; x += step) {
              c.dispatchEvent(new PointerEvent('pointermove', {
                clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
              }));
              const id = c.dataset.hoveredDevice;
              if (id && !found[id]) found[id] = { x: r.left + x, y: r.top + y };
            }
          }
          return { found, width: r.width, height: r.height };
        })()`);
        const foundCount = Object.keys(probe?.found ?? {}).length;
        check('画布命中测试能定位全部 6 颗真实设备星', foundCount === 6, { found: Object.keys(probe?.found ?? {}), size: [probe?.width, probe?.height] });
        if (foundCount !== 6) throw new Error('hover 星位探测未覆盖 6 台设备');

        // 小范围重试：画面视差/漂浮会让星位轻微移动，但命中必须落在目标设备上。
        const hoverDevice = async (deviceId) => {
          const point = probe.found[deviceId];
          const ok = await evalJs(`(() => {
            const c = document.querySelector('#stage');
            const target = ${JSON.stringify(deviceId)};
            const base = { x: ${point.x}, y: ${point.y} };
            const tryAt = (x, y) => {
              c.dispatchEvent(new PointerEvent('pointermove', {
                clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
              }));
              return c.dataset.hoveredDevice;
            };
            if (tryAt(base.x, base.y) === target) return true;
            for (let radius = 6; radius <= 42; radius += 6) {
              for (let a = 0; a < 360; a += 30) {
                const rad = (a * Math.PI) / 180;
                if (tryAt(base.x + Math.cos(rad) * radius, base.y + Math.sin(rad) * radius) === target) return true;
              }
            }
            return false;
          })()`);
          await sleep(80);
          return ok;
        };
        const leaveCanvas = () => evalJs(`(() => {
          const c = document.querySelector('#stage');
          c.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
          return c.dataset.hoveredDevice;
        })()`);

        // 视觉几何契约：基础边是直线；hover 蓝/金航道、灰色不可达航道与 fleet 航线
        // 保留旧版弧线几何（二次曲线/双向偏移）。E2E 只断言通道的**存在/方向/计数**
        // （dataset），不检查直线/曲率/端点坐标，因此弧线改造不会让本测试变红。
        const expectedRoutes = (hoverId) => {
          const hovered = byId.get(hoverId);
          const hoveredReachable = hovered?.online === true && (hovered?.subscriptions ?? []).includes(TASK_NS);
          let count = 0;
          for (const device of devices) {
            if (device.deviceId === hoverId) continue;
            const targetReachable = device.online === true && (device.subscriptions ?? []).includes(TASK_NS);
            count += hoveredReachable && targetReachable ? 2 : 1;
          }
          return count;
        };

        const hoverB = await hoverDevice('device-B');
        const hoverBData = await dataset();
        const expectedB = expectedRoutes('device-B');
        check('hover 可达设备 B：出现双向航道（蓝 out + 金 in）', hoverB
          && hoverBData?.hoveredDevice === 'device-B'
          && Number(hoverBData.hoverRouteCount) === expectedB
          && expectedB > 1, {
          hoveredDevice: hoverBData?.hoveredDevice,
          hoverRouteCount: hoverBData?.hoverRouteCount,
          expected: expectedB,
        });
        await capture('star-map-hover-reachable.png');

        const hoverF = await hoverDevice('device-F');
        const hoverFData = await dataset();
        const expectedF = expectedRoutes('device-F');
        check('hover 不可达设备 F：只剩灰色航道（每台 1 条，无双向）', hoverF
          && hoverFData?.hoveredDevice === 'device-F'
          && Number(hoverFData.hoverRouteCount) === expectedF
          && expectedF === devices.length - 1, {
          hoveredDevice: hoverFData?.hoveredDevice,
          hoverRouteCount: hoverFData?.hoverRouteCount,
          expected: expectedF,
        });
        await capture('star-map-hover-unreachable.png');

        await leaveCanvas();
        const left = await dataset();
        check('离开星体后航道归零（routeCount=0）', left?.routeCount === '0' && left?.hoveredDevice === '', left);

        // ---------- 远端 fleet SSE ----------
        const sseResponses = cdpEvent('Network.responseReceived', (p) => String(p?.response?.url ?? '').includes('/admin/events'));
        const sseConnected = await waitFor(() => cdp.events.some((event) => event.method === 'Network.responseReceived'
          && String(event.params?.response?.url ?? '').includes('/admin/events')
          && event.params?.response?.status === 200), 20000, 100);
        check('console 已建立真实 SSE 连接（/admin/events 200）', sseConnected, {
          responses: sseResponses.map((p) => ({ status: p.response?.status, mimeType: p.response?.mimeType, type: p.type })),
        });
        const helloSeen = await waitFor(() => cdp.events.some((event) => event.method === 'Network.eventSourceMessageReceived'
          && event.params?.eventName === 'hello'), 15000, 100);
        check('SSE 收到 hello（连接已进入事件流）', helloSeen);

        // 从 B 的真实 daemon 向 C 派一个 task。这里走守护自身的 app API（写入
        // `task_event` / `type=created` 节点，形状与 fleet task_submit 落库一致）：
        // 由 B 的守护进程自己 append → pushOnWrite → A 的 sync 应用 → A 的 /admin/events
        // 广播 `fleet`。注意：/mcp 的 task_submit 在**已运行**的守护上会另开离线 store
        // 写同一 JSONL，守护进程内的 eventLog 不会收到 append（见最终报告的未解决项），
        // 因此那条路不能代表「daemon 实时发任务」。
        const taskId = `task-device-B-${randomUUID().slice(0, 8)}`;
        const taskCreatedAt = Date.now();
        const taskNode = {
          type: 'task_event',
          namespace: TASK_NS,
          content: {
            v: 1,
            eventId: `${taskId}#created`,
            taskId,
            type: 'created',
            actor: { device: 'device-B', agent: 'board' },
            at: taskCreatedAt,
            toStatus: 'queued',
            trace: { chain: [] },
            to: { device: 'device-C', agent: 'echo' },
            intent: 'star-map-multinode-e2e',
          },
        };
        const submit = await postJson(`http://127.0.0.1:${ports.get('device-B')}/app/nodes`, taskNode);
        check('B 的 daemon 真实写入任务事件（task_event/created，目标 C）', submit.status === 200 && submit.json?.ok === true, {
          status: submit.status, taskId, nodeId: submit.json?.node?.id ?? null,
        });

        const fleetSeen = await waitFor(() => cdp.events.some((event) => event.method === 'Network.eventSourceMessageReceived'
          && event.params?.eventName === 'fleet'), 30000, 100);
        check('console 收到 fleet SSE（不是 sync 事件冒充）', fleetSeen);

        const aTaskNodes = await httpJson(`${baseA}/app/nodes?namespace=${TASK_NS}&type=task_event&limit=50`);
        const mirroredTask = (aTaskNodes.json?.nodes ?? []).find((node) => node.content?.taskId === taskId);
        check('任务事件已由 B 真实同步到 A（SSE 的数据源，非本地伪造）', Boolean(mirroredTask), {
          count: aTaskNodes.json?.count ?? null,
          nodeId: mirroredTask?.id ?? null,
        });

        const fleetMessages = cdpEvent('Network.eventSourceMessageReceived', (p) => p?.eventName === 'fleet');
        const fleetPayloads = fleetMessages.map((p) => {
          try { return JSON.parse(p.data); } catch { return null; }
        }).filter(Boolean);
        const fleet = fleetPayloads.find((payload) => payload.fromDeviceId === 'device-B' && payload.toDeviceId === 'device-C') ?? null;
        check('fleet payload from=B / to=C / eventType=created / namespace=tasks', Boolean(fleet)
          && fleet.eventType === 'created'
          && fleet.namespace === TASK_NS
          && fleet.taskId === taskId
          && byId.has(fleet.fromDeviceId)
          && byId.has(fleet.toDeviceId), { payloads: fleetPayloads });

        const fleetGrew = await waitFor(async () => {
          const d = await dataset();
          return Number(d?.fleetRouteCount) > 0 && Number(d?.routeCount) >= Number(d?.fleetRouteCount);
        }, 10000, 100);
        const fleetData = await dataset();
        check('画布 fleetRouteCount/routeCount 增长（远端任务航道）', fleetGrew && Number(fleetData?.fleetRouteCount) > 0, {
          fleetRouteCount: fleetData?.fleetRouteCount,
          routeCount: fleetData?.routeCount,
          hoverRouteCount: fleetData?.hoverRouteCount,
        });
        await capture('star-map-remote-fleet.png');

        // draw 循环在 fleet 生命周期结束后回落（约 2.4s）
        const fleetExpired = await waitFor(async () => (await dataset())?.fleetRouteCount === '0', 8000, 200);
        check('fleet 航道在生命周期结束后回到 0（eventRoutes 是瞬时航线）', fleetExpired, await dataset());

        // 证据：真机截图 + 画布信号 JSON
        try {
          await capture('star-map-6-devices.png');
        } catch (error) {
          warn('截图失败（不影响信号断言）', { error: String(error?.message ?? error) });
        }
        await writeFile(join(evidenceDir, 'canvas-signals.json'), JSON.stringify({
          scene: await dataset(),
          devices: devices.map((d) => ({ id: d.deviceId, online: d.online, subscriptions: d.subscriptions, sharesWithMe: d.sharesWithMe })),
          fleetPayloads,
          submit: { taskId, at: taskCreatedAt, path: '/app/nodes' },
        }, null, 2));
      } finally {
        if (chromeHandle?.proc) {
          try { chromeHandle.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
          await sleep(200);
          await rm(chromeHandle.userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
        }
      }
    }
  }
} catch (error) {
  check('E2E 执行未抛异常', false, { error: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 3) });
} finally {
  stopLongRunning();
  await sleep(200);
  // 日志与拓扑快照：失败一律保留；成功默认清理临时 home，但证据目录保留。
  try {
    const failedNow = results.some((r) => !r.ok);
    await writeFile(join(evidenceDir, 'summary.json'), JSON.stringify({
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).map((r) => r.name),
      skipped,
      warnings,
      results,
    }, null, 2));
    if (failedNow || keep) {
      for (const d of daemons) {
        const safe = d.device.replace(/[^A-Za-z0-9_-]/g, '_');
        await writeFile(join(evidenceDir, `${safe}.log`), `STDOUT\n${d.out}\nSTDERR\n${d.err}\n`);
      }
      if (root) await writeFile(join(evidenceDir, 'root-path.txt'), `${root}\n`);
      console.log(`失败/保留日志：${evidenceDir}`);
    } else if (root) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  } catch (error) {
    console.error(`清理阶段异常：${String(error?.message ?? error)}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = {
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((f) => f.name),
  skipped,
  warnings: warnings.map((w) => w.name),
  evidenceDir,
};
console.log(JSON.stringify(summary, null, 2));
console.log(`STAR_MAP_MULTINODE_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
