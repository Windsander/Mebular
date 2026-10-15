// UX-2 · 助手注册表 / 三态证据 / 写入器 / 验证器 / 自定义条目（A-1..A-19 数据面）
//
// 全部在临时 home 中、CLI 与进程列表一律注入替身（不触碰真实用户目录/CLI）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORMAT_ADAPTERS,
  addCustomAssistant,
  assistantState,
  builtinAssistants,
  connectClient,
  customAssistantsPath,
  descriptorFor,
  detectClients,
  listAssistants,
  mergeJsonEntry,
  parseVerifyOutput,
  redactSecrets,
  registry,
  removeCustomAssistant,
  rollbackClient,
  updateCustomAssistant,
  validateAssistant,
  verifyAssistant,
  yamlHasKey,
} from '../../packages/mcp/src/clients.mjs';

const runOk = () => ({ ok: true, code: 0, stdout: '', stderr: '' });
const runFail = () => ({ ok: false, code: 1, stdout: '', stderr: 'boom' });

describe('UX-2 助手注册表 / 写入器 / 验证器', () => {
  let root;
  let home;      // Mebular home
  let userHome;  // 用户主目录（F-FIX-A：与 home **不同**）
  const opts = (extra = {}) => ({ home, userHome, cwd: userHome, platform: 'darwin', env: {}, run: runOk, processList: '', ...extra });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ux2-assistants-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ---------- A-1 / A-2：注册表驱动 + 三态证据 ----------

  it('A-1：/clients 数据面 = 内置 ∪ 自定义；新增自定义即出现，去重按 id', async () => {
    const before = listAssistants(opts()).assistants.map((a) => a.id);
    expect(before).toEqual(expect.arrayContaining(['openchamber', 'hermes', 'opencode', 'generic']));
    const added = await addCustomAssistant({
      id: 'my-assistant', name: 'My Assistant', kind: 'file',
      landing: { primaryPath: join(home, 'my.json'), keyPath: 'mcpServers.mebular', forbiddenPaths: [], format: 'json-mcpServers' },
      probe: { signals: [{ kind: 'config-path', paths: [join(home, 'my.json')] }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true },
      activation: { kind: 'user-reload', note: 'x' },
    }, opts());
    expect(added.ok).toBe(true);
    const after = listAssistants(opts()).assistants;
    expect(after.map((a) => a.id)).toContain('my-assistant');
    expect(after.find((a) => a.id === 'my-assistant').registryKind).toBe('custom');
    expect(after.find((a) => a.id === 'openchamber').registryKind).toBe('builtin');
    // 自定义文件位置（契约 §七）
    expect(existsSync(customAssistantsPath(home))).toBe(true);
    const dup = await addCustomAssistant({ ...added, id: 'my-assistant' }, opts());
    expect(dup.ok).toBe(false);
  });

  it('A-2：每条含 state/evidence（逐信号命中+来源）/hasVerify/activation', () => {
    const items = listAssistants(opts()).assistants;
    for (const item of items) {
      expect(typeof item.state).toBe('string');
      expect(Array.isArray(item.evidence)).toBe(true);
      expect(item.evidence.length).toBeGreaterThan(0);
      for (const ev of item.evidence) {
        expect(typeof ev.kind).toBe('string');
        expect(typeof ev.source).toBe('string');
        expect(typeof ev.hit).toBe('boolean');
        expect(typeof ev.detail).toBe('string');
      }
      expect(typeof item.hasVerify).toBe('boolean');
      expect(item.activation.kind === 'hot' || item.activation.kind === 'user-reload').toBe(true);
    }
  });

  it('A-4：配置缺但 CLI 在 → 未接入（不假阴性）；CLI 缺 → 仍如实给证据（不假阳性静默）', async () => {
    const opencodePath = join(userHome, '.config', 'opencode', 'opencode.json');
    // 只有 CLI（config-path 未命中，cli 命中）→ 未接入
    const onlyCli = assistantState(descriptorFor('opencode', opts()), opts({ run: (cmd) => (cmd.startsWith('opencode') ? runOk() : runFail()) }));
    expect(onlyCli.state).toBe('not-connected');
    expect(onlyCli.evidence.find((e) => e.kind === 'config-path').hit).toBe(false);
    expect(onlyCli.evidence.find((e) => e.kind === 'cli').hit).toBe(true);
    // CLI 不在但有配置文件 → 仍报「已装·未接入」并标明 cli 未命中（不假阳性静默）
    await mkdir(dirname(opencodePath), { recursive: true });
    await writeFile(opencodePath, JSON.stringify({ theme: 'dark' }, null, 2));
    const noCli = assistantState(descriptorFor('opencode', opts({ run: runFail })), opts({ run: runFail }));
    expect(noCli.state).toBe('not-connected');
    expect(noCli.evidence.find((e) => e.kind === 'cli').hit).toBe(false);
    expect(noCli.evidence.find((e) => e.kind === 'config-path').hit).toBe(true);
  });

  // ---------- A-3 / A-17 / A-19：落面形状与红线 ----------

  it('A-3：OpenChamber 落面 = global opencode.json 的 mcp.servers.mebular，且 managed 文件在禁写清单', () => {
    const a = descriptorFor('openchamber', opts());
    expect(a.landing.primaryPath).toBe(join(userHome, '.config', 'opencode', 'opencode.json'));
    expect(a.landing.keyPath).toBe('mcp.servers.mebular');
    const managed = join(userHome, '.config', 'openchamber', 'opencode.managed.json');
    expect(a.landing.forbiddenPaths).toContain(managed);
    // 行为面：即使有人把落面指向禁写路径，写入也必须被拒
    return addCustomAssistant({
      id: 'evil', name: 'Evil', kind: 'file',
      landing: { primaryPath: managed, keyPath: 'mcp.servers.mebular', forbiddenPaths: [managed], format: 'opencode-json' },
      probe: { signals: [{ kind: 'config-path', paths: [managed] }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true }, activation: { kind: 'user-reload', note: '' },
    }, opts()).then(async (added) => {
      expect(added.ok).toBe(true);
      const res = await connectClient('evil', opts());
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/禁写路径/);
      expect(existsSync(managed)).toBe(false);
    });
  });

  it('A-17：写入产出键位 = mcp.servers.<name>（与 `opencode mcp add` 产出同形），且无旧形状', () => {
    // F-EXP-1 沙箱实测的 `opencode mcp add` 产出（真源形状）
    const opencodeMcpAddShape = { mcp: { servers: { mebular: { type: 'local', command: ['mebular', 'mcp'] } } } };
    const r = mergeJsonEntry('{}', { format: 'opencode', entry: { type: 'local', command: ['mebular', 'mcp'] } });
    expect(JSON.parse(r.text)).toEqual(opencodeMcpAddShape);
    expect(FORMAT_ADAPTERS['opencode-json'].keyPath).toEqual(['mcp', 'servers', 'mebular']);
    expect(JSON.parse(r.text).mcp.mebular).toBeUndefined();
    // 旧形状（mcp.mebular）在检测中被如实标注为不生效，而不是算「已接入」
    const legacy = assistantState(descriptorFor('opencode', opts()), opts());
    expect(legacy.state).toBe('not-connected');
  });

  it('A-17：旧错形状被判「不生效」并给出 legacyShape 证据（不冒充已接入）', async () => {
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcp: { mebular: { type: 'local', command: ['mebular', 'mcp'] } } }, null, 2));
    const st = assistantState(descriptorFor('opencode', opts()), opts());
    expect(st.state).toBe('not-connected');
    expect(st.landing.legacyShape).toBe(true);
  });

  it('A-19：实现内不得调用 `opencode reload`（生效由用户在 App 侧重载）', async () => {
    const files = [
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'mcp', 'src', 'clients.mjs'),
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'mcp', 'src', 'serve.mjs'),
    ];
    for (const f of files) {
      const text = await readFile(f, 'utf-8');
      expect(text).not.toMatch(/opencode['"]?\s*,\s*\[?\s*['"]reload/);
      expect(text).not.toMatch(/\brun\(\s*['"]opencode reload/);
      expect(text).not.toMatch(/\bexec(File|Sync)?\([^)]*opencode[^)]*reload/i);
    }
  });

  it('A-18：探针/验证输出脱敏（只留键名）', () => {
    const masked = redactSecrets('token=abc123 Authorization: Bearer xyz.abc apiKey: sk-1234567890 password: hunter2');
    expect(masked).not.toMatch(/abc123|xyz\.abc|sk-1234567890|hunter2/);
    expect(masked).toMatch(/token=<redacted>/);
    expect(masked).toMatch(/<redacted>/);
    expect(masked).toMatch(/apiKey: <redacted>/);
  });

  // ---------- 写入器：merge-key（沙箱 fixture） ----------

  it('写入器 merge-key：备份 → 原子写 → 幂等 → 其他键无损 → 回滚', async () => {
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ $schema: 'x', theme: 'dark', mcp: { other: { keep: 1 } } }, null, 2));
    const first = await connectClient('opencode', opts());
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeTruthy();
    const written = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(written.theme).toBe('dark');
    expect(written.mcp.other).toEqual({ keep: 1 });
    expect(written.mcp.servers.mebular).toEqual({ type: 'local', command: ['mebular', 'mcp'] });
    expect((await readdir(dirname(cfg))).filter((f) => f.includes('.bak-'))).toHaveLength(1);
    const second = await connectClient('opencode', opts());
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect((await readdir(dirname(cfg))).filter((f) => f.includes('.bak-'))).toHaveLength(1);
    const roll = await rollbackClient('opencode', opts());
    expect(roll.ok).toBe(true);
    const after = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(after.mcp?.servers?.mebular).toBeUndefined();
    expect(after.mcp.other).toEqual({ keep: 1 });
  });

  // ---------- 写入器：cli-set（Hermes：命令形状 + 备份 + 失败回滚） ----------

  it('A-5：Hermes 写入 = 一次写整棵子树 + 回读放置校验；失败/错位均整文件回滚', async () => {
    const cfg = join(userHome, '.hermes', 'config.yaml');
    await mkdir(dirname(cfg), { recursive: true });
    const original = 'model: x\nmcp_servers:\n  openchamber:\n    command: python3\n';
    await writeFile(cfg, original);
    const url = 'http://127.0.0.1:7331/mcp';
    // 忠实替身：`hermes config set` 真的改文件（可选「错位」写法）；`hermes config get mcp_servers` 回读
    const calls = [];
    const makeRun = ({ misplaced = false, failAfter = false } = {}) => {
      let n = 0;
      return async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('get mcp_servers')) {
          const text = await readFile(cfg, 'utf-8');
          return { ok: true, code: 0, stdout: misplaced ? 'mcp_servers:\n  openchamber:\n    command: python3\n' : text, stderr: '' };
        }
        n += 1;
        if (failAfter && n === 1) { await writeFile(cfg, `${original}partial: true\n`); return { ok: false, code: 1, stdout: '', stderr: 'boom' }; }
        const entry = misplaced
          ? `${original}  mebular:\n    command: mebular\n`        // 真机事故：块被追加到文件末尾（丢 mcp_servers: 键）
          : 'model: x\nmcp_servers:\n  openchamber:\n    command: python3\n  mebular:\n    url: http://127.0.0.1:7331/mcp\n    enabled: true\n';
        await writeFile(cfg, entry);
        return { ok: true, code: 0, stdout: '', stderr: '' };
      };
    };

    const res = await connectClient('hermes', opts({ mcpUrl: url, run: makeRun() }));
    expect(res.ok).toBe(true);
    expect(res.backupPath).toBeTruthy();
    expect(await readFile(res.backupPath, 'utf-8')).toBe(original); // 字节级备份
    // ① **单次** CLI 写入整棵子树（JSON 字面量；shell 去引号后为对象）
    expect(calls[0]).toBe(String.raw`hermes config set --force mcp_servers.mebular "{\"url\":\"http://127.0.0.1:7331/mcp\",\"enabled\":true}"`);
    // ② 回读放置校验
    expect(calls[1]).toBe('hermes config get mcp_servers');

    // 幂等：已接入 → 不写、不备份
    const again = await connectClient('hermes', opts({ mcpUrl: url, run: makeRun() }));
    expect(again.changed).toBe(false);
    expect(again.backupPath).toBeNull();

    // 写入失败 → 整文件回滚（部分写入被还原）；先复位为「未接入」以便真正走写入路径
    await writeFile(cfg, original);
    const res2 = await connectClient('hermes', opts({ mcpUrl: url, run: makeRun({ failAfter: true }) }));
    expect(res2.ok).toBe(false);
    expect(res2.rolledBack).toBe(true);
    expect(await readFile(cfg, 'utf-8')).toBe(original);

    // 放置错位（回读看不到 mcp_servers.mebular）→ 同样整文件回滚（真机事故即此处失守）
    const misplacedRes = await connectClient('hermes', opts({ mcpUrl: url, run: makeRun({ misplaced: true }) }));
    expect(misplacedRes.ok).toBe(false);
    expect(misplacedRes.rolledBack).toBe(true);
    expect(misplacedRes.reason).toMatch(/放置错位/);
    expect(await readFile(cfg, 'utf-8')).toBe(original);
  });

  it('A-5：Hermes descriptor = ~/.hermes/config.yaml + mcp_servers.mebular + hot + verify 黄金样例', () => {
    const h = descriptorFor('hermes', opts());
    expect(h.landing.primaryPath).toBe(join(userHome, '.hermes', 'config.yaml'));
    expect(h.landing.keyPath).toBe('mcp_servers.mebular');
    expect(h.writer.strategy).toBe('cli-set');
    expect(h.writer.command).toMatch(/^hermes config set --force mcp_servers\.mebular$/);
    expect(h.writer.backup).toBe('byte-level');
    expect(h.verify.cli.command).toBe('hermes mcp test mebular');
    expect(h.verify.cli.expect).toBe('✓ Connected');
    expect(h.verify.cli.minTools).toBe(1);
    expect(h.activation.kind).toBe('hot');
    // YAML 判据（行式，无需 yaml 依赖）
    expect(yamlHasKey('a: 1\nmcp_servers:\n  mebular:\n    command: x\n', 'mcp_servers', 'mebular')).toBe(true);
    expect(yamlHasKey('a: 1\nother:\n  mebular:\n    command: x\n', 'mcp_servers', 'mebular')).toBe(false);
  });

  // ---------- 验证器（A-9/A-10/A-11） ----------

  it('A-9/A-10：接入后走回读 + CLI 验证；user-reload → 待生效，确认重载后 → 已接入', async () => {
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ theme: 'dark' }, null, 2));
    await connectClient('opencode', opts({ mcpUrl: 'http://127.0.0.1:7331/mcp' }));
    const pending = await verifyAssistant('opencode', opts({ mcpUrl: 'http://127.0.0.1:7331/mcp', run: (cmd) => (cmd.startsWith('opencode') ? { ok: true, code: 0, stdout: 'mebular  pending\n', stderr: '' } : runFail()) }));
    expect(pending.ok).toBe(true);
    expect(pending.state).toBe('pending-restart');
    expect(pending.needsUserReload).toBe(true);
    expect(pending.steps.map((s) => s.name)).toEqual(['readback', 'cli']);
    const done = await verifyAssistant('opencode', opts({ mcpUrl: 'http://127.0.0.1:7331/mcp', userConfirmedReload: true, run: (cmd) => (cmd.startsWith('opencode') ? { ok: true, code: 0, stdout: 'mebular  pending\n', stderr: '' } : runFail()) }));
    expect(done.state).toBe('connected');
  });

  it('A-5/A-9：Hermes 验证解析（rc=0 ∧ ✓Connected ∧ Tools≥1）；hot 条目直达已接入', async () => {
    const cfg = join(userHome, '.hermes', 'config.yaml');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, 'mcp_servers:\n  mebular:\n    url: http://127.0.0.1:7331/mcp\n');
    const good = await verifyAssistant('hermes', opts({ run: (cmd) => (cmd.startsWith('hermes mcp test') ? { ok: true, code: 0, stdout: 'Testing…\n  ✓ Connected (12ms)\n  ✓ Tools discovered: 4\n', stderr: '' } : runOk()) }));
    expect(good.ok).toBe(true);
    expect(good.state).toBe('connected');
    expect(good.needsUserReload).toBe(false);
    const bad = await verifyAssistant('hermes', opts({ run: (cmd) => (cmd.startsWith('hermes mcp test') ? { ok: false, code: 1, stdout: '✗ failed: no tools', stderr: '' } : runOk()) }));
    expect(bad.ok).toBe(false);
    expect(bad.state).toBe('verify-failed');
    expect(bad.steps.find((s) => s.name === 'cli').output).toMatch(/failed/);
  });

  it('A-11：验证失败 → 黄态（verify-failed）+ 输出摘要；写入失败 → 原配置未动 + 备份在', async () => {
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, '{ not json');
    const res = await connectClient('opencode', opts());
    expect(res.ok).toBe(false);
    expect(res.needsManual).toBe(true);
    expect(await readFile(cfg, 'utf-8')).toBe('{ not json');
  });

  it('parseVerifyOutput：expect / toolsPattern / minTools 判据', () => {
    const cli = { expect: '✓ Connected', toolsPattern: 'Tools discovered:\\s*(\\d+)', minTools: 1 };
    expect(parseVerifyOutput(cli, '✓ Connected\nTools discovered: 3').ok).toBe(true);
    expect(parseVerifyOutput(cli, '✗ Connected failed').ok).toBe(false);
    expect(parseVerifyOutput(cli, '✓ Connected\nTools discovered: 0').ok).toBe(false);
    expect(parseVerifyOutput(cli, '✓ Connected').ok).toBe(false); // minTools 未满足
  });

  // ---------- 自定义条目（A-12/A-13 + 红线五） ----------

  it('A-12：自定义条目 CRUD；内置不可删/不可改；损坏文件不静默', async () => {
    const entry = {
      id: 'custom-x', name: 'Custom X', kind: 'file',
      landing: { primaryPath: join(home, 'cx.json'), keyPath: 'mcpServers.mebular', forbiddenPaths: [], format: 'json-mcpServers' },
      probe: { signals: [{ kind: 'config-path', paths: [join(home, 'cx.json')] }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true }, activation: { kind: 'user-reload', note: '' },
    };
    expect((await addCustomAssistant(entry, opts())).ok).toBe(true);
    expect((await updateCustomAssistant('custom-x', { name: 'Custom X2' }, opts())).ok).toBe(true);
    expect(listAssistants(opts()).assistants.find((a) => a.id === 'custom-x').name).toBe('Custom X2');
    expect((await removeCustomAssistant('opencode', opts())).ok).toBe(false); // 内置
    expect((await updateCustomAssistant('opencode', { name: 'x' }, opts())).ok).toBe(false);
    expect((await removeCustomAssistant('custom-x', opts())).ok).toBe(true);
    expect(listAssistants(opts()).assistants.map((a) => a.id)).not.toContain('custom-x');
    // 损坏 → error 上报（不静默当空）
    await writeFile(customAssistantsPath(home), '{ broken');
    const reg = registry(opts());
    expect(reg.customError).toBeTruthy();
    expect(reg.assistants.map((a) => a.id)).toContain('openchamber');
  });

  it('A-13：manual 条目无自动写入（只给片段）', async () => {
    const entry = {
      id: 'manual-y', name: 'Manual Y', kind: 'snippet',
      landing: { primaryPath: join(home, 'my.yaml'), keyPath: 'mcp_servers.mebular', forbiddenPaths: [], format: 'yaml' },
      probe: { signals: [{ kind: 'config-path', paths: [join(home, 'my.yaml')] }] },
      writer: { strategy: 'manual', command: null, backup: 'n/a', atomic: false },
      verify: { configReadback: true }, activation: { kind: 'user-reload', note: '' },
    };
    expect((await addCustomAssistant(entry, opts())).ok).toBe(true);
    const res = await connectClient('manual-y', opts());
    expect(res.ok).toBe(false);
    expect(res.needsManual).toBe(true);
    expect(res.snippet).toMatch(/mcp_servers/);
  });

  it('descriptor 校验：缺 probe.signals / 未知 format / cli-set 缺 command / backup 非 byte-level 均拒绝', () => {
    expect(validateAssistant({ id: 'a', name: 'A', landing: { format: 'opencode-json' }, probe: { signals: [] }, writer: {}, verify: {}, activation: {} }).length).toBeGreaterThan(0);
    expect(validateAssistant({ id: 'a', name: 'A', landing: { format: 'nope' }, probe: { signals: [{ kind: 'always' }] }, writer: { strategy: 'merge-key', backup: 'byte-level' }, verify: { configReadback: true }, activation: { kind: 'hot' } })).toContain('landing.format 未知：nope');
    expect(validateAssistant({ id: 'a', name: 'A', landing: { format: 'yaml' }, probe: { signals: [{ kind: 'always' }] }, writer: { strategy: 'cli-set', backup: 'byte-level' }, verify: { configReadback: true }, activation: { kind: 'hot' } }).join(' ')).toMatch(/writer.command/);
    expect(validateAssistant({ id: 'a', name: 'A', landing: { format: 'yaml' }, probe: { signals: [{ kind: 'always' }] }, writer: { strategy: 'merge-key', backup: 'none' }, verify: { configReadback: true }, activation: { kind: 'hot' } }).join(' ')).toMatch(/byte-level/);
  });

  it('兼容投影：detectClients 保留既有字段（只扩展）', () => {
    const items = detectClients(opts());
    const oc = items.find((c) => c.id === 'opencode');
    for (const key of ['installed', 'connected', 'skillsInstalled', 'requiresRestart', 'needsManual', 'snippet', 'configPath', 'skillsDirs']) {
      expect(Object.prototype.hasOwnProperty.call(oc, key)).toBe(true);
    }
    expect(oc).toHaveProperty('state');
    expect(oc).toHaveProperty('evidence');
    expect(oc).toHaveProperty('hasVerify');
    expect(oc).toHaveProperty('activation');
  });

  it('内置条目 schema 完整（六要素齐备）', () => {
    for (const a of builtinAssistants(opts())) {
      expect(a.id).toBeTruthy();
      expect(a.name).toBeTruthy();
      expect(a.probe.signals.length).toBeGreaterThan(0);
      expect(a.landing.format).toBeTruthy();
      expect(a.writer.strategy).toBeTruthy();
      expect(a.verify).toBeTruthy();
      expect(a.activation.kind).toBeTruthy();
      expect(Array.isArray(a.risks)).toBe(true);
    }
  });

  it('API 形状（给 UI 联调）：/admin/api/clients 载荷字段面（buildClientsView 委托 listAssistants）', () => {
    const out = listAssistants(opts());
    const oc = out.assistants.find((a) => a.id === 'openchamber');
    for (const key of ['id', 'name', 'kind', 'type', 'state', 'stateLabel', 'evidence', 'hasVerify', 'activation', 'landing', 'snippet', 'installed', 'connected']) {
      expect(Object.prototype.hasOwnProperty.call(oc, key)).toBe(true);
    }
    expect(oc.kind).toBe('builtin');
    expect(oc.type).toBe('file');
    expect(oc.activation.kind).toBe('user-reload');
    expect(oc.hasVerify).toBe(true);
    expect(out.customPath).toBe(customAssistantsPath(home));
  });
});
