// Mebular 桌面 App · 有界冒烟（**不开 GUI**、不留进程）
//
// 断言：
//   1) main 纯逻辑模块可加载（daemon.mjs / ipc.mjs / tray-icons.mjs）；
//   2) 参数解析与 IPC 白名单判别（含负例）；
//   3) `electron --version` 可执行（有界超时）；
//   4) ELECTRON_RUN_AS_NODE：Electron 自带 Node 能加载现有 CLI（验证 §2 风险 2）。
// 无 electron 二进制（CI 设 ELECTRON_SKIP_BINARY_DOWNLOAD=1）→ 打印 SKIP 并 exit 0。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const root = join(appDir, '..', '..');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`); }
  else { failed += 1; console.log(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); }
};

console.log('Mebular 桌面 App 冒烟（无 GUI）');
console.log('===============================');

// 1) 模块可加载 + 2) 行为断言
const daemon = await import('../src/main/daemon.mjs');
const ipc = await import('../src/main/ipc.mjs');
const icons = await import('../src/main/tray-icons.mjs');
check('main 纯逻辑模块可加载（daemon/ipc/tray-icons）',
  typeof daemon.ensureDaemon === 'function' && typeof ipc.isAllowedChannel === 'function' && icons.TRAY_STATES.length === 3);

const parsed = daemon.parseArgs(['--home', '/tmp/x', '--port=7399', '--flag']);
check('参数解析（--home 空格 / --port= 等号 / 布尔）',
  parsed.home === '/tmp/x' && parsed.port === '7399' && parsed.flag === true, JSON.stringify(parsed));

check('IPC 白名单：允许 daemon:status / console:open', ipc.isAllowedChannel('daemon:status') && ipc.isAllowedChannel('console:open'));
check('IPC 白名单：拒绝任意通道（负例）', !ipc.isAllowedChannel('exec:arbitrary') && !ipc.isAllowedChannel('') && !ipc.isAllowedChannel('daemon:status;rm -rf /'));

const table = ipc.buildHandlerTable({ 'daemon:status': () => 'ok', 'exec:arbitrary': () => 'nope' });
check('handler 表只注册白名单通道（丢弃非白名单）', Boolean(table['daemon:status']) && !table['exec:arbitrary']);

check('healthUrl/consoleUrl 固定 127.0.0.1', daemon.healthUrl({ port: 7331 }) === 'http://127.0.0.1:7331/healthz'
  && daemon.consoleUrl({ port: 7331 }) === 'http://127.0.0.1:7331/console');

// 复用判定（fetch 注入）
const healthy = await daemon.probeHealth(async () => ({ ok: true }), { host: '127.0.0.1', port: 7331 });
const unreachable = await daemon.probeHealth(async () => { throw new Error('ECONNREFUSED'); }, { host: '127.0.0.1', port: 7331 });
check('probeHealth：健康 → true；拒连 → false（不抛）', healthy === true && unreachable === false);

const reused = await daemon.ensureDaemon({
  home: '/tmp/home', http: { host: '127.0.0.1', port: 7331 },
  fetchImpl: async () => ({ ok: true }), service: {}, spawnFn: () => { throw new Error('should not spawn'); },
});
check('ensureDaemon：已有实例健康 → reused（不重复启动）', reused.mode === 'reused' && reused.child === null);

let spawned = null;
const childMode = await daemon.ensureDaemon({
  home: '/tmp/home', http: { host: '127.0.0.1', port: 7331 }, cliBin: '/x/mebular.mjs',
  fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  service: { registeredServicesForDir: () => [] },
  spawnFn: (exec, args, opts) => { spawned = { exec, args, opts }; return { kill: () => true }; },
});
check('ensureDaemon：无服务 → 子进程兜底且显式传 MEBULAR_HOME', childMode.mode === 'child'
  && spawned?.args?.[1] === 'serve' && spawned?.opts?.env?.MEBULAR_HOME === '/tmp/home', spawned?.args?.join(' '));

let restarted = null;
const serviceMode = await daemon.ensureDaemon({
  home: '/tmp/home', http: { host: '127.0.0.1', port: 7331 }, cliBin: '/x/mebular.mjs',
  fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  service: { registeredServicesForDir: () => ['mebular-serve'], restartService: () => { restarted = true; } },
  spawnFn: () => { throw new Error('should use service'); },
});
check('ensureDaemon：服务托管已登记 → 走服务重启（优先于子进程）', serviceMode.mode === 'service' && restarted === true);

check('退出策略：仅停止子进程托管（服务托管返回 false）',
  daemon.stopManaged({ kill: () => true }) === true && daemon.stopManaged(null) === false);

// M2：三步向导状态机 / 深链 / 邀请构造（**不真发**）/ 日志脱敏
const wizard = await import('../src/main/wizard.mjs');
const w0 = wizard.computeWizardState({ daemonHealthy: false });
const w1 = wizard.computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1 } });
const wDone = wizard.computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1 }, invite: { created: true } });
check('向导状态机：未启动 → start；已连助手 → device；邀请已生成 → complete',
  w0.current === 'start' && w1.current === 'device' && wDone.complete === true);

const plan = wizard.invitePlan({ fleetBin: '/repo/packages/fleet/dist/cli.js', home: '/h', device: 'device-A' });
check('邀请命令构造（只构造不发送；fleet invite --dir <home>）',
  plan.args[0].endsWith('cli.js') && plan.args.includes('invite') && plan.args.includes('--dir') && plan.args.includes('/h'));

const parsedInvite = wizard.parseInviteOutput('noise\n{"token":"T","qrSvg":null,"warning":"缺少 qrcode"}');
check('邀请输出解析（qrcode 缺失 → 文本令牌兜底）',
  parsedInvite.token === 'T' && parsedInvite.qrSvg === null && /qrcode/.test(parsedInvite.warning));

check('日志脱敏（令牌/密钥不回显）',
  !wizard.redactLog('token=ABCDEFGH userMasterKey=SECRETKEY').includes('ABCDEFGH')
    && !wizard.redactLog('token=ABCDEFGH userMasterKey=SECRETKEY').includes('SECRETKEY'));

check('深链仅回环（拒绝外站）',
  wizard.isLoopbackUrl(wizard.deepLinks({ host: '127.0.0.1', port: 7331 }).assistants) && !wizard.isLoopbackUrl('http://evil.example/x'));

// 3) electron --version（有界）
const { resolveElectronBinary } = await import('./electron-path.mjs');
const electronPath = await resolveElectronBinary();
if (!electronPath) {
  console.log('  ⚠ 未找到 electron 二进制（可能 ELECTRON_SKIP_BINARY_DOWNLOAD=1）→ 跳过二进制冒烟');
} else {
  // 无头安全：用 ELECTRON_RUN_AS_NODE 打印 Electron 版本（Linux CI 无显示器时 `--version` 会失败）
  const versionProbe = spawnSync(electronPath, ['-e', 'console.log("v"+process.versions.electron)'], {
    timeout: 20000, encoding: 'utf-8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const versionText = String(versionProbe.stdout).trim();
  check('Electron 可执行且版本可读（无头安全；ELECTRON_RUN_AS_NODE）',
    versionProbe.status === 0 && /^v\d+\.\d+/.test(versionText), `${versionText} ${String(versionProbe.stderr).trim().slice(0, 80)}`);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const version = spawnSync(electronPath, ['--version'], { timeout: 20000, encoding: 'utf-8' });
    check('electron --version 可执行（macOS/Windows；有界 20s）',
      version.status === 0 && /v\d+\.\d+/.test(String(version.stdout)), String(version.stdout).trim());
  } else {
    console.log('  · Linux：跳过 `electron --version`（无显示器时失败属预期；已用无头安全探测替代）');
  }

  // 4) ELECTRON_RUN_AS_NODE：Electron 自带 Node 可加载 core（§2 风险 2；需仓库依赖已装+已 build）
  //    （不 import bin/mebular.mjs：bin 会执行 CLI；改用 core 入口验证 ABI/依赖可加载）
  const coreEntry = join(root, 'dist', 'index.js');
  if (!existsSync(join(root, 'node_modules')) || !existsSync(coreEntry)) {
    console.log('  ⚠ 仓库依赖/构建产物未就绪（跳过 ELECTRON_RUN_AS_NODE 加载 core 检查；CI 会先 npm ci + build）');
  } else {
    const nodeMode = spawnSync(electronPath, ['-e', `import('${coreEntry}').then(()=>{console.log('CORE_OK')}).catch((e)=>{console.error(String(e));process.exit(3)})`], {
      timeout: 30000, encoding: 'utf-8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    check('ELECTRON_RUN_AS_NODE：Electron 自带 Node 可加载 core（无 ABI 阻塞）',
      nodeMode.status === 0 && /CORE_OK/.test(String(nodeMode.stdout)), `${String(nodeMode.stdout).trim()} ${String(nodeMode.stderr).trim().slice(0, 100)}`);
  }
}

console.log('===============================');
if (failed === 0) {
  console.log(`✓ 桌面 App 冒烟通过（${passed} 项）`);
  process.exit(0);
}
console.log(`✗ 桌面 App 冒烟失败（${failed}/${passed + failed}）`);
process.exit(1);
