// F-FIX-B · 接入条目形状：stdio → 守护 HTTP /mcp（旗舰路径不断头）
//
// 守护运行中 stdio `mebular mcp` 会被 MCP_STORAGE_LOCKED 拒（F-CLI-2）⇒ 条目必须指向 HTTP /mcp。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assistantState,
  descriptorFor,
  clearAssistantsCache,
  connectClient,
  daemonMcpUrl,
  listAssistants,
  mebularEntry,
  snippetFor,
} from '../../packages/mcp/src/clients.mjs';

jest.setTimeout(process.platform === 'win32' ? 30_000 : 15_000);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('F-FIX-B 条目形状 = 守护 HTTP /mcp', () => {
  let root;
  let mebularHome;
  let userHome;
  const opts = (extra = {}) => ({ home: mebularHome, userHome, cwd: userHome, platform: 'darwin', env: {}, run: () => ({ ok: true, code: 0, stdout: '', stderr: '' }), ...extra });

  beforeEach(async () => {
    clearAssistantsCache();
    root = await mkdtemp(join(tmpdir(), 'ffixb-'));
    mebularHome = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(mebularHome, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });
  afterEach(async () => {
    clearAssistantsCache();
    await rm(root, { recursive: true, force: true });
  });

  it('a) 各格式 HTTP 条目快照（含端口）；无 url 回落 stdio（后兼容）', () => {
    const url = daemonMcpUrl({ host: '127.0.0.1:7331' });
    expect(url).toBe('http://127.0.0.1:7331/mcp');
    expect(daemonMcpUrl({ host: '0.0.0.0:9000' })).toBe('http://127.0.0.1:9000/mcp'); // 归一
    expect(daemonMcpUrl({ host: '127.0.0.1:7331', encrypted: true })).toBe('https://127.0.0.1:7331/mcp');
    expect(daemonMcpUrl({})).toBe('http://127.0.0.1:7331/mcp');

    // 真源：`opencode mcp add --url …` 产出 = {type:'remote',url}（F-EXP-1/F-FIX-B 沙箱实测）
    expect(mebularEntry('opencode-json', { url })).toEqual({ type: 'remote', url });
    expect(mebularEntry('json-mcpServers', { url })).toEqual({ url }); // cursor / generic
    expect(mebularEntry('json-mcpServers', { url, httpShape: 'claude-http' })).toEqual({ type: 'http', url }); // claude
    expect(mebularEntry('hermes-yaml', { url })).toEqual({ url, enabled: true });
    expect(mebularEntry('dsh', { url })).toEqual({ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'mebular', transport: 'streamable-http', url } });

    // 回落（未给守护端点）
    expect(mebularEntry('opencode-json')).toEqual({ type: 'local', command: ['mebular', 'mcp'] });
    expect(mebularEntry('json-mcpServers')).toEqual({ command: 'mebular', args: ['mcp'] });
    expect(mebularEntry('hermes-yaml')).toEqual({ command: 'mebular', args: ['mcp'], enabled: true });
  });

  it('a2) 内置助手列表：条目/片段按守护端点产出 HTTP（descriptor 驱动）', () => {
    const url = 'http://127.0.0.1:7331/mcp';
    const items = listAssistants(opts({ mcpUrl: url })).assistants;
    const by = (id) => items.find((a) => a.id === id);
    // OpenChamber descriptor 固定 oauth:false / codemode:false（不弹 OAuth、不让 Code Mode 藏工具）
    expect(JSON.parse(by('openchamber').snippet).mcp.servers.mebular).toEqual({ type: 'remote', url, oauth: false, codemode: false });
    expect(JSON.parse(by('opencode').snippet).mcp.servers.mebular).toEqual({ type: 'remote', url });
    expect(JSON.parse(by('claude-code').snippet).mcpServers.mebular).toEqual({ type: 'http', url });
    expect(JSON.parse(by('claude-desktop').snippet).mcpServers.mebular).toEqual({ type: 'http', url });
    expect(JSON.parse(by('cursor').snippet).mcpServers.mebular).toEqual({ url });
    expect(by('hermes').snippet).toContain(`url: ${url}`);
    expect(by('dsh').snippet).toContain('transport: streamable-http');
    expect(by('openchamber').mcpUrl).toBe(url);
    // 同机前提如实注记（跨机指引）
    expect(by('generic').risks.join(' ')).toMatch(/跨机|同机/);
  });

  it('b) 写入路径产出 HTTP 条目；旧 stdio 形态被诚实标为「需重接」（不冒充已接入）', async () => {
    const url = 'http://127.0.0.1:7331/mcp';
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ theme: 'dark' }, null, 2));
    const res = await connectClient('opencode', opts({ mcpUrl: url }));
    expect(res.ok).toBe(true);
    const written = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(written.mcp.servers.mebular).toEqual({ type: 'remote', url });
    expect(written.theme).toBe('dark');
    // 幂等（同端点重复接入）
    const again = await connectClient('opencode', opts({ mcpUrl: url }));
    expect(again.changed).toBe(false);

    // 旧 stdio 形态：守护运行中会被拒 → 标「已写入·需升级」（stale，一等态；UI 提示升级为直连）
    await writeFile(cfg, JSON.stringify({ mcp: { servers: { mebular: { type: 'local', command: ['mebular', 'mcp'] } } } }, null, 2));
    const st = assistantState(descriptorFor('opencode', opts()), opts({ mcpUrl: url }));
    expect(st.state).toBe('stale');
    expect(st.stateLabel).toMatch(/需升级/);
    expect(st.landing.staleStdio).toBe(true);
  });

  it('增补#3 a) remote 形态 → present/connected（语义判据，不靠逐字节等价）', async () => {
    const url = 'http://127.0.0.1:7331/mcp';
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ theme: 'dark', mcp: { servers: { mebular: { type: 'remote', url } } } }, null, 2));
    const st = assistantState(descriptorFor('opencode', opts()), opts({ mcpUrl: url }));
    expect(st.landing.present).toBe(true);
    expect(st.state).toBe('connected');
    // 即使没给 mcpUrl（不知守护端点），remote 形态也算已接入
    const st2 = assistantState(descriptorFor('opencode', opts()), opts());
    expect(st2.landing.present).toBe(true);
    expect(st2.state).toBe('connected');
  });

  it('增补#3 b) stdio 形态 → stale（标注字段 + 中文态词）', async () => {
    const url = 'http://127.0.0.1:7331/mcp';
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcp: { servers: { mebular: { type: 'local', command: ['mebular', 'mcp'] } } } }, null, 2));
    const st = assistantState(descriptorFor('opencode', opts()), opts({ mcpUrl: url }));
    expect(st.state).toBe('stale');
    expect(st.stateLabel).toMatch(/需升级/);
    expect(st.landing.staleStdio).toBe(true);
    expect(st.landing.present).toBe(false);
  });

  it('增补#3 c) 「接入」把 stdio 升级为 remote（changed:true + 落盘）', async () => {
    const url = 'http://127.0.0.1:7331/mcp';
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcp: { servers: { mebular: { type: 'local', command: ['mebular', 'mcp'] } } } }, null, 2));
    const res = await connectClient('opencode', opts({ mcpUrl: url }));
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true); // 不是幂等跳过，而是**升级**
    const written = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(written.mcp.servers.mebular).toEqual({ type: 'remote', url });
    // 再接入 → 幂等
    const again = await connectClient('opencode', opts({ mcpUrl: url }));
    expect(again.changed).toBe(false);
  });

  it('增补#3 c2) 守护端口漂移（条目 url 与当前端点不符）→ stale → 升级', async () => {
    const cfg = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcp: { servers: { mebular: { type: 'remote', url: 'http://127.0.0.1:9000/mcp' } } } }, null, 2));
    const url = 'http://127.0.0.1:7331/mcp';
    const st = assistantState(descriptorFor('opencode', opts()), opts({ mcpUrl: url }));
    expect(st.state).toBe('stale'); // 端口漂移 → 需升级（而不是谎报已接入）
    const res = await connectClient('opencode', opts({ mcpUrl: url }));
    expect(res.changed).toBe(true);
    expect(JSON.parse(await readFile(cfg, 'utf-8')).mcp.servers.mebular.url).toBe(url);
  });

  it('增补#3 b2) hermes YAML：块有 url → present；只有 command → stale', async () => {
    const cfg = join(userHome, '.hermes', 'config.yaml');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, 'mcp_servers:\n  mebular:\n    url: http://127.0.0.1:7331/mcp\n    enabled: true\n');
    const st = assistantState(descriptorFor('hermes', opts()), opts());
    expect(st.state).toBe('connected');
    await writeFile(cfg, 'mcp_servers:\n  mebular:\n    command: mebular\n    args:\n      - mcp\n    enabled: true\n');
    const st2 = assistantState(descriptorFor('hermes', opts()), opts({ mcpUrl: 'http://127.0.0.1:7331/mcp' }));
    expect(st2.state).toBe('stale');
    expect(st2.landing.staleStdio).toBe(true);
  });

  it('增补#3 b3) dsh：streamable-http → present；stdio → stale', async () => {
    const cfg = join(userHome, '.dsh', 'cordis.yml');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, "plugins:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: mebular\n      transport: streamable-http\n      url: http://127.0.0.1:7331/mcp\n");
    const st = assistantState(descriptorFor('dsh', opts()), opts());
    expect(st.state).toBe('connected');
    await writeFile(cfg, "plugins:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: mebular\n      transport: stdio\n      command: mebular\n      args: ['mcp']\n");
    const st2 = assistantState(descriptorFor('dsh', opts()), opts());
    expect(st2.state).toBe('stale');
  });

  it('d) print-config 输出与注册表条目一致（单一真源）', () => {
    const bin = join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs');
    const url = 'http://127.0.0.1:7331/mcp';
    const cases = [
      ['opencode', 'opencode-json', {}],
      ['claude', 'json-mcpServers', { httpShape: 'claude-http' }],
      ['cursor', 'json-mcpServers', {}],
      ['dsh', 'dsh', {}],
      ['generic', 'generic-snippet', {}],
    ];
    for (const [client, format, extra] of cases) {
      const out = execFileSync(process.execPath, [bin, 'print-config', '--client', client, '--url', url], { encoding: 'utf-8' }).trim();
      expect(out).toBe(snippetFor(format, { url, ...extra }));
    }
    // 无 --url：回落 stdio，且提示守护运行时应指向 HTTP
    const noUrl = execFileSync(process.execPath, [bin, 'print-config', '--client', 'opencode'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    expect(noUrl).toBe(snippetFor('opencode-json'));
  });
});
