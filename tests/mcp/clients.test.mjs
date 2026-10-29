// H-1 · 「连接我的 AI 助手」单元测试（侦测 / 合并 / 幂等 / 备份 / 回滚 / 解析失败不写）
//
// 全部在临时 home 中进行（不触碰真实用户目录）。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assistantState,
  clearAssistantsCache,
  clientDescriptors,
  detectClients,
  descriptorFor,
  connectClient,
  rollbackClient,
  listAssistants,
  normalizeMcpUrl,
  previewClient,
  mergeJsonEntry,
  installSkills,
  reconcileClientEndpoints,
  repairClients,
  sameMcpUrl,
  verifyAssistant,
} from '../../packages/mcp/src/clients.mjs';

// F-HYGIENE-1/F-FIX-A：本夹具含真实 fs + 合并/回滚往返，全量并行下会超默认 5s；给显式有界预算。
jest.setTimeout(process.platform === 'win32' ? 30_000 : 15_000);

describe('H-1 clients：侦测与合并写入', () => {
  let root;
  let home;      // Mebular home（自有文件：assistants.custom.json 等）
  let userHome;  // 用户主目录（assistant 落面基）——F-FIX-A：两者**必须**不同，否则伪绿
  const opts = () => ({ home, userHome, cwd: userHome, platform: 'darwin', env: {} });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'h1-clients-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('mergeJsonEntry：只并 mebular（A-17 键位 mcp.servers.mebular），保留其他键；结构/解析异常退回 error', () => {
    const r = mergeJsonEntry('{"theme":"dark","mcp":{"other":{"x":1}}}', { format: 'opencode', entry: { type: 'local', command: ['mebular', 'mcp'] } });
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(r.text);
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp.other).toEqual({ x: 1 });
    expect(parsed.mcp.servers.mebular).toEqual({ type: 'local', command: ['mebular', 'mcp'] });
    expect(parsed.mcp.mebular).toBeUndefined(); // A-17：不得写成旧形状
    expect(mergeJsonEntry('{ not json', { format: 'opencode', entry: {} }).error).toMatch(/不是合法 JSON/);
    expect(mergeJsonEntry('[]', { format: 'opencode', entry: {} }).error).toMatch(/顶层不是对象/);
    expect(mergeJsonEntry('{"mcp": 5}', { format: 'opencode', entry: {} }).error).toMatch(/mcp 结构未知/);
  });

  it('侦测：未接入 → 接入（备份 + 合并）→ 幂等（不再改/不再备份）→ 回滚', async () => {
    const cfgDir = join(userHome, '.config', 'opencode');
    await mkdir(cfgDir, { recursive: true });
    const cfg = join(cfgDir, 'opencode.json');
    await writeFile(cfg, JSON.stringify({ $schema: 'x', theme: 'dark' }, null, 2));

    const before = detectClients(opts()).find((c) => c.id === 'opencode');
    expect(before.installed).toBe(true);
    expect(before.connected).toBe(false);

    const pv = previewClient('opencode', opts());
    expect(pv.changed).toBe(true);
    expect(pv.preview).toMatch(/\+.*mebular/);

    const first = await connectClient('opencode', opts());
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeTruthy();
    const parsed = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp.servers.mebular).toEqual({ type: 'local', command: ['mebular', 'mcp'] });

    const backups = (await readdir(cfgDir)).filter((f) => f.includes('.bak-'));
    expect(backups).toHaveLength(1);

    const second = await connectClient('opencode', opts());
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect((await readdir(cfgDir)).filter((f) => f.includes('.bak-'))).toHaveLength(1);

    const roll = await rollbackClient('opencode', opts());
    expect(roll.ok).toBe(true);
    const after = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(after.mcp?.servers?.mebular).toBeUndefined();
    expect(after.mcp?.mebular).toBeUndefined();
    expect(after.theme).toBe('dark');
  });

  it('解析失败 → 不写（needsManual + 片段），文件保持原样', async () => {
    const dir = join(userHome, '.cursor');
    await mkdir(dir, { recursive: true });
    const cfg = join(dir, 'mcp.json');
    await writeFile(cfg, '{ not json');
    const res = await connectClient('cursor', opts());
    expect(res.ok).toBe(false);
    expect(res.needsManual).toBe(true);
    expect(res.snippet).toMatch(/mcpServers/);
    expect(await readFile(cfg, 'utf-8')).toBe('{ not json');
  });

  it('OpenChamber 复用 opencode 配置（同一路径）', () => {
    const desc = clientDescriptors(opts());
    const oc = desc.find((d) => d.id === 'opencode');
    const chamber = desc.find((d) => d.id === 'openchamber');
    expect(chamber.configPath).toBe(oc.configPath);
    expect(chamber.reuseOf).toBe('opencode');
  });

  it('DSH(YAML)：空文件写片段；已含则幂等；结构未知不写', async () => {
    const dshDir = join(userHome, '.dsh');
    await mkdir(dshDir, { recursive: true });
    const cfg = join(dshDir, 'cordis.yml');
    const first = await connectClient('dsh', opts());
    expect(first.changed).toBe(true);
    expect(await readFile(cfg, 'utf-8')).toMatch(/serverName: mebular/);
    const second = await connectClient('dsh', opts());
    expect(second.changed).toBe(false);
    await writeFile(cfg, 'plugins:\n  - name: other\n');
    const third = await connectClient('dsh', opts());
    expect(third.ok).toBe(false);
    expect(third.needsManual).toBe(true);
  });

  it('generic：无配置路径 → needsManual + 片段', async () => {
    const res = await connectClient('generic', opts());
    expect(res.ok).toBe(false);
    expect(res.needsManual).toBe(true);
    expect(res.snippet).toMatch(/mcpServers/);
  });

  it('Skill 安装：显式 skillRoot 注入优先；默认装到首个 skill 目录', async () => {
    const fakeRoot = join(home, 'fake-skill');
    await mkdir(join(fakeRoot, 'tasks'), { recursive: true });
    await mkdir(join(fakeRoot, 'mcp'), { recursive: true });
    await writeFile(join(fakeRoot, 'SKILL.md'), 'S', 'utf-8');
    await writeFile(join(fakeRoot, 'MEMORY_POLICY.md'), 'M', 'utf-8');
    await writeFile(join(fakeRoot, 'SETUP.md'), 'U', 'utf-8');
    await writeFile(join(fakeRoot, 'tasks', 'SKILL.md'), 'T', 'utf-8');
    await writeFile(join(fakeRoot, 'mcp', 'opencode.json'), '{"mcp":{}}', 'utf-8');
    const injected = await installSkills('opencode', { ...opts(), skillRoot: fakeRoot });
    expect(injected.ok).toBe(true);
    expect(injected.installed.length).toBe(2);
    const mem = join(userHome, '.config', 'opencode', 'skills', 'mebular-memory', 'SKILL.md');
    expect(await readFile(mem, 'utf-8')).toBe('S');

    const ok = await installSkills('opencode', { ...opts() });
    expect(ok.ok).toBe(true);
    const skillDir = join(userHome, '.config', 'opencode', 'skills');
    expect((await readdir(skillDir)).sort()).toEqual(['mebular-memory', 'mebular-tasks']);
  });

  it('安装态（cwd=临时目录、未给 skillRoot）也能找到 Skill 源（模块相对解析）', async () => {
    const prev = process.cwd();
    process.chdir(home); // 模拟服务托管/安装态：cwd=守护 home（非仓库）
    try {
      const ok = await installSkills('opencode', { ...opts() }); // 不给 skillRoot / repoRoot
      expect(ok.ok).toBe(true);
      expect(ok.installed.length).toBe(2);
      const skillDir = join(userHome, '.config', 'opencode', 'skills');
      expect((await readdir(skillDir)).sort()).toEqual(['mebular-memory', 'mebular-tasks']);
    } finally {
      process.chdir(prev);
    }
  });
});

// ---------------------------------------------------------------------------
// 走查事故回归：回滚必须还原到「不含 mebular」的真实接入前快照
// （旧实现取最新备份——连续连接/回滚的安全备份已含 mebular → 回滚实为无操作）
// ---------------------------------------------------------------------------

describe('rollbackClient：取最新「不含 mebular」备份（接入前快照）', () => {
  it('备份链 干净→接入→再备份(含) → 回滚必须还原到干净快照（而非最新含项备份）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rb-userhome-'));
    const mebularHome = join(tmpdir(), `rb-mebular-${Date.now()}`);
    const primary = join(home, '.config', 'opencode', 'opencode.json');
    await (await import('node:fs/promises')).mkdir(dirname(primary), { recursive: true });
    // 时间线模拟：B1=干净备份 → 写入含 mebular 的现文件 → B2=含 mebular 的安全备份（rollback 自身会再产）
    await writeFile(`${primary}.bak-2026-01-01T00-00-00-000Z`, JSON.stringify({ theme: 'dark' }, null, 2));
    await writeFile(primary, JSON.stringify({ theme: 'dark', mcp: { servers: { mebular: { type: 'remote', url: 'http://127.0.0.1:7331/mcp' } } } }, null, 2));
    await writeFile(`${primary}.bak-2026-01-02T00-00-00-000Z`, await readFile(primary, 'utf-8')); // 含项的最新备份（旧实现的陷阱）

    const res = await rollbackClient('opencode', { home: mebularHome, userHome: home, cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.restoredFrom).toContain('2026-01-01'); // 命中干净快照，而不是 01-02 的含项备份
    const after = JSON.parse(await readFile(primary, 'utf-8'));
    expect(after.mcp).toBeUndefined(); // mebular 已随干净快照移除
    expect(after.theme).toBe('dark');  // 其余键无损
    // 回滚后的探针状态：不再 connected
    const items = listAssistants({ home: mebularHome, userHome: home, cwd: process.cwd() }).assistants;
    expect(items.find((c) => c.id === 'opencode').state).not.toBe('connected');
  });

  it('无任何干净备份（全都含 mebular）→ 走摘除路径 removed:true；无备份且无条目 → 报无需回滚', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rb2-userhome-'));
    const primary = join(home, '.config', 'opencode', 'opencode.json');
    await (await import('node:fs/promises')).mkdir(dirname(primary), { recursive: true });
    // 全含备份 → find 找不到干净候选 → target=null → 摘除路径
    await writeFile(primary, JSON.stringify({ theme: 'dark', mcp: { servers: { mebular: { type: 'remote', url: 'http://127.0.0.1:7331/mcp' } } } }, null, 2));
    await writeFile(`${primary}.bak-2026-01-03T00-00-00-000Z`, await readFile(primary, 'utf-8'));
    const res = await rollbackClient('opencode', { home: join(tmpdir(), `rb2-mebular-${Date.now()}`), userHome: home, cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(true);
    const after = JSON.parse(await readFile(primary, 'utf-8'));
    // 摘除路径：条目必须消失（允许留空壳对象——合并器的既有形态）
    expect(after.mcp?.servers?.mebular).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 回归：旧 loopback MCP URL（升级前端口）不得冒充「已接入」；显式修复写回当前端点
// （真机事故：Hermes 配置仍是 56007，runtime 已监听 7331，列表却报 connected）
// ---------------------------------------------------------------------------

describe('MCP URL 陈旧检测与自动修复', () => {
  const CURRENT = 'http://127.0.0.1:7331/mcp';
  const OLD = 'http://127.0.0.1:56007/mcp';
  let root;
  let home;
  let userHome;
  const opts = (extra = {}) => ({
    home,
    userHome,
    cwd: userHome,
    platform: 'darwin',
    env: {},
    run: () => ({ ok: false, code: 1, stdout: '', stderr: '' }),
    ...extra,
  });

  const hermesFixture = (url) => [
    'model: x',
    'mcp_servers:',
    '  openchamber:',
    '    command: python3',
    '  mebular:',
    `    url: ${url}`,
    '    enabled: true',
    '',
  ].join('\n');

  beforeEach(async () => {
    clearAssistantsCache();
    root = await mkdtemp(join(tmpdir(), 'stale-mcp-url-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });
  afterEach(async () => {
    clearAssistantsCache();
    await rm(root, { recursive: true, force: true });
  });

  it('URL 归一化：末尾 / 等价；端口不同必须不匹配', () => {
    expect(normalizeMcpUrl(`${CURRENT}/`)).toBe(CURRENT);
    expect(sameMcpUrl(`${CURRENT}/`, CURRENT)).toBe(true);
    expect(sameMcpUrl('http://localhost:7331/mcp', CURRENT)).toBe(true);
    expect(sameMcpUrl(OLD, CURRENT)).toBe(false);
  });

  it('控制台经 LAN 访问（同端口/路径）不把 loopback 配置误判 stale', async () => {
    const cfg = join(userHome, '.cursor', 'mcp.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcpServers: { mebular: { url: CURRENT } } }, null, 2));
    const st = assistantState(descriptorFor('cursor', opts()), opts({ mcpUrl: 'http://192.168.1.20:7331/mcp' }));
    expect(st.state).toBe('connected');
    expect(st.staleUrl).toBe(false);
  });

  it('Hermes YAML：旧 56007 URL → stale（非 connected）+ 可读 reason；末尾 / → connected', async () => {
    const cfg = join(userHome, '.hermes', 'config.yaml');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, hermesFixture(OLD));

    const stale = assistantState(descriptorFor('hermes', opts()), opts({ mcpUrl: CURRENT }));
    expect(stale.state).toBe('stale');
    expect(stale.connected).toBe(false);
    expect(stale.stateLabel).toMatch(/配置已过期/);
    expect(stale.staleUrl).toBe(true);
    expect(stale.staleKind).toBe('url');
    expect(stale.landing.staleUrl).toBe(true);
    expect(stale.landing.staleStdio).toBe(false); // 端口漂移不是 stdio 形态
    expect(stale.landing.configuredUrl).toBe(OLD);
    expect(stale.landing.expectedUrl).toBe(CURRENT);
    expect(stale.landing.staleReason).toContain('56007');
    expect(stale.landing.staleReason).toContain('7331');
    expect(stale.mcpUrl).toBe(CURRENT);
    expect(stale.configuredUrl).toBe(OLD);

    await writeFile(cfg, hermesFixture(`${CURRENT}/`));
    const same = assistantState(descriptorFor('hermes', opts()), opts({ mcpUrl: CURRENT }));
    expect(same.state).toBe('connected');
    expect(same.staleUrl).toBe(false);
    expect(same.landing.staleUrl).toBe(false);
  });

  it('Hermes YAML 显式修复：写回当前 URL、保留其他 server，verifyAssistant 通过', async () => {
    const cfg = join(userHome, '.hermes', 'config.yaml');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, hermesFixture(OLD));
    const prefix = 'hermes config set --force mcp_servers.mebular ';
    const runAsync = async (cmd) => {
      if (cmd.startsWith(prefix)) {
        const entry = JSON.parse(JSON.parse(cmd.slice(prefix.length)));
        await writeFile(cfg, hermesFixture(entry.url));
        return { ok: true, code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'hermes config get mcp_servers') {
        return { ok: true, code: 0, stdout: await readFile(cfg, 'utf-8'), stderr: '' };
      }
      if (cmd === 'hermes mcp test mebular') {
        return { ok: true, code: 0, stdout: '✓ Connected\nTools discovered: 29', stderr: '' };
      }
      return { ok: false, code: 1, stdout: '', stderr: '' };
    };

    const repaired = await connectClient('hermes', opts({ mcpUrl: CURRENT, runAsync, skipSkills: true }));
    expect(repaired.ok).toBe(true);
    expect(repaired.changed).toBe(true);
    const text = await readFile(cfg, 'utf-8');
    expect(text).toContain(`url: ${CURRENT}`);
    expect(text).not.toContain('56007');
    expect(text).toContain('openchamber'); // 其他 MCP server 不丢

    const verify = await verifyAssistant('hermes', opts({ mcpUrl: CURRENT, runAsync }));
    expect(verify.ok).toBe(true);
    expect(verify.state).toBe('connected'); // Hermes activation=hot
    expect(verify.steps.find((step) => step.name === 'readback')?.ok).toBe(true);
  });

  it('启动自愈：Hermes 旧 loopback URL 自动更新为当前，保留其他 server，不 force Skill', async () => {
    const cfg = join(userHome, '.hermes', 'config.yaml');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, hermesFixture(OLD));
    const skill = join(userHome, '.hermes', 'skills', 'mebular-memory', 'SKILL.md');
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(skill, 'CUSTOM USER SKILL', 'utf-8');
    const prefix = 'hermes config set --force mcp_servers.mebular ';
    const runAsync = async (cmd) => {
      if (cmd.startsWith(prefix)) {
        const entry = JSON.parse(JSON.parse(cmd.slice(prefix.length)));
        await writeFile(cfg, hermesFixture(entry.url));
        return { ok: true, code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'hermes config get mcp_servers') {
        return { ok: true, code: 0, stdout: await readFile(cfg, 'utf-8'), stderr: '' };
      }
      return { ok: false, code: 1, stdout: '', stderr: '' };
    };

    const out = await reconcileClientEndpoints(opts({ mcpUrl: CURRENT, runAsync }));
    expect(out.ok).toBe(true);
    expect(out.summary).toMatchObject({ total: 1, changed: 1, failed: 0 });
    const text = await readFile(cfg, 'utf-8');
    expect(text).toContain(`url: ${CURRENT}`);
    expect(text).not.toContain('56007');
    expect(text).toContain('openchamber'); // 其他 MCP server 不丢
    expect(await readFile(skill, 'utf-8')).toBe('CUSTOM USER SKILL'); // 不 force Skill
    // 幂等：第二次无可改项，不产生新备份
    const again = await reconcileClientEndpoints(opts({ mcpUrl: CURRENT, runAsync }));
    expect(again.summary).toMatchObject({ total: 0, changed: 0, failed: 0 });
    expect((await readdir(join(userHome, '.hermes'))).filter((f) => f.includes('.bak-'))).toHaveLength(1);
  });

  it('启动自愈：OpenCode 旧 URL 自动更新、其他 server 保留、幂等', async () => {
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({
      theme: 'dark',
      mcp: { servers: { other: { keep: 1 }, mebular: { type: 'remote', url: OLD } } },
    }, null, 2));

    const first = await reconcileClientEndpoints(opts({ mcpUrl: CURRENT }));
    expect(first.ok).toBe(true);
    expect(first.summary.failed).toBe(0);
    expect(first.summary.changed).toBeGreaterThanOrEqual(1);
    const written = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(written.theme).toBe('dark');
    expect(written.mcp.servers.other).toEqual({ keep: 1 });
    expect(written.mcp.servers.mebular).toEqual({ type: 'remote', url: CURRENT });

    const second = await reconcileClientEndpoints(opts({ mcpUrl: CURRENT }));
    expect(second.summary).toMatchObject({ total: 0, changed: 0, failed: 0 });
  });

  it('自定义远端 URL 不自动覆盖：状态为需要修复/请确认，显式修复才重置', async () => {
    const cfg = join(userHome, '.cursor', 'mcp.json');
    await mkdir(dirname(cfg), { recursive: true });
    const remote = 'https://mcp.example.com/mcp';
    await writeFile(cfg, JSON.stringify({ mcpServers: { mebular: { url: remote } } }, null, 2));

    const out = await reconcileClientEndpoints(opts({ mcpUrl: CURRENT }));
    expect(out.summary).toMatchObject({ total: 0, changed: 0, failed: 0 });
    expect(JSON.parse(await readFile(cfg, 'utf-8')).mcpServers.mebular).toEqual({ url: remote });

    const st = assistantState(descriptorFor('cursor', opts()), opts({ mcpUrl: CURRENT }));
    expect(st.state).toBe('needs-confirmation');
    expect(st.connected).toBe(false);
    expect(st.needsConfirmation).toBe(true);
    expect(st.staleUrl).toBe(false);
    expect(st.landing.configuredUrl).toBe(remote);

    // 显式兜底：用户确认后手动修复才按当前端点重置。
    const repaired = await connectClient('cursor', opts({ mcpUrl: CURRENT, skipSkills: true }));
    expect(repaired.ok).toBe(true);
    expect(repaired.changed).toBe(true);
    expect(JSON.parse(await readFile(cfg, 'utf-8')).mcpServers.mebular).toEqual({ url: CURRENT });
  });

  it('OpenCode/OpenChamber JSON：旧 URL 经 repairClients 写回当前 URL，其他 server 保留', async () => {
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({
      theme: 'dark',
      mcp: {
        servers: {
          other: { keep: 1 },
          mebular: { type: 'remote', url: OLD },
        },
      },
    }, null, 2));

    const before = assistantState(descriptorFor('opencode', opts()), opts({ mcpUrl: CURRENT }));
    expect(before.state).toBe('stale');
    expect(before.connected).toBe(false);
    expect(before.landing.configuredUrl).toBe(OLD);

    const runAsync = async (cmd) => {
      if (cmd === 'opencode mcp list') {
        return { ok: true, code: 0, stdout: `mebular ${CURRENT}`, stderr: '' };
      }
      return { ok: false, code: 1, stdout: '', stderr: '' };
    };
    const verifyBefore = await verifyAssistant('opencode', opts({ mcpUrl: CURRENT, runAsync }));
    expect(verifyBefore.ok).toBe(false);
    expect(verifyBefore.steps.find((step) => step.name === 'readback')?.detail).toContain('56007');

    const out = await repairClients(opts({ mcpUrl: CURRENT, runAsync }));
    const opencode = out.clients.find((entry) => entry.id === 'opencode');
    expect(opencode).toBeTruthy();
    expect(opencode.stateBefore).toBe('stale');
    expect(opencode.verify).toMatchObject({ ok: true });
    expect(['pending-restart', 'connected']).toContain(opencode.stateAfter);

    const written = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(written.theme).toBe('dark');
    expect(written.mcp.servers.other).toEqual({ keep: 1 });
    expect(written.mcp.servers.mebular).toEqual({ type: 'remote', url: CURRENT });

    const after = assistantState(descriptorFor('opencode', opts()), opts({ mcpUrl: CURRENT }));
    expect(after.state).toBe('connected');
    expect(after.staleUrl).toBe(false);
  });

  it('DSH YAML streamable-http：旧 URL 判 stale，修复只改 mebular url、保留其他插件', async () => {
    const cfg = join(userHome, '.dsh', 'cordis.yml');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, [
      'plugins:',
      "  - name: '@deepseek-ai/dsh-mcp-client'",
      '    config:',
      '      serverName: mebular',
      '      transport: streamable-http',
      `      url: ${OLD}`,
      '  - name: other-plugin',
      '    config:',
      '      keep: 1',
      '',
    ].join('\n'));

    const st = assistantState(descriptorFor('dsh', opts()), opts({ mcpUrl: CURRENT }));
    expect(st.state).toBe('stale');
    expect(st.landing.staleUrl).toBe(true);

    const res = await connectClient('dsh', opts({ mcpUrl: CURRENT, skipSkills: true }));
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    const text = await readFile(cfg, 'utf-8');
    expect(text).toContain(`url: ${CURRENT}`);
    expect(text).not.toContain('56007');
    expect(text).toContain('other-plugin'); // 其他插件不丢
  });

  it('Cursor / Claude Code 的 HTTP 形态走同一判断（不只修 Hermes）', async () => {
    const cursorCfg = join(userHome, '.cursor', 'mcp.json');
    await mkdir(dirname(cursorCfg), { recursive: true });
    await writeFile(cursorCfg, JSON.stringify({ mcpServers: { mebular: { url: OLD } } }, null, 2));
    const cursor = assistantState(descriptorFor('cursor', opts()), opts({ mcpUrl: CURRENT }));
    expect(cursor.state).toBe('stale');
    expect(cursor.landing.staleUrl).toBe(true);

    const claudeCfg = join(userHome, '.claude.json');
    await writeFile(claudeCfg, JSON.stringify({ mcpServers: { mebular: { type: 'http', url: OLD } } }, null, 2));
    const claude = assistantState(descriptorFor('claude-code', opts()), opts({ mcpUrl: CURRENT }));
    expect(claude.state).toBe('stale');
    expect(claude.landing.staleUrl).toBe(true);

    const repaired = await connectClient('cursor', opts({ mcpUrl: CURRENT, skipSkills: true }));
    expect(repaired.ok).toBe(true);
    expect(repaired.changed).toBe(true);
    expect(JSON.parse(await readFile(cursorCfg, 'utf-8')).mcpServers.mebular).toEqual({ url: CURRENT });
  });
});
