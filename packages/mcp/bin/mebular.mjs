#!/usr/bin/env node
// mebular CLI（@mebular/mcp）
//
// G6.2：mcp（stdio）；G6.3：serve（Streamable HTTP + 鉴权 + 单实例）、token。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const command = argv[0];

function parseFlags(list) {
  const flags = {};
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

function homeDir() {
  return process.env.MEBULAR_HOME ?? join(process.cwd(), '.mebular');
}
function tokensPath(flagValue) {
  return flagValue ?? process.env.MEBULAR_TOKENS_FILE ?? join(homeDir(), 'auth', 'tokens.json');
}
function clientsPath(flagValue) {
  return flagValue ?? process.env.MEBULAR_OAUTH_CLIENTS_FILE ?? join(homeDir(), 'auth', 'clients.json');
}
function consentPath(flagValue) {
  return flagValue ?? process.env.MEBULAR_OAUTH_CONSENT_FILE ?? join(homeDir(), 'auth', 'consent.json');
}

function parseScopes(value, fallback = 'memory.read') {
  return String(value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

async function readJsonFile(file, shape) {
  if (!existsSync(file)) return shape;
  try {
    const data = JSON.parse(await readFile(file, 'utf-8'));
    return data;
  } catch (error) {
    console.error(`✗ JSON 文件损坏：${file}（${error.message}）`);
    process.exit(2);
  }
}

async function runTokenClient(sub, flags) {
  const file = clientsPath(typeof flags['clients-file'] === 'string' ? flags['clients-file'] : undefined);
  const data = await readJsonFile(file, { clients: [] });
  if (!Array.isArray(data.clients)) data.clients = [];

  if (sub === 'add') {
    const redirect = flags.redirect;
    if (typeof redirect !== 'string' || redirect.length === 0) {
      console.error('用法：mebular token client add --redirect <uri> [--scope memory.read,memory.write]');
      process.exit(2);
    }
    const record = { clientId: randomUUID(), redirectUris: [redirect], allowedScopes: parseScopes(flags.scope), createdAt: new Date().toISOString() };
    data.clients.push(record);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
    await chmod(file, 0o600);
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  if (sub === 'list') {
    console.log(JSON.stringify(data.clients, null, 2));
    return;
  }
  if (sub === 'remove') {
    const before = data.clients.length;
    data.clients = data.clients.filter((c) => c.clientId !== flags.id);
    if (data.clients.length === before) {
      console.error(`✗ 未找到 client：${flags.id}`);
      process.exit(2);
    }
    await writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`已移除 client ${flags.id}`);
    return;
  }
  console.error('用法：mebular token client <add|list|remove> [--redirect uri] [--scope a,b] [--id x]');
  process.exit(2);
}

async function runTokenConsent(flags) {
  const ttl = flags.ttl !== undefined ? Number(flags.ttl) : 300;
  const scopes = parseScopes(flags.scope);
  const file = consentPath(typeof flags['consent-file'] === 'string' ? flags['consent-file'] : undefined);
  const data = await readJsonFile(file, { codes: [] });
  const now = Date.now();
  const codes = (Array.isArray(data.codes) ? data.codes : []).filter((c) => c.exp > now && !c.usedAt);
  const code = `meb_consent_${randomUUID().replace(/-/g, '')}`;
  codes.push({ code, scopes, createdAt: new Date(now).toISOString(), exp: now + ttl * 1000 });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ codes }, null, 2), 'utf-8');
  await chmod(file, 0o600);
  console.log(JSON.stringify({ code, scopes, expiresAt: new Date(now + ttl * 1000).toISOString(), consentFile: file }, null, 2));
  console.error('（将同意码提交到 /authorize 表示授权；一次性、短时有效）');
}

async function runToken(action, flags, subArg) {
  if (action === 'consent') {
    await runTokenConsent(flags);
    return;
  }
  if (action === 'client') {
    await runTokenClient(subArg, flags);
    return;
  }
  const path = tokensPath(typeof flags['tokens-file'] === 'string' ? flags['tokens-file'] : undefined);
  let data = { tokens: [] };
  if (existsSync(path)) {
    try {
      data = JSON.parse(await readFile(path, 'utf-8'));
      if (!Array.isArray(data.tokens)) data = { tokens: [] };
    } catch (error) {
      console.error(`✗ tokens 文件损坏：${path}（${error.message}）`);
      process.exit(2);
    }
  }
  const { createHash } = await import('node:crypto');
  if (action === 'grant') {
    const scope = String(flags.scope ?? 'memory.read').split(',').map((s) => s.trim()).filter(Boolean);
    const token = `meb_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const id = randomUUID();
    data.tokens.push({ id, sha256: createHash('sha256').update(token).digest('hex'), scope, label: flags.label ?? undefined, createdAt: new Date().toISOString(), revoked: false });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
    await chmod(path, 0o600);
    console.log(JSON.stringify({ id, token, scope, tokensFile: path }, null, 2));
    console.log('（token 仅显示一次，请立即保存）');
    return;
  }
  if (action === 'list') {
    console.log(JSON.stringify(data.tokens.map(({ id, scope, label, createdAt, revoked }) => ({ id, scope, label, createdAt, revoked })), null, 2));
    return;
  }
  if (action === 'revoke') {
    const id = flags.id;
    const record = data.tokens.find((t) => t.id === id);
    if (!record) {
      console.error(`✗ 未找到 token：${id}`);
      process.exit(2);
    }
    record.revoked = true;
    await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`已吊销 token ${id}`);
    return;
  }
  console.error('用法：mebular token <grant|list|revoke> [--scope a,b] [--id x] [--tokens-file path]');
  process.exit(2);
}

async function runKeygen(flags) {
  const { IdentityManager } = await import('@mebular/core');
  const out = typeof flags.out === 'string' ? flags.out : join(homeDir(), 'user-master-key.json');
  const master = await new IdentityManager().generateUserMasterKey();
  const record = {
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(record, null, 2), 'utf-8');
  await chmod(out, 0o600);
  console.log(JSON.stringify({ keyFile: out, publicKey: record.publicKey }, null, 2));
  console.error('（主私钥是信任根，请妥善保管；权限 0600）');
}

async function runInit(flags) {
  const home = homeDir();
  const configFile = join(home, 'config.json');
  const keyFile = join(home, 'user-master-key.json');
  await mkdir(home, { recursive: true });

  if (!existsSync(keyFile)) await runKeygen({ out: keyFile });

  if (existsSync(configFile)) {
    console.log(`配置已存在，未覆盖：${configFile}`);
  } else {
    const config = {
      storagePath: typeof flags['storage'] === 'string' ? flags['storage'] : join(home, 'store.jsonl'),
      storageAdapter: 'json',
      deviceId: typeof flags['device-id'] === 'string' ? flags['device-id'] : `device-${process.env.HOSTNAME ?? 'local'}`,
      encryption: { level: 'none', keyFile },
      network: { enabled: false, libp2p: { listen: [], relayServers: [], relayUnlimited: false } },
      // 常驻入口默认实时（写入即推 + 周期 anti-entropy）；可显式关闭
      sync: { autoSync: true, pushOnWrite: true, antiEntropy: { enabled: true } },
      semantic: { enabled: false, minScore: 0.2 },
      mcp: { http: { host: '127.0.0.1', port: 7331, auth: 'none', tls: false, tokensFile: join(home, 'auth', 'tokens.json') } },
    };
    await writeFile(configFile, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`已写入配置：${configFile}`);
  }
  console.log(
    [
      '',
      '下一步：',
      '  node packages/mcp/bin/mebular.mjs mcp      # stdio 接入（各 MCP client）',
      '  node packages/mcp/bin/mebular.mjs serve    # Streamable HTTP',
      '  node packages/mcp/bin/mebular.mjs status   # 查看状态',
      '  node packages/skill/scripts/install.mjs    # 安装行为层 Skill',
    ].join('\n'),
  );
}

function runPrintConfig(flags) {
  const client = typeof flags.client === 'string' ? flags.client : 'generic';
  const url = typeof flags.url === 'string' ? flags.url : null;
  const local = { command: 'mebular', args: ['mcp'] };

  const snippets = {
    opencode: JSON.stringify(
      { $schema: 'https://opencode.ai/config.json', mcp: { mebular: url ? { type: 'remote', url } : { type: 'local', command: ['mebular', 'mcp'] } } },
      null,
      2,
    ),
    claude: JSON.stringify({ mcpServers: { mebular: url ? { url } : local } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { mebular: url ? { url } : local } }, null, 2),
    generic: JSON.stringify({ mcpServers: { mebular: url ? { url } : local } }, null, 2),
    dsh: url
      ? `plugins:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: mebular\n      transport: streamable-http\n      url: ${url}`
      : "plugins:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: mebular\n      transport: stdio\n      command: mebular\n      args: ['mcp']",
  };
  const output = snippets[client];
  if (!output) {
    console.error(`未知 client：${client}（opencode/claude/cursor/dsh/generic）`);
    process.exit(2);
  }
  console.log(output);
}

async function runConsole(flags) {
  const { homeDir: home, loadConfigFile } = await import('../src/config.mjs');
  const dir = home();
  const config = await loadConfigFile(dir).catch(() => ({}));
  const httpCfg = config.mcp?.http ?? {};
  const host = typeof flags.host === 'string' ? flags.host : httpCfg.host ?? '127.0.0.1';
  const port = flags.port !== undefined ? Number(flags.port) : httpCfg.port ?? 7331;
  // F-C1：scheme 以**生效真值**为准——与 server.mjs 同一定义：证书齐备即实际启用 TLS；
  // tls=true 是「必须启用」开关，缺证书时 serve 启动即失败（此处同步明确警告）。
  const consoleKey = flags['tls-key'] ?? httpCfg.tlsKey;
  const consoleCert = flags['tls-cert'] ?? httpCfg.tlsCert;
  const tlsReady = Boolean(consoleKey && consoleCert);
  if (httpCfg.tls === true && !tlsReady) {
    console.error('⚠ mcp.http.tls=true 但缺少 tlsKey/tlsCert：serve 将启动失败（MCP_INSECURE_CONFIG）；请补证书或关闭 tls');
  }
  const scheme = tlsReady ? 'https' : 'http';
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const consoleUrl = `${scheme}://${target}:${port}/console`;
  const probe = `${scheme}://${target}:${port}/healthz`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(probe, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      console.log(`Mebular 控制台：${consoleUrl}`);
      if (httpCfg.auth && httpCfg.auth !== 'none') {
        console.error(`（serve 鉴权为 ${httpCfg.auth}：页面写操作需要 memory.admin scope）`);
      }
      return;
    }
    console.error(`✗ serve 已响应但 /healthz 非 200：${res.status}`);
  } catch (error) {
    const reason = error?.name === 'AbortError' ? '探测超时' : error?.message ?? error;
    console.error(`✗ 未检测到运行中的 serve（${probe}）：${reason}`);
  }
  console.error('');
  console.error('请先启动 serve，再打开控制台：');
  console.error(`  node packages/mcp/bin/mebular.mjs serve --host ${host} --port ${port}`);
  console.error(`  控制台 URL：${consoleUrl}`);
  process.exit(2);
}

/** C2：`doctor --net` —— 读地址簿/路径状态 + 轻量可达性探针，输出「下一步建议」。 */
async function runNetDoctor() {
  const { createMebular, loadConfigFile, endpointsPath, networkHints, relaySeeds } = await import('../src/config.mjs');
  const net = await import('node:net');
  const home = homeDir();
  const config = await loadConfigFile(home).catch(() => ({}));

  const probe = (host, port, timeoutMs = 1500) => new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok, error) => { socket.destroy(); resolve({ ok, error: error ?? null }); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (error) => done(false, error.code ?? error.message));
  });
  const parseTcp = (multiaddr) => {
    const m = /\/(ip4|ip6|dns4|dns6|dns)\/([^/]+)\/tcp\/(\d+)/.exec(String(multiaddr));
    return m ? { host: m[2], port: Number(m[3]) } : null;
  };

  const peersFile = endpointsPath(home);
  const hints = networkHints(config);
  const seeds = relaySeeds(config);

  // 地址簿（离线读；不存在 = 合法）
  let book = null;
  let bookError = null;
  try {
    const { FileEndpointStore, EndpointBook } = await import('@mebular/core');
    const store = new FileEndpointStore(peersFile);
    book = new EndpointBook({ store });
    await book.load();
  } catch (error) {
    bookError = error.message;
  }

  // 进程内路径状态（需网络启用；失败不阻断诊断）
  let runtime = { enabled: false, listen: [], paths: [], nodeError: null };
  try {
    const { app } = await createMebular();
    try {
      const node = app.node;
      runtime.enabled = Boolean(node?.isRunning());
      runtime.listen = node?.getLocalMultiaddrs?.() ?? [];
      const bookRef = app.endpointBook;
      runtime.paths = bookRef ? bookRef.keys().map((key) => ({ key, path: bookRef.getPath(key) })) : [];
    } finally {
      await app.shutdown().catch(() => undefined);
    }
  } catch (error) {
    runtime.nodeError = error.message;
  }

  // C3：LAN 自动发现状态（发现层是否启用/在跑、LAN 候选、忽略的陌生设备）
  let lan = null;
  try {
    const { app } = await createMebular();
    try {
      lan = app.node?.getLanStatus?.() ?? null;
    } finally {
      await app.shutdown().catch(() => undefined);
    }
  } catch (error) {
    lan = { error: error.message };
  }

  // C5：地址自动广播状态（档位/已发布/已采用/忽略原因）
  let netStatus = null;
  try {
    const { app } = await createMebular();
    try {
      netStatus = app.getNetEndpointsStatus?.() ?? null;
    } finally {
      await app.shutdown().catch(() => undefined);
    }
  } catch (error) {
    netStatus = { error: error.message };
  }

  // C4：NAT 穿透状态（AutoNAT/DCUtR + 直连升级计数）
  let natStatus = null;
  try {
    const { app } = await createMebular();
    try {
      natStatus = app.getNatStatus?.() ?? null;
    } finally {
      await app.shutdown().catch(() => undefined);
    }
  } catch (error) {
    natStatus = { error: error.message };
  }

  // C6：内建 relay 角色（本机当不当桥、原因、白名单客户端数）
  let relay = null;
  try {
    const { app } = await createMebular();
    try {
      relay = app.node?.getRelayStatus?.() ?? null;
    } finally {
      await app.shutdown().catch(() => undefined);
    }
  } catch (error) {
    relay = { error: error.message };
  }

  // relay seeds 探针（TCP 可达性）
  const seedProbes = [];
  for (const seed of seeds) {
    const target = parseTcp(seed);
    if (!target) { seedProbes.push({ seed, reachable: null, error: '非 TCP multiaddr（跳过）' }); continue; }
    const result = await probe(target.host, target.port);
    seedProbes.push({ seed, reachable: result.ok, error: result.error });
  }

  const next = [];
  if (!runtime.enabled) next.push('network.enabled=false：先开启 P2P（可达设备会自动成为桥；无需手工起 relay）');
  if (runtime.listen.length === 0 && runtime.enabled) next.push('本机暂无监听地址：检查 network.libp2p.listen / 防火墙 / relay 预约');
  const totalHints = Object.values(hints).reduce((sum, list) => sum + list.length, 0);
  if (totalHints === 0) next.push('无配对 hints：用 `fleet invite`/控制台邀请，让新设备拿到可达地址（token.endpoints）');
  const failedSeeds = seedProbes.filter((p) => p.reachable === false);
  if (failedSeeds.length > 0) next.push(`relay seed 不可达（${failedSeeds.map((p) => p.seed).join(', ')}）：确认 relay 进程在跑、端口放行`);
  if (natStatus && natStatus.loadError) next.push(`NAT 打洞不可用（${natStatus.loadError}）：安装可选依赖 @libp2p/autonat @libp2p/dcutr 可启用（缺包不影响其他连接方式）`);
  if (natStatus && natStatus.dcutrEnabled && (natStatus.directUpgrades ?? 0) === 0 && (natStatus.relayConnections ?? 0) > 0) next.push('有 relay 连接但尚未观察到直连升级：对端/本机可能都是对称 NAT（打洞失败属预期，保留 relay）');
  if (netStatus && !netStatus.enabled) next.push('地址自动广播未开启（opt-in）：把 `__net__` 加入 sync.namespaces 或配置 network.broadcast:{mode:"full"} 即可让可达设备互相广播地址');
  if (netStatus && netStatus.enabled && netStatus.published === 0) next.push('已开启地址广播但尚未发布：启动/可达性变化后会自动发布（首次可能因地址未变而跳过）');
  if (netStatus && Object.values(netStatus.ignored ?? {}).reduce((a, b) => a + b, 0) > 0) next.push(`有被忽略的广播记录（${Object.entries(netStatus.ignored).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ')}）：过期/吊销/伪装 subject 属预期忽略`);
  if (relay && relay.mode === 'auto' && !relay.serving) next.push(`本机不当桥（${relay.reason}）：如需当桥，确保有公网监听地址或已被外部直连（network.relayService=on 可强制）`);
  if (relay && relay.serving && relay.allowedClients === 0) next.push('本机在当桥但白名单为空：先配对（地址簿 paired）后才会放行中转预约');
  if (lan && lan.enabled && !lan.running) next.push(`LAN 发现未运行${lan.lastError ? `（${lan.lastError}）` : ''}：检查 bonjour 依赖或 network.lan.enabled`);
  if (lan && lan.ignoredUnknown > 0) next.push(`发现了 ${lan.ignoredUnknown} 个未配对设备（已忽略、未拨号）：如确需连通，先用邀请令牌配对（写入地址簿）或加入 sync.peerWhitelist`);
  if (lan && lan.lanCandidates === 0 && lan.running) next.push('LAN 发现已启用但暂无 LAN 候选：确认同网段、mDNS 未被防火墙拦截（跨网段请用 relay seeds）');
  const disconnected = runtime.paths.filter((p) => !p.path);
  if (disconnected.length > 0) next.push(`有候选但未连上的对端 ${disconnected.length} 个：看 lastError，必要时把 relay 加入 network.relaySeeds`);

  console.log(JSON.stringify({
    ok: true,
    kind: 'net-doctor',
    home,
    peersFile,
    book: book
      ? {
          loaded: true,
          peers: book.keys().map((key) => ({ key, candidates: book.list(key).map((c) => ({ address: c.address, kind: c.kind, source: c.source, lastError: c.lastError ?? null })) })),
        }
      : { loaded: false, error: bookError },
    configHints: hints,
    lan,
    net: netStatus,
    nat: natStatus,
    relay,
    relaySeeds: seedProbes,
    runtime,
    next,
  }, null, 2));
}

async function runStatus() {
  const { createMebular } = await import('../src/config.mjs');
  const { MemoryService } = await import('@mebular/core');
  const { app, home, storagePath, deviceId, identityMode, config } = await createMebular();
  try {
    const status = await new MemoryService(app).status();
    // store 锁持有者（单写者证据）
    let storeLock = null;
    const lockPath = join(home, 'lock');
    if (existsSync(lockPath)) {
      try {
        storeLock = JSON.parse(await readFile(lockPath, 'utf-8'));
      } catch {
        storeLock = { path: lockPath, corrupt: true };
      }
    }
    const nodes = await app.graph.listNodes({});
    const namespaces = [...new Set(nodes.map((n) => n.namespace ?? 'default'))].sort();
    console.log(JSON.stringify({
      ...status,
      home,
      storagePath,
      deviceId,
      identityMode,
      network: { enabled: config.network?.enabled ?? false, listen: config.network?.libp2p?.listen ?? [] },
      storeLock,
      namespaces,
      joinService: config.joinService ?? null,
    }, null, 2));
  } finally {
    await app.shutdown().catch(() => undefined);
  }
}


/** 由 flags 组装工具入参（`--input` JSON 优先，其余 flag 直填并做整数还原）。 */
function buildToolInput(flags) {
  if (typeof flags.input === 'string') {
    const parsed = JSON.parse(flags.input);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('--input 必须是 JSON 对象');
    return parsed;
  }
  const reserved = new Set(['home', 'token', 'config', 'storage', 'device-id', 'device-name', 'input']);
  const out = {};
  for (const [k, v] of Object.entries(flags)) {
    if (reserved.has(k)) continue;
    out[k] = typeof v === 'string' && /^-?[0-9]+$/.test(v) ? Number(v) : v;
  }
  return out;
}

/**
 * W3 表面一致性：`mebular memory_*` 与 MCP **同工具名、同 handler**。
 * **单写者**：守护持锁时作为本机 MCP 客户端走 `/mcp`+bearer；未持锁（dev）允许直连。
 */
async function runMemoryTool(name, flags) {
  const { toolByName } = await import('../src/tools.mjs');
  const spec = toolByName(name);
  if (!spec) {
    console.error(`未知命令：${name}`);
    process.exit(2);
  }
  const args = buildToolInput(flags);
  const home = homeDir();
  const lockPath = join(home, 'lock');
  let result;
  if (existsSync(lockPath)) {
    const { loadConfigFile } = await import('../src/config.mjs');
    const { callToolViaHttp } = await import('../src/client.mjs');
    const fileConfig = await loadConfigFile(home).catch(() => ({}));
    const httpConf = fileConfig.mcp?.http ?? {};
    const host = httpConf.host ?? '127.0.0.1';
    const port = httpConf.port ?? 7331;
    const token = typeof flags.token === 'string' ? flags.token : process.env.MEBULAR_TOKEN;
    if ((httpConf.auth ?? 'none') !== 'none' && !token) {
      console.error('守护持锁且启用鉴权：请提供 --token 或 MEBULAR_TOKEN（`mebular token grant`）');
      process.exit(2);
    }
    const mcpResult = await callToolViaHttp({ endpoint: `http://${host}:${port}`, token, name, args });
    if (mcpResult?.isError) {
      console.error(JSON.stringify(mcpResult.structuredContent ?? mcpResult));
      process.exit(1);
    }
    result = mcpResult?.structuredContent;
  } else {
    const { createMebular } = await import('../src/config.mjs');
    const { MemoryService } = await import('@mebular/core');
    const { app } = await createMebular();
    try {
      const specResult = await spec.handler(new MemoryService(app), args);
      if (specResult.isError) {
        console.error(specResult.content[0]?.text ?? '工具失败');
        process.exit(1);
      }
      result = specResult.structuredContent;
    } finally {
      await app.shutdown().catch(() => undefined);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const flags = parseFlags(argv.slice(1));
  switch (command) {
    case 'mcp': {
      const { startStdioServer } = await import('../src/server.mjs');
      await startStdioServer();
      return;
    }
    case 'serve': {
      const { startServeServer } = await import('../src/server.mjs');
      const { loadConfigFile } = await import('../src/config.mjs');
      const home = homeDir();
      const fileConfig = await loadConfigFile(home).catch(() => ({}));
      const httpConf = fileConfig.mcp?.http ?? {};
      // D4：常驻进程写 service.heartbeat（role=mebular-serve），供 `service status`/doctor 判定。
      try {
        const { startHeartbeat, resolveBuildSha } = await import('@mebular/service');
        startHeartbeat(homeDir(), { role: 'mebular-serve', sha: resolveBuildSha() });
      } catch {
        // service 包缺失不应阻止 serve。
      }
      try {
        const result = await startServeServer({
          host: typeof flags.host === 'string' ? flags.host : httpConf.host,
          port: flags.port !== undefined ? Number(flags.port) : httpConf.port,
          auth: typeof flags.auth === 'string' ? flags.auth : httpConf.auth,
          tlsKey: typeof flags['tls-key'] === 'string' ? flags['tls-key'] : undefined,
          tlsCert: typeof flags['tls-cert'] === 'string' ? flags['tls-cert'] : undefined,
          tokensFile: typeof flags['tokens-file'] === 'string' ? flags['tokens-file'] : httpConf.tokensFile,
        });
        if (result.provision) {
          console.log(`PROVISION_READY ${JSON.stringify({ host: result.host, port: result.port, home: homeDir() })}`);
          console.log('引导态：家目录为空。请在浏览器打开控制台完成「建新 Mebular / 加入已有 Mebular」。');
        } else {
          console.log(`SERVE_READY ${JSON.stringify({ host: result.host, port: result.port, auth: result.auth, issuer: result.issuer })}`);
        }
      } catch (error) {
        console.error(`✗ serve 启动失败（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
        process.exit(2);
      }
      return;
    }
    case 'service': {
      const { runServiceCli } = await import('@mebular/service');
      const home = homeDir();
      const bin = process.argv[1];
      const descriptor = {
        kind: 'mebular-serve',
        args: [bin, 'serve'],
        heartbeatDir: home,
        workingDir: home,
        env: { MEBULAR_HOME: home },
      };
      process.exit(runServiceCli({ descriptors: [descriptor], argv: argv.slice(1) }));
      return;
    }
    case 'console': {
      await runConsole(flags);
      return;
    }
    case 'token': {
      await runToken(argv[1], flags, argv[2]);
      return;
    }
    case '--help':
    case '-h':
    case undefined:
      console.log(
        [
          '用法：mebular <command>',
          '',
          '命令：',
          '  mcp                          启动 stdio MCP server',
          '  serve [--host --port --auth --tls-key --tls-cert --tokens-file]   Streamable HTTP server',
          '  service install|uninstall|restart|status|logs [--no-autostart --label L]  常驻服务管理（mebular-serve）',
          '  console [--host --port]      打印控制台 URL（需 serve 正在运行）',
          '  token grant|list|revoke [--scope a,b] [--id x] [--tokens-file p]   bearer 令牌管理',
          '  token client add|list|remove [--redirect uri] [--scope a,b] [--id x]   OAuth 客户端预注册',
          '  token consent [--scope a,b] [--ttl sec]   生成一次性本地同意码（/authorize 用）',
          '  init / keygen / print-config / status|doctor   初始化、状态与自检（身份模式/网络/锁/域/join）',
          '  doctor --net                 网络排障：地址簿/路径状态 + relay 可达性 + 下一步建议',
          '  tools                        打印 MCP 工具 ↔ CLI 对照表',
          '  memory_write|memory_write_batch|memory_query|memory_search|memory_profile|memory_skills|',
          '  memory_history|memory_graph|memory_import|memory_status|memory_sync   与 MCP 同名同 handler',
        ].join('\n'),
      );
      process.exit(0);
      return;
    case 'init':
      await runInit(flags);
      return;
    case 'keygen':
      await runKeygen(flags);
      return;
    case 'print-config':
      runPrintConfig(flags);
      return;
    case 'tools': {
      const { ALL_TOOL_SPECS } = await import('../src/tools.mjs');
      console.log(JSON.stringify({ ok: true, tools: ALL_TOOL_SPECS.map((t) => ({ tool: t.name, cli: t.name })) }, null, 2));
      return;
    }
    case 'status':
      await runStatus();
      return;
    case 'doctor':
      if (flags.net === true || flags.net === 'true') {
        await runNetDoctor();
        return;
      }
      await runStatus();
      return;
    default: {
      const { toolByName } = await import('../src/tools.mjs');
      if (typeof command === 'string' && toolByName(command)) {
        await runMemoryTool(command, flags);
        return;
      }
      console.error(`未知命令：${command ?? '(空)'}`);
      process.exit(2);
    }
  }
}

await main();
