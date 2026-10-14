// F-FIX-A · 路径基数（userHome vs Mebular home）/ 增强 PATH / recheck 端点
//
// 夹具**双 home**（userHome ≠ mebularHome）：这正是不再「沙箱全绿、真机全瞎」的判别条件。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assistantUserHome,
  builtinAssistants,
  clearAssistantsCache,
  connectClient,
  customAssistantsPath,
  enhancedPath,
  listAssistantsAsync,
  spawnEnv,
} from '../../packages/mcp/src/clients.mjs';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'mcp', 'src');

describe('F-FIX-A 路径基数 / 增强 PATH / recheck', () => {
  let root;
  let mebularHome;
  let userHome;
  const opts = (extra = {}) => ({
    home: mebularHome, userHome, cwd: userHome, platform: 'darwin', env: {},
    run: () => ({ ok: true, code: 0, stdout: '', stderr: '' }), ...extra,
  });

  beforeEach(async () => {
    clearAssistantsCache();
    root = await mkdtemp(join(tmpdir(), 'ffixa-'));
    mebularHome = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(mebularHome, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });
  afterEach(async () => {
    clearAssistantsCache();
    await rm(root, { recursive: true, force: true });
  });

  // ---------- (a) 双 home 快照 ----------

  it('a) 内置条目的落面/禁写/技能/探测路径全部以 userHome 为基，且不含 Mebular home', () => {
    for (const a of builtinAssistants(opts())) {
      const signals = (a.probe.signals ?? []).filter((s) => s.kind !== 'app-bundle'); // app-bundle 是系统路径
      const paths = [
        a.landing.primaryPath,
        ...(a.landing.forbiddenPaths ?? []),
        ...(a.skillsDirs ?? []),
        ...signals.flatMap((s) => s.paths ?? []),
      ].filter((p) => typeof p === 'string' && p.length > 0);
      for (const p of paths) {
        expect(p.startsWith(userHome)).toBe(true);
        expect(p.includes(mebularHome)).toBe(false); // 真机事故：不得出现 <MEBULAR_HOME>/.config/…
      }
    }
  });

  it('a2) 内置关键路径快照（真机值）；Mebular 自有文件仍在 Mebular home', () => {
    const list = builtinAssistants(opts());
    const oc = list.find((a) => a.id === 'openchamber');
    const hermes = list.find((a) => a.id === 'hermes');
    expect(oc.landing.primaryPath).toBe(join(userHome, '.config', 'opencode', 'opencode.json'));
    expect(oc.landing.forbiddenPaths).toEqual([join(userHome, '.config', 'openchamber', 'opencode.managed.json')]);
    expect(hermes.landing.primaryPath).toBe(join(userHome, '.hermes', 'config.yaml'));
    expect(hermes.probe.signals.some((s) => (s.paths ?? []).includes(join(userHome, '.local', 'bin', 'hermes')))).toBe(true);
    // Mebular 自有文件：仍以 Mebular home 为基（两 home 显式分离）
    expect(customAssistantsPath(mebularHome)).toBe(join(mebularHome, 'assistants.custom.json'));
    expect(customAssistantsPath(mebularHome).startsWith(mebularHome)).toBe(true);
    expect(customAssistantsPath(mebularHome).includes(userHome)).toBe(false);
  });

  it('a3) 用户主目录解析：显式 userHome > MEBULAR_USER_HOME > os.homedir()', () => {
    expect(assistantUserHome({ userHome: '/u1', env: { MEBULAR_USER_HOME: '/u2' } })).toBe('/u1');
    expect(assistantUserHome({ env: { MEBULAR_USER_HOME: '/u2' } })).toBe('/u2');
    const os = assistantUserHome({ env: {} });
    expect(typeof os).toBe('string');
    expect(os.startsWith('/')).toBe(true);
    // 绝不回退到 Mebular home
    expect(assistantUserHome({ home: '/mebular', env: {} })).toBe(os);
  });

  // ---------- (b) 增强 PATH ----------

  it('b) enhancedPath 含 ~/.local/bin + /usr/local/bin + /opt/homebrew/bin（捆綁目录存在才加）', () => {
    const p = enhancedPath('/usr/bin:/bin', userHome);
    const parts = p.split(':');
    expect(parts).toContain(join(userHome, '.local', 'bin'));
    expect(parts).toContain('/usr/local/bin');
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts).toContain('/usr/bin');            // 原有 PATH 保留
    expect(new Set(parts).size).toBe(parts.length); // 去重
    const bundle = '/Applications/OpenChamber.app/Contents/Resources/opencode-cli';
    expect(parts.includes(bundle)).toBe(existsSync(bundle));
  });

  it('b2) spawnEnv：子进程环境带增强 PATH（含最小 PATH 场景）', () => {
    const env = spawnEnv({ userHome });
    expect(env.PATH).toContain(join(userHome, '.local', 'bin'));
    expect(env.PATH).toContain('/opt/homebrew/bin');
    // 最小 PATH 输入也照样增强
    expect(enhancedPath('/usr/bin:/bin', userHome)).toContain(join(userHome, '.local', 'bin'));
  });

  it('b3) 探针/写入/验证的命令均走增强 PATH（源码锚点：spawn 环境统一注入）', async () => {
    const clients = await readFile(join(srcRoot, 'clients.mjs'), 'utf-8');
    expect(clients).toMatch(/env: spawnEnv\(options\)/);                  // 同步 runner
    expect(clients).toMatch(/windowsHide: true, env: spawnEnv\(options\)/); // 异步 runner
    // connectViaCli / verifyAssistant 的默认 runner 均复用 defaultRun（→ 增强 PATH）
    expect(clients).toMatch(/options\.run \?\? \(\(cmd\) => defaultRun\(cmd, 30000\)\)/);
    expect(clients).toMatch(/defaultRun\(cmd, timeoutMs \?\? cli\.timeoutMs \?\? 5000\)/);
  });

  // ---------- (c) recheck ----------

  it('c) recheck：端点已注册（写模式 + 动作正则 + 处理分支），语义=强制刷新', async () => {
    const serve = await readFile(join(srcRoot, 'serve.mjs'), 'utf-8');
    expect(serve).toMatch(/clients\\\/\(\[\^\/\]\+\)\\\/\(connect\|rollback\|skills\|preview\|verify\|recheck\)/);
    expect(serve).toMatch(/action === 'recheck'/);
    expect(serve).toMatch(/refresh: true \}/);
    expect(serve).toMatch(/unknown_client/);
    // 行为：recheck 等价「强制刷新后的该客户端状态」——写后可见
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ theme: 'dark' }, null, 2));
    const okAsync = async () => ({ ok: true, code: 0, stdout: '', stderr: '' });
    const before = await listAssistantsAsync(opts({ runAsync: okAsync }));
    expect(before.assistants.find((a) => a.id === 'opencode').state).toBe('not-connected');
    await connectClient('opencode', opts());
    const re = await listAssistantsAsync(opts({ runAsync: okAsync, refresh: true }));
    expect(re.cached).toBe(false);
    expect(re.assistants.find((a) => a.id === 'opencode').state).toBe('connected');
  });
});
