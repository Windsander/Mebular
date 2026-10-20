// E2-A1：忆云注册表 / 切换共享引擎 / CLI 兜底（沙箱，不启真实守护）
//
// 覆盖 SPEC §2（root/注册表/命名/路径/指纹）、§4.2（intent + current 先写后起 + 回滚）、
// §4.4（root active.lock）、§8.2（CLI cloud list/use/rename 契约）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireActiveLock,
  activeLockPath,
  DEFAULT_PROFILE_NAME,
  displayPath,
  homeKey,
  masterFingerprintFromBase64,
  masterFingerprintFromHex,
  mutateRegistry,
  newProfileId,
  nextProfileName,
  normalizeProfileName,
  profileHomeForEntry,
  readRegistry,
  registerProfile,
  renameProfile,
  resolveCloudRoot,
  writeRegistry,
} from '../../packages/mcp/src/profiles.mjs';
import {
  clearSwitchIntent,
  installProfileService,
  profileServiceDescriptor,
  profileServiceStatus,
  readSwitchIntent,
  switchIntentPath,
  switchProfile,
  uninstallProfileService,
} from '../../packages/mcp/src/cloud-switch.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');
const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
const FINGERPRINT = masterFingerprintFromBase64(PUBLIC_KEY);
const ID_A = 'p_00000001';
const ID_B = 'p_00000002';

function entry(id, name, home, extra = {}) {
  return {
    id,
    name,
    home,
    kind: 'delegated',
    createdAt: '2026-10-19T05:00:00.000Z',
    lastUsedAt: null,
    masterFingerprint: null,
    deviceId: 'device-test',
    ...extra,
  };
}

async function makeRoot({ config = true, registry = true } = {}) {
  const userHome = await mkdtemp(join(tmpdir(), 'e2a1-user-'));
  const root = join(userHome, '.mebular');
  await mkdir(root, { recursive: true });
  if (config) {
    await writeFile(join(root, 'config.json'), JSON.stringify({
      deviceId: 'device-test',
      mcp: { http: { host: '127.0.0.1', port: 17331, auth: 'none' } },
      joinService: { enabled: true, port: 14002 },
      network: { libp2p: { listen: ['/ip4/0.0.0.0/tcp/14001'] } },
    }, null, 2));
    await writeFile(join(root, 'user-master-key.json'), JSON.stringify({ publicKey: PUBLIC_KEY }, null, 2));
  }
  if (registry) {
    await writeRegistry(root, {
      v: 1,
      current: 'default',
      profiles: [
        entry('default', DEFAULT_PROFILE_NAME, '.', {
          kind: 'root',
          masterFingerprint: FINGERPRINT,
        }),
        entry(ID_A, '忆云 2', `profiles/${ID_A}`),
        entry(ID_B, '忆云 3', `profiles/${ID_B}`),
      ],
    });
  }
  return { userHome, root };
}

const envFor = (userHome, root) => ({
  ...process.env,
  MEBULAR_USER_HOME: userHome,
  MEBULAR_HOME: root,
  MEBULAR_CLOUD_ROOT: root,
});

describe('E2-A1 root 解析 / 档案功能开关', () => {
  it('显式 MEBULAR_CLOUD_ROOT 优先；profile home 自动推导 root；默认 ~/.mebular', () => {
    const userHome = '/tmp/e2a1-u';
    const explicit = resolveCloudRoot({
      home: '/tmp/root/profiles/p_00000001',
      env: { MEBULAR_CLOUD_ROOT: '/tmp/root', MEBULAR_HOME: '/tmp/root/profiles/p_00000001' },
      userHome,
    });
    expect(explicit.available).toBe(true);
    expect(explicit.root).toBe(resolve('/tmp/root'));

    const derived = resolveCloudRoot({
      home: '/tmp/root/profiles/p_00000001',
      env: { MEBULAR_HOME: '/tmp/root/profiles/p_00000001' },
      userHome,
    });
    expect(derived.available).toBe(true);
    expect(derived.root).toBe(resolve('/tmp/root'));

    const byDefault = resolveCloudRoot({ home: join(userHome, '.mebular'), env: {}, userHome });
    expect(byDefault.available).toBe(true);
    expect(byDefault.root).toBe(resolve(userHome, '.mebular'));

    const rootOnly = resolveCloudRoot({ env: { MEBULAR_CLOUD_ROOT: '/tmp/root' }, userHome });
    expect(rootOnly.available).toBe(true);
    expect(rootOnly.root).toBe(resolve('/tmp/root'));
  });

  it('自定义 home / 危险 env → CLOUD_UNAVAILABLE（不误闯新档案）', () => {
    const custom = resolveCloudRoot({ home: '/tmp/custom-home', env: { MEBULAR_HOME: '/tmp/custom-home' }, userHome: '/tmp/u' });
    expect(custom.available).toBe(false);
    expect(custom.reason).toBe('custom_home');

    for (const key of ['MEBULAR_CONFIG', 'MEBULAR_STORAGE_PATH', 'MEBULAR_USER_MASTER_KEY', 'MEBULAR_USER_MASTER_KEY_FILE', 'MEBULAR_ENDPOINTS_FILE']) {
      const disabled = resolveCloudRoot({
        home: '/tmp/root',
        env: { MEBULAR_CLOUD_ROOT: '/tmp/root', [key]: '/tmp/leak' },
        userHome: '/tmp/u',
      });
      expect(disabled.available).toBe(false);
      expect(disabled.reason).toBe(`env:${key}`);
    }
  });

  it('displayPath 展示为 ~ 前缀；homeKey 与 service 同定义', () => {
    expect(displayPath('/u/.mebular', { userHome: '/u' })).toBe('~/.mebular');
    expect(displayPath('/tmp/other', { userHome: '/u' })).not.toContain('\\');
    expect(homeKey('/tmp/abc')).toMatch(/^[0-9a-f]{12}$/);
    expect(homeKey('/tmp/abc/')).toBe(homeKey('/tmp/abc'));
  });
});

describe('E2-A1 注册表 v1：合成 / 原子写 / 备份 / 默认名', () => {
  let userHome;
  let root;
  beforeEach(async () => {
    ({ userHome, root } = await makeRoot({ registry: false }));
  });
  afterEach(async () => {
    await rm(userHome, { recursive: true, force: true });
  });

  it('默认条目内存合成，不写 profiles.json', async () => {
    const state = await readRegistry(root);
    expect(state.synthesized).toBe(true);
    expect(state.registry.v).toBe(1);
    expect(state.registry.current).toBe('default');
    expect(state.registry.profiles).toHaveLength(1);
    const profile = state.registry.profiles[0];
    expect(profile).toMatchObject({
      id: 'default',
      name: DEFAULT_PROFILE_NAME,
      home: '.',
      kind: 'root',
      deviceId: 'device-test',
      masterFingerprint: FINGERPRINT,
    });
    expect(profile.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(join(root, 'profiles.json'))).toBe(false);
  });

  it('原子写：0600、无 tmp 残留；第二次写保留 .bak（上一次成功版本）；主文件损坏回落 .bak', async () => {
    const first = { v: 1, current: 'default', profiles: [entry('default', '忆云 1', '.')] };
    await writeRegistry(root, first);
    const second = { ...first, current: 'default', profiles: [{ ...first.profiles[0], name: '忆云 1 改名' }] };
    await writeRegistry(root, second);

    const path = join(root, 'profiles.json');
    // Windows 的 fs.stat().mode 不带 POSIX 权限位（常见 0o666）；实现仍以 0600 创建/收口。
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(path, 'utf-8')).profiles[0].name).toBe('忆云 1 改名');
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf-8')).profiles[0].name).toBe('忆云 1');
    expect((await readdir(root)).some((name) => name.startsWith('profiles.json.tmp-'))).toBe(false);

    await writeFile(path, '{broken', 'utf-8');
    expect((await readRegistry(root)).registry.profiles[0].name).toBe('忆云 1');
    expect((await readRegistry(root)).source).toBe('bak');
  });

  it('指纹 sha256:<12hex>：token hex 与 key base64 同值；无效输入返回 null', () => {
    expect(FINGERPRINT).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(masterFingerprintFromHex(Buffer.from(PUBLIC_KEY, 'base64').toString('hex'))).toBe(FINGERPRINT);
    expect(masterFingerprintFromBase64('')).toBeNull();
    expect(masterFingerprintFromHex('xyz')).toBeNull();
  });

  it('未知字段保留（向前兼容）；v2 fail-closed', async () => {
    const registry = {
      v: 1,
      current: 'default',
      futureTop: { keep: true },
      profiles: [{ ...entry('default', '忆云 1', '.', { kind: 'root' }), futureEntry: 42 }],
    };
    await writeRegistry(root, registry);
    const result = await renameProfile(root, 'default', '工作室');
    expect(result.registry.futureTop).toEqual({ keep: true });
    expect(result.registry.profiles[0].futureEntry).toBe(42);
    expect(result.registry.profiles[0].nameUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 旧 registry 没有 nameUpdatedAt 也能读（迁移回退 createdAt/null）。
    await writeRegistry(root, {
      v: 1,
      current: 'default',
      profiles: [entry('default', '旧忆云', '.', { kind: 'root' })],
    });
    await expect(readRegistry(root)).resolves.toBeTruthy();

    await writeFile(join(root, 'profiles.json'), JSON.stringify({ ...registry, v: 2 }), 'utf-8');
    await expect(readRegistry(root)).rejects.toMatchObject({ code: 'CLOUD_REGISTRY_INVALID', reason: 'version' });
  });

  it('默认名取未占用的最小 N>=2；名字 1–24、去控制字符、拒 / \\ ..、大小写不敏感重名', async () => {
    expect(nextProfileName([{ name: '忆云 1' }, { name: '忆云 2' }])).toBe('忆云 3');
    expect(nextProfileName([{ name: '忆云 1' }, { name: '忆云 3' }])).toBe('忆云 2');
    expect(normalizeProfileName('  工作室  ')).toBe('工作室');
    expect(normalizeProfileName('a\u0000b')).toBe('ab');
    expect(normalizeProfileName('忆'.repeat(24))).toBe('忆'.repeat(24));
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'a..b', '忆'.repeat(25)]) {
      expect(() => normalizeProfileName(bad)).toThrow();
    }
    await expect(registerProfile(root, { id: ID_A, name: ' Studio ' })).resolves.toBeTruthy();
    await expect(registerProfile(root, { id: ID_B, name: 'studio' })).rejects.toMatchObject({ code: 'NAME_TAKEN' });
  });

  it('新 id = p_ + 8 hex，且跳过已占用；注册后 current 不变', async () => {
    let call = 0;
    const id = newProfileId([{ id: ID_A }], {
      random: () => Buffer.from(call++ === 0 ? '00000001' : '00000002', 'hex'),
    });
    expect(id).toBe('p_00000002');
    const result = await registerProfile(root, { id: ID_B, name: '忆云 2', kind: 'delegated' });
    expect(result.registry.current).toBe('default');
    expect(result.value.home).toBe(`profiles/${ID_B}`);
  });
});

describe('E2-A1 路径安全 / 锁 / active.lock', () => {
  let userHome;
  let root;
  beforeEach(async () => {
    ({ userHome, root } = await makeRoot());
  });
  afterEach(async () => {
    await rm(userHome, { recursive: true, force: true });
  });

  it('注册表 home 越界 / id 非法 → CLOUD_REGISTRY_INVALID；符号链接逃逸 → CLOUD_PROFILE_PATH_INVALID', async () => {
    await writeFile(join(root, 'profiles.json'), JSON.stringify({
      v: 1,
      current: 'default',
      profiles: [{ ...entry('default', '忆云 1', '.'), home: '../escape' }],
    }), 'utf-8');
    await expect(readRegistry(root)).rejects.toMatchObject({ code: 'CLOUD_REGISTRY_INVALID' });

    const outside = join(userHome, 'outside');
    await mkdir(outside, { recursive: true });
    await mkdir(join(root, 'profiles'), { recursive: true });
    let symlinked = true;
    try {
      await symlink(outside, join(root, 'profiles', ID_A), 'dir');
    } catch (error) {
      // Windows 无 Developer Mode/非管理员时创建目录符号链接会被拒（EPERM/EACCES）：
      // 该断言无法执行，但路径白名单/越界断言仍保留。
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) symlinked = false;
      else throw error;
    }
    await writeRegistry(root, {
      v: 1,
      current: 'default',
      profiles: [entry('default', '忆云 1', '.'), entry(ID_A, '忆云 2', `profiles/${ID_A}`)],
    });
    const state = await readRegistry(root);
    const target = state.registry.profiles.find((profile) => profile.id === ID_A);
    if (symlinked) expect(() => profileHomeForEntry(root, target)).toThrow(/root 之外/);
    await expect(registerProfile(root, { id: '../x', name: '坏' })).rejects.toMatchObject({ code: 'INVALID_PROFILE_ID' });
  });

  it('profiles.lock：活 PID 拒绝；陈旧 PID 回收', async () => {
    await writeFile(join(root, 'profiles.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf-8');
    await expect(mutateRegistry(root, (registry) => registry)).rejects.toMatchObject({ code: 'CLOUD_REGISTRY_LOCKED' });
    await rm(join(root, 'profiles.lock'), { force: true });

    await writeFile(join(root, 'profiles.lock'), JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }), 'utf-8');
    const result = await mutateRegistry(root, (registry) => registry);
    expect(result.registry.current).toBe('default');
    expect(existsSync(join(root, 'profiles.lock'))).toBe(false);
  });

  it('active.lock：写入 / 活 PID 不同 home 拒绝 / 陈旧回收 / release', async () => {
    const first = await acquireActiveLock({ root, home: root, profileId: 'default' });
    const payload = JSON.parse(await readFile(activeLockPath(root), 'utf-8'));
    expect(payload).toMatchObject({ pid: process.pid, profileId: 'default', home: root });
    expect(payload.startedAt).toMatch(/^\d{4}-/);

    const otherHome = join(root, 'profiles', ID_A);
    await mkdir(otherHome, { recursive: true });
    await expect(acquireActiveLock({ root, home: otherHome, profileId: ID_A })).rejects.toMatchObject({ code: 'CLOUD_ALREADY_ACTIVE' });
    await first.release();
    expect(existsSync(activeLockPath(root))).toBe(false);

    await writeFile(activeLockPath(root), JSON.stringify({ pid: 999_999_999, home: '/elsewhere', profileId: 'x' }), 'utf-8');
    const reclaimed = await acquireActiveLock({ root, home: otherHome, profileId: ID_A });
    expect(JSON.parse(await readFile(activeLockPath(root), 'utf-8')).home).toBe(otherHome);
    await reclaimed.release();
  });
});

describe('E2-A1 切换引擎：停旧 → current → 起新 → 健康（失败回滚）', () => {
  let userHome;
  let root;
  beforeEach(async () => {
    ({ userHome, root } = await makeRoot());
    for (const id of [ID_A, ID_B]) {
      await mkdir(join(root, 'profiles', id), { recursive: true });
      await writeFile(join(root, 'profiles', id, 'config.json'), JSON.stringify({ mcp: { http: { port: 17331 } } }), 'utf-8');
    }
  });
  afterEach(async () => {
    await rm(userHome, { recursive: true, force: true });
  });

  it('成功：顺序 stop→current→start→verify；lastUsedAt 更新；intent 清理；目录保留', async () => {
    const events = [];
    const result = await switchProfile({
      root,
      id: ID_A,
      now: () => '2026-10-19T06:10:00.000Z',
      stop: async ({ from, to }) => events.push(`stop:${from?.id}->${to.id}`),
      start: async ({ from, to }) => events.push(`start:${from?.id}->${to.id}`),
      verify: async ({ to }) => {
        events.push(`verify:${to.id}`);
        // 断言 current 已在起新之前写入
        const state = JSON.parse(await readFile(join(root, 'profiles.json'), 'utf-8'));
        expect(state.current).toBe(ID_A);
        return true;
      },
    });
    expect(events).toEqual(['stop:default->p_00000001', 'start:default->p_00000001', 'verify:p_00000001']);
    expect(result).toMatchObject({ ok: true, changed: true, current: ID_A, previous: 'default' });
    const state = await readRegistry(root);
    expect(state.registry.current).toBe(ID_A);
    expect(state.registry.profiles.find((profile) => profile.id === ID_A).lastUsedAt).toBe('2026-10-19T06:10:00.000Z');
    expect(existsSync(switchIntentPath(root))).toBe(false);
    expect(existsSync(join(root, 'profiles', ID_A))).toBe(true);

    // E2-CL-03：切回旧忆云（同一状态机；目标档案保留）。
    const backEvents = [];
    const back = await switchProfile({
      root,
      id: 'default',
      stop: async ({ from }) => backEvents.push(`stop:${from?.id}`),
      start: async ({ to }) => backEvents.push(`start:${to.id}`),
      verify: async ({ to }) => { backEvents.push(`verify:${to.id}`); return true; },
    });
    expect(back).toMatchObject({ ok: true, changed: true, current: 'default', previous: ID_A });
    expect(backEvents).toEqual(['stop:p_00000001', 'start:default', 'verify:default']);
    expect((await readRegistry(root)).registry.current).toBe('default');
    expect(existsSync(join(root, 'profiles', ID_A))).toBe(true);
  });

  it('起新失败：current 回滚旧、重新起旧、目标档案保留、intent 清理', async () => {
    const events = [];
    let failed = false;
    await expect(switchProfile({
      root,
      id: ID_A,
      stop: async ({ from }) => events.push(`stop:${from?.id}`),
      start: async ({ to, rollback }) => {
        events.push(`start:${to.id}${rollback ? ':rollback' : ''}`);
        if (!rollback) {
          failed = true;
          throw new Error('port in use');
        }
      },
      abort: async ({ to }) => events.push(`abort:${to.id}`),
      verify: async ({ to }) => {
        events.push(`verify:${to.id}`);
        return !failed || to.id === 'default';
      },
    })).rejects.toMatchObject({ code: 'CLOUD_SWITCH_FAILED' });

    expect(events).toEqual(['stop:default', 'start:p_00000001', 'abort:p_00000001', 'start:default:rollback', 'verify:default']);
    const state = await readRegistry(root);
    expect(state.registry.current).toBe('default');
    expect(state.registry.profiles.some((profile) => profile.id === ID_A)).toBe(true);
    expect(existsSync(join(root, 'profiles', ID_A))).toBe(true);
    expect(existsSync(switchIntentPath(root))).toBe(false);
  });

  it('健康校验失败 → 回滚；停旧失败 → current 不变、intent 清理；未知 id / 已是 current', async () => {
    const events = [];
    await expect(switchProfile({
      root,
      id: ID_A,
      stop: async () => events.push('stop'),
      start: async ({ to }) => events.push(`start:${to.id}`),
      verify: async ({ to }) => to.id !== ID_A,
    })).rejects.toMatchObject({ code: 'CLOUD_SWITCH_FAILED' });
    expect(events).toEqual(['stop', 'start:p_00000001', 'start:default']);
    expect((await readRegistry(root)).registry.current).toBe('default');

    await expect(switchProfile({
      root,
      id: ID_A,
      stop: async () => { throw new Error('externally managed'); },
      start: async () => undefined,
      verify: async () => true,
    })).rejects.toThrow('externally managed');
    expect((await readRegistry(root)).registry.current).toBe('default');
    expect(existsSync(switchIntentPath(root))).toBe(false);

    await expect(switchProfile({ root, id: 'p_ffffffff', stop: async () => undefined, start: async () => undefined, verify: async () => true }))
      .rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });

    const same = await switchProfile({ root, id: 'default', stop: async () => { throw new Error('must not stop'); }, start: async () => { throw new Error('must not start'); }, verify: async () => false });
    expect(same).toMatchObject({ ok: true, changed: false, current: 'default' });
  });

  it('intent 文件字段：stopping/starting/rolling_back 阶段可读写', async () => {
    await writeFile(switchIntentPath(root), JSON.stringify({ from: 'default', to: ID_A, at: 'x', phase: 'starting' }), 'utf-8');
    expect(await readSwitchIntent(root)).toMatchObject({ from: 'default', to: ID_A, phase: 'starting' });
    await clearSwitchIntent(root);
    expect(await readSwitchIntent(root)).toBeNull();
  });

  it('注册表写入失败（current 写不进）：停旧后恢复旧守护，current 不变', async () => {
    const events = [];
    await writeFile(join(root, 'profiles.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf-8');
    try {
      await expect(switchProfile({
        root,
        id: ID_A,
        stop: async ({ from }) => events.push(`stop:${from?.id}`),
        start: async ({ to, rollback }) => events.push(`start:${to.id}${rollback ? ':rollback' : ''}`),
        verify: async ({ to }) => events.push(`verify:${to.id}`),
      })).rejects.toMatchObject({ code: 'CLOUD_SWITCH_FAILED' });
    } finally {
      await rm(join(root, 'profiles.lock'), { force: true });
    }
    expect(events).toEqual(['stop:default', 'start:default:rollback', 'verify:default']);
    expect((await readRegistry(root)).registry.current).toBe('default');
    expect(existsSync(switchIntentPath(root))).toBe(false);
  });

  it('服务托管：descriptor 携带 profile home + cloud root；卸旧→装新；ok 但未 started 视为失败', async () => {
    const calls = [];
    const deps = {
      serviceStatus: (descriptor, options) => {
        calls.push(['status', descriptor.env.MEBULAR_HOME, options.home]);
        return { registered: true, autostart: true };
      },
      uninstallService: (descriptor, options) => {
        calls.push(['uninstall', descriptor.env.MEBULAR_HOME, options.home]);
        return { ok: true, removed: true };
      },
      installService: (descriptor, options) => {
        calls.push(['install', descriptor.env.MEBULAR_HOME, descriptor.env.MEBULAR_CLOUD_ROOT, options.home, options.autostart]);
        return { ok: true, started: true };
      },
    };
    const descriptor = profileServiceDescriptor({
      root,
      home: join(root, 'profiles', ID_A),
      cliBin: '/x/mebular.mjs',
      execPath: '/node',
    });
    expect(descriptor).toMatchObject({
      kind: 'mebular-serve',
      args: ['/x/mebular.mjs', 'serve'],
      heartbeatDir: join(root, 'profiles', ID_A),
      workingDir: join(root, 'profiles', ID_A),
      env: { MEBULAR_HOME: join(root, 'profiles', ID_A), MEBULAR_CLOUD_ROOT: root },
    });
    expect((await profileServiceStatus({ descriptor, serviceHome: '/os-home', deps })).registered).toBe(true);
    await uninstallProfileService({ descriptor, serviceHome: '/os-home', deps });
    await installProfileService({ descriptor, serviceHome: '/os-home', autostart: false, deps });
    expect(calls).toEqual([
      ['status', join(root, 'profiles', ID_A), '/os-home'],
      ['uninstall', join(root, 'profiles', ID_A), '/os-home'],
      ['install', join(root, 'profiles', ID_A), root, '/os-home', false],
    ]);
    await expect(installProfileService({
      descriptor,
      serviceHome: '/os-home',
      deps: { installService: () => ({ ok: true, started: false }) },
    })).rejects.toMatchObject({ code: 'SERVICE_START_FAILED' });
  });
});

describe('E2-A1 CLI：cloud list / rename / use（当前项短路）', () => {
  let userHome;
  let root;
  let env;
  beforeEach(async () => {
    ({ userHome, root } = await makeRoot());
    env = envFor(userHome, root);
  });
  afterEach(async () => {
    await rm(userHome, { recursive: true, force: true });
  });

  const run = (...args) => spawnSync(process.execPath, [CLI, 'cloud', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  it('list 输出注册表（current 标记、不含秘密）', () => {
    const result = run('list');
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    expect(body.ok).toBe(true);
    expect(body.current).toBe('default');
    expect(body.profiles).toHaveLength(3);
    expect(body.profiles.find((profile) => profile.id === 'default').current).toBe(true);
    expect(result.stdout).not.toMatch(/privateKey|token/i);
  });

  it('rename 写注册表；重名返回非零', () => {
    const result = run('rename', ID_A, ' 工作室 ');
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    expect(body.profile.name).toBe('工作室');
    const again = run('rename', ID_B, '工作室');
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/NAME_TAKEN|同名/);
  });

  it('use 当前项：changed=false，不启动/停止任何进程', () => {
    const result = run('use', 'default');
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    expect(body).toMatchObject({ ok: true, changed: false, current: 'default' });
    expect(body.consoleUrl).toMatch(/\/console$/);
  });
});
