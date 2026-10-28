#!/usr/bin/env node
// mebular CLI（@mebular/mcp）
//
// G6.2：mcp（stdio）；G6.3：serve（Streamable HTTP + 鉴权 + 单实例）、token。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from '../src/home.mjs';
import { serviceBuildSha } from '../src/build-sha.mjs';

const argv = process.argv.slice(2);
const command = argv[0];

function parseFlags(list) {
  const flags = {};
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const key = body;
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

// F-INST-1：home 默认与 config.mjs 共用同一真源（~/.mebular，MEBULAR_HOME 覆盖）。
// 历史分裂（bin 用 <cwd>/.mebular）会导致 store lock 与 service.heartbeat 各写一边。
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
  console.error('（将同意码提交到 /authorize 表示同意；一次性、短时有效）');
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

function initError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readInitJson(file, { label, code }) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是对象');
    }
    return parsed;
  } catch (error) {
    throw initError(`${label}损坏：${file}（${error?.message ?? error}）`, code);
  }
}

async function runInit(flags) {
  const home = homeDir();
  const configFile = join(home, 'config.json');
  const keyFile = join(home, 'user-master-key.json');
  await mkdir(home, { recursive: true });

  const config = existsSync(configFile)
    ? await readInitJson(configFile, { label: 'config.json', code: 'CONFIG_INVALID' })
    : null;
  const storagePath = typeof config?.storagePath === 'string'
    ? config.storagePath
    : (typeof flags['storage'] === 'string' ? flags['storage'] : join(home, 'store.jsonl'));
  const explicit = {
    ...(typeof flags['device-id'] === 'string' && flags['device-id'].trim().length > 0
      ? { deviceId: flags['device-id'].trim() }
      : {}),
    ...(typeof flags['device-name'] === 'string' && flags['device-name'].trim().length > 0
      ? { deviceName: flags['device-name'].trim() }
      : {}),
  };

  const {
    assertFreshStore,
    cleanLegacyConfig,
    createIdentity,
    prepareIdentity,
  } = await import('../src/home-identity.mjs');
  const prepared = prepareIdentity({ config: config ?? {}, storagePath, explicit });
  if (!prepared.ok) throw initError(prepared.message, prepared.code);
  for (const warning of prepared.warnings) console.error(`warning: ${warning}`);

  let identity = prepared.identity;
  if (prepared.status === 'missing') {
    // 缺身份但 store 已有数据 = 自动换钥风险：先拒绝，绝不写任何文件。
    assertFreshStore(storagePath);
    if (!existsSync(keyFile)) await runKeygen({ out: keyFile });
    const { readMasterKeyRecord } = await import('../src/config.mjs');
    let master;
    try {
      master = await readMasterKeyRecord(keyFile);
    } catch (error) {
      throw initError(`主密钥文件损坏：${keyFile}（${error?.message ?? error}）`, 'MASTER_KEY_INVALID');
    }
    if (!master.userMasterPrivateKey) {
      throw initError(`主密钥文件缺少私钥：${keyFile}`, 'MASTER_KEY_INVALID');
    }
    const created = await createIdentity({
      storagePath,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      userMasterPrivateKey: master.userMasterPrivateKey,
      userMasterPublicKey: master.userMasterKey,
    });
    identity = { deviceId: created.deviceId, deviceName: created.deviceName };
  }

  if (config !== null) {
    const migrated = await cleanLegacyConfig({ configPath: configFile, identity });
    console.log(`配置已存在，未覆盖：${configFile}`);
    if (migrated.migrated) {
      console.log(`已备份旧 config 身份字段：${migrated.backupPath}，并以身份 ${identity.deviceId} 为准`);
    }
  } else {
    // F-IDENT-1：新 config 不写 deviceId/deviceName；身份文件是唯一权威。
    const nextConfig = {
      storagePath,
      storageAdapter: 'json',
      encryption: { level: 'none', keyFile },
      network: { enabled: false, libp2p: { listen: [], relayServers: [], relayUnlimited: false } },
      // 常驻入口默认实时（写入即推 + 周期 anti-entropy）；可显式关闭
      sync: { autoSync: true, pushOnWrite: true, antiEntropy: { enabled: true } },
      semantic: { enabled: false, minScore: 0.2 },
      mcp: { http: { host: '127.0.0.1', port: 7331, auth: 'none', tls: false, tokensFile: join(home, 'auth', 'tokens.json') } },
    };
    await writeFile(configFile, JSON.stringify(nextConfig, null, 2), 'utf-8');
    console.log(`已写入配置：${configFile}（deviceId=${identity.deviceId}，由身份文件提供）`);
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

/**
 * F-FIX-B：`print-config` **委托注册表**（单一真源）——条目形态、键位、HTTP/stdio 选择都在
 * `src/clients.mjs`（`mebularEntry`/`snippetFor`）。有 `--url` 即产出指向守护 HTTP `/mcp` 的形态；
 * 无 `--url` 回落 stdio（并提示守护运行时应改指向 HTTP）。
 */
async function runPrintConfig(flags) {
  const client = typeof flags.client === 'string' ? flags.client : 'generic';
  const url = typeof flags.url === 'string' ? flags.url : null;
  const { snippetFor, descriptorFor } = await import('../src/clients.mjs');
  const ids = { opencode: 'opencode', claude: 'claude-code', cursor: 'cursor', dsh: 'dsh', generic: 'generic' };
  const id = ids[client];
  if (!id) {
    console.error(`未知 client：${client}（opencode/claude/cursor/dsh/generic）`);
    process.exit(2);
  }
  const assistant = descriptorFor(id);
  const options = {
    ...(url ? { url } : {}),
    ...(assistant?.landing?.httpShape ? { httpShape: assistant.landing.httpShape } : {}),
  };
  console.log(snippetFor(assistant.format, options));
  if (!url) {
    console.error('提示：守护运行中 stdio `mebular mcp` 会被拒（MCP_STORAGE_LOCKED）；请用 --url http://<host>:<port>/mcp');
  }
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

/** F-CLI-2：从**运行中的守护**读本机网络真状态（只读 admin API；不初始化自己的 P2P）。 */
async function readDaemonNetView(home, config) {
  const httpCfg = config?.mcp?.http ?? {};
  const host = httpCfg.host ?? '127.0.0.1';
  const port = httpCfg.port ?? 7331;
  const scheme = (httpCfg.tls === true || (httpCfg.tlsKey && httpCfg.tlsCert)) ? 'https' : 'http';
  const token = process.env.MEBULAR_TOKEN;
  try {
    const res = await fetch(`${scheme}://${host}:${port}/admin/api/net`, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return { error: `守护只读端点不可用（HTTP ${res.status}${res.status === 401 ? '：需 token（设置 MEBULAR_TOKEN）' : ''}）` };
    }
    return { view: await res.json() };
  } catch (error) {
    return { error: `无法连接守护（${error?.message ?? error}）` };
  }
}

/**
 * P3：从**运行中的守护**读收敛健康度（只读 admin API /admin/api/devices 的
 * convergence 字段；未启用/守护不可达 = error/空）。不初始化自己的网络。
 */
async function readDaemonConvergence(config) {
  const httpCfg = config?.mcp?.http ?? {};
  const host = httpCfg.host ?? '127.0.0.1';
  const port = httpCfg.port ?? 7331;
  const scheme = (httpCfg.tls === true || (httpCfg.tlsKey && httpCfg.tlsCert)) ? 'https' : 'http';
  const token = process.env.MEBULAR_TOKEN;
  try {
    const res = await fetch(`${scheme}://${host}:${port}/admin/api/devices`, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return { error: `守护只读端点不可用（HTTP ${res.status}${res.status === 401 ? '：需 token（设置 MEBULAR_TOKEN）' : ''}）` };
    }
    const devices = await res.json();
    const peers = (Array.isArray(devices) ? devices : [])
      .filter((d) => d && d.convergence)
      .map((d) => ({ peerDeviceId: d.deviceId, ...d.convergence }));
    return { peers };
  } catch (error) {
    return { error: `无法连接守护（${error?.message ?? error}）` };
  }
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

  // F-CLI-2：守护感知 —— 守护在运行时不初始化自己的 P2P（否则抢监听端口 → EADDRINUSE 污染全部段落）
  const lockPath = join(home, 'lock');
  let storeLock = null;
  if (existsSync(lockPath)) {
    try {
      storeLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    } catch {
      storeLock = { corrupt: true };
    }
  }
  const { pidAlive } = await import('../src/serve.mjs');
  const daemonLive = Boolean(storeLock?.pid) && pidAlive(storeLock.pid);
  let daemon = null;

  let runtime = { enabled: false, listen: [], paths: [], nodeError: null };
  let lan = null;
  let netStatus = null;
  let natStatus = null;
  let relay = null;

  if (daemonLive) {
    const { view, error } = await readDaemonNetView(home, config);
    if (view) {
      runtime = { enabled: Boolean(view.enabled), listen: view.listen ?? [], paths: view.paths ?? [], nodeError: null };
      lan = view.lan ?? null;
      netStatus = view.net ?? null;
      natStatus = view.nat ?? null;
      relay = view.relay ?? null;
      daemon = { reused: true, pid: storeLock.pid, source: 'admin-api' };
    } else {
      // 只读端点不可用（如需 token）：退回 config 判据，并明确标注不是本进程实测
      runtime = { enabled: config.network?.enabled === true, listen: [], paths: [], nodeError: error };
      daemon = { reused: true, pid: storeLock.pid, source: 'config-only', readError: error };
    }
  } else {
    // 本地诊断（无守护）：进程内状态（一次装配，多处取用；失败不阻断诊断）
    try {
      const { app } = await createMebular();
      try {
        const node = app.node;
        runtime.enabled = Boolean(node?.isRunning());
        runtime.listen = node?.getLocalMultiaddrs?.() ?? [];
        const bookRef = app.endpointBook;
        runtime.paths = bookRef ? bookRef.keys().map((key) => ({ key, path: bookRef.getPath(key) })) : [];
        lan = node?.getLanStatus?.() ?? null;
        netStatus = app.getNetEndpointsStatus?.() ?? null;
        natStatus = app.getNatStatus?.() ?? null;
        relay = node?.getRelayStatus?.() ?? null;
      } finally {
        await app.shutdown().catch(() => undefined);
      }
    } catch (error) {
      runtime.nodeError = error.message;
      lan = { error: error.message };
      netStatus = { error: error.message };
      natStatus = { error: error.message };
      relay = { error: error.message };
    }
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
  // F-CLI-2：守护在运行时 runtime 取自守护实测；仅**无守护**时才用「未开启 P2P」建议（避免误导）
  if (!runtime.enabled && !daemon) next.push('network.enabled=false：先开启 P2P（可达设备会自动成为桥；无需手工起 relay）');
  if (daemon?.readError) next.push(`守护在运行但只读端点不可用（${daemon.readError}）：可设置 MEBULAR_TOKEN 后重试，或直接看 \`mebular status\``);
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
    daemon,
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
  const { loadConfigFile, homeDir: resolveHome, identityMode: resolveIdentityMode } = await import('../src/config.mjs');
  const { readIdentityFile, storagePathForHome } = await import('../src/home-identity.mjs');
  const home = resolveHome();
  const configFile = await loadConfigFile(home).catch(() => ({}));
  const storagePath = storagePathForHome(home, configFile, process.env);
  // F-IDENT-1：status 的 deviceId 只认身份文件；env/config 仅旧布局兜底（且仅用于展示）。
  const identityRead = readIdentityFile(storagePath);
  const identityDeviceId = identityRead.status === 'valid' ? identityRead.deviceId : null;
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
  // F-NET-1（C）：守护在跑时**不初始化网络**（否则抢监听端口 → 裸 EADDRINUSE）。
  // status 走只读最小路径：返回 storeLock 等可观测项，SETUP §0.1 的判据（storeLock 非 null）成立。
  if (storeLock?.pid) {
    const { pidAlive } = await import('../src/serve.mjs');
    if (pidAlive(storeLock.pid)) {
      // P3：收敛健康度读运行中守护（只读 admin API；未启用/不可达 = null/error）
      const convergence = await readDaemonConvergence(configFile);
      console.log(JSON.stringify({
        ok: true,
        running: true,
        reused: true,
        deviceId: identityDeviceId,
        peerId: null,
        nodeCount: null,
        stateHash: null,
        home,
        storagePath,
        ...(identityDeviceId === null
          ? {
              identityError: identityRead.status === 'invalid'
                ? { status: 'invalid', code: 'IDENTITY_INVALID', problems: identityRead.problems ?? [] }
                : { status: identityRead.status, code: identityRead.status === 'missing' ? 'IDENTITY_MISSING' : null },
            }
          : {}),
        identityMode: resolveIdentityMode(home, configFile, storagePath),
        network: { enabled: configFile.network?.enabled ?? false, listen: configFile.network?.libp2p?.listen ?? [], reused: true },
        storeLock,
        namespaces: [],
        lan: null,
        joinService: configFile.joinService ?? null,
        convergence,
        note: `检测到守护进程（pid ${storeLock.pid}）正在运行：status 走只读最小路径（未初始化网络、未抢端口）。完整状态请走守护 API。`,
      }, null, 2));
      return;
    }
  }
  const { createMebular } = await import('../src/config.mjs');
  const { MemoryService } = await import('@mebular/core');
  const { app, storagePath: appStoragePath, deviceId, identityMode, config } = await createMebular();
  try {
    const status = await new MemoryService(app).status();
    const nodes = await app.graph.listNodes({});
    const namespaces = [...new Set(nodes.map((n) => n.namespace ?? 'default'))].sort();
    console.log(JSON.stringify({
      ...status,
      home,
      storagePath: appStoragePath,
      deviceId,
      identityMode,
      network: { enabled: config.network?.enabled ?? false, listen: config.network?.libp2p?.listen ?? [] },
      storeLock,
      namespaces,
      joinService: config.joinService ?? null,
      // P3：收敛健康度（本进程刚初始化；对端会话发生前通常为空汇总——持续观察请走守护）
      convergence: (() => {
        try {
          const conv = app.getConvergenceStatus?.();
          return conv ? { at: conv.at, summary: conv.summary, peers: conv.peers } : null;
        } catch {
          return null;
        }
      })(),
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

// ---------- 忆云（profile）CLI：list / use / rename ----------

async function readHomeConfig(home) {
  try {
    return JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function cloudHttpTarget(config) {
  const http = config?.mcp?.http ?? {};
  const rawHost = typeof http.host === 'string' && http.host.length > 0 ? http.host : '127.0.0.1';
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  const port = Number.isInteger(http.port) && http.port > 0 ? http.port : 7331;
  const tls = http.tls === true || Boolean(http.tlsKey && http.tlsCert);
  return { host, port, scheme: tls ? 'https' : 'http' };
}

async function probeCloudHealth(home) {
  const config = await readHomeConfig(home);
  const target = cloudHttpTarget(config);
  const url = `${target.scheme}://${target.host}:${target.port}/healthz`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, status: res.status, url };
    return { ok: true, body: await res.json(), url };
  } catch (error) {
    return { ok: false, url, error: error?.message ?? String(error) };
  }
}

async function consoleUrlForHome(home) {
  const target = cloudHttpTarget(await readHomeConfig(home));
  return `${target.scheme}://${target.host}:${target.port}/console`;
}

async function readHomeLock(home) {
  try {
    return JSON.parse(await readFile(join(home, 'lock'), 'utf-8'));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCloudStopped(home, { pid = null, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeCloudHealth(home);
    const lock = await readHomeLock(home);
    const lockAlive = (pid !== null && pidAliveSafe(pid))
      || (Boolean(lock?.pid) && pidAliveSafe(lock.pid));
    if (!health.ok && !lockAlive) return true;
    await sleep(200);
  }
  return false;
}

async function waitForCloudHealthy(home, { expectedInstance, cloudId = null, timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const health = await probeCloudHealth(home);
    last = health;
    if (health.ok) {
      const instance = health.body?.instance;
      if (typeof expectedInstance === 'string') {
        if (typeof instance !== 'string') {
          return { ok: false, reason: 'instance_missing', url: health.url };
        }
        if (instance !== expectedInstance) {
          return { ok: false, reason: 'instance_mismatch', instance, url: health.url };
        }
      }
      if (cloudId !== null && typeof health.body?.cloudId === 'string' && health.body.cloudId !== cloudId) {
        return { ok: false, reason: 'cloud_mismatch', cloudId: health.body.cloudId, url: health.url };
      }
      return { ok: true, body: health.body, url: health.url };
    }
    await sleep(250);
  }
  return { ok: false, reason: 'timeout', url: last?.url ?? null, error: last?.error ?? null };
}

function pidAliveSafe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeMebularServeAsync(pid) {
  if (process.platform === 'win32') return true;
  try {
    const { execFileSync } = await import('node:child_process');
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
    return command.length === 0 || /mebular|serve/i.test(command);
  } catch {
    return true; // ps 不可用/进程刚退出：由 --force 的显式语义兜底
  }
}

async function runCloudList() {
  const { displayPath, readRegistry, resolveCloudRoot } = await import('../src/profiles.mjs');
  const cloud = resolveCloudRoot({ home: homeDir(), env: process.env });
  if (!cloud.available) {
    console.error(`✗ 忆云档案功能不可用（${cloud.reason}）：当前为自定义 home / 受限 env`);
    process.exit(2);
  }
  const state = await readRegistry(cloud.root).catch((error) => {
    console.error(`✗ 忆云注册表不可读（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
    process.exit(2);
  });
  const current = state.registry.current;
  console.log(JSON.stringify({
    ok: true,
    root: displayPath(cloud.root),
    current,
    profiles: state.registry.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      home: profile.home,
      kind: profile.kind,
      createdAt: profile.createdAt ?? null,
      lastUsedAt: profile.lastUsedAt ?? null,
      masterFingerprint: profile.masterFingerprint ?? null,
      deviceId: profile.deviceId ?? null,
      current: profile.id === current,
    })),
    ...(state.warning ? { warning: state.warning } : {}),
  }, null, 2));
}

async function runCloudRename(id, name) {
  if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || name.length === 0) {
    console.error('用法：mebular cloud rename <id> <name>');
    process.exit(2);
  }
  const { renameProfile, resolveCloudRoot } = await import('../src/profiles.mjs');
  const cloud = resolveCloudRoot({ home: homeDir(), env: process.env });
  if (!cloud.available) {
    console.error(`✗ 忆云档案功能不可用（${cloud.reason}）`);
    process.exit(2);
  }
  try {
    const result = await renameProfile(cloud.root, id, name);
    const profile = result.value;
    console.log(JSON.stringify({
      ok: true,
      profile: { ...profile, current: profile.id === result.registry.current },
    }, null, 2));
  } catch (error) {
    console.error(`✗ 改名失败（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
    process.exit(2);
  }
}

async function runCloudUse(id, flags) {
  if (typeof id !== 'string' || id.length === 0) {
    console.error('用法：mebular cloud use <id> [--force]');
    process.exit(2);
  }
  const {
    homeKey,
    profileHomeForEntry,
    readRegistry,
    resolveCloudRoot,
  } = await import('../src/profiles.mjs');
  const {
    installProfileService,
    profileServiceDescriptor,
    profileServiceStatus,
    switchProfile,
    uninstallProfileService,
  } = await import('../src/cloud-switch.mjs');

  const cloud = resolveCloudRoot({ home: homeDir(), env: process.env });
  if (!cloud.available) {
    console.error(`✗ 忆云档案功能不可用（${cloud.reason}）：当前为自定义 home / 受限 env`);
    process.exit(2);
  }
  const state = await readRegistry(cloud.root).catch((error) => {
    console.error(`✗ 忆云注册表不可读（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
    process.exit(2);
  });
  const target = state.registry.profiles.find((profile) => profile.id === id);
  if (!target) {
    console.error(`✗ 未找到忆云：${id}`);
    process.exit(2);
  }
  if (state.registry.current === id) {
    console.log(JSON.stringify({
      ok: true,
      changed: false,
      current: id,
      profile: target,
      consoleUrl: await consoleUrlForHome(profileHomeForEntry(cloud.root, target)),
    }, null, 2));
    return;
  }

  const previous = state.registry.profiles.find((profile) => profile.id === state.registry.current) ?? null;
  const previousHome = previous ? profileHomeForEntry(cloud.root, previous) : null;
  const targetHome = profileHomeForEntry(cloud.root, target);
  if (!existsSync(targetHome)) {
    console.error(`✗ 忆云「${target.name}」的目录不存在（PROFILE_HOME_MISSING）：${targetHome}`);
    process.exit(2);
  }

  const cliBin = fileURLToPath(new URL('./mebular.mjs', import.meta.url));
  const serviceHome = (await import('node:os')).homedir();
  const descriptorFor = (home) => profileServiceDescriptor({ root: cloud.root, home, cliBin });

  const oldHealth = previousHome ? await probeCloudHealth(previousHome) : { ok: false };
  if (oldHealth.ok && typeof oldHealth.body?.instance === 'string'
    && previousHome && oldHealth.body.instance !== homeKey(previousHome)) {
    console.error('✗ 旧忆云端口上运行的是另一张忆云（CLOUD_INSTANCE_MISMATCH：/healthz instance 不匹配）：请先停止它');
    process.exit(2);
  }
  const oldLock = previousHome ? await readHomeLock(previousHome) : null;
  const oldPid = Number.isInteger(oldLock?.pid) && pidAliveSafe(oldLock.pid) ? oldLock.pid : null;
  const oldWasLive = Boolean(oldHealth.ok || oldPid);
  const force = flags.force === true;

  let statusNew = { registered: false, autostart: null };
  let statusLegacy = { registered: false, autostart: null };
  let statusTarget = { registered: false };
  try {
    if (previousHome) {
      statusNew = await profileServiceStatus({ descriptor: descriptorFor(previousHome), serviceHome });
      statusLegacy = await profileServiceStatus({ descriptor: descriptorFor(previousHome), serviceHome: previousHome });
    }
    // 目标档案可能残留旧服务单元（上次失败切换）：起新前一并卸掉，避免与 child 抢端口/单活。
    statusTarget = await profileServiceStatus({ descriptor: descriptorFor(targetHome), serviceHome });
  } catch {
    // 服务包不可用：按未托管处理
  }
  const serviceManaged = Boolean(statusNew.registered || statusLegacy.registered);
  if (!serviceManaged && oldWasLive && !force) {
    console.error('✗ 当前守护由外部托管（CLOUD_EXTERNALLY_MANAGED），CLI 不自动停止它。');
    console.error(`  先停止它，或显式：mebular cloud use ${id} --force（会杀 <oldHome>/lock 的 PID）`);
    process.exit(2);
  }

  const stop = async () => {
    if (serviceManaged) {
      if (statusLegacy.registered) {
        await uninstallProfileService({ descriptor: descriptorFor(previousHome), serviceHome: previousHome });
      }
      if (statusNew.registered) {
        await uninstallProfileService({ descriptor: descriptorFor(previousHome), serviceHome });
      }
    } else if (oldWasLive) {
      if (oldPid === null) {
        throw new Error('旧忆云健康响应存在但找不到 lock PID：拒绝盲目停止');
      }
      if (!(await looksLikeMebularServeAsync(oldPid))) {
        throw new Error(`lock PID ${oldPid} 不是 mebular serve：拒绝 --force 误杀`);
      }
      process.kill(oldPid, 'SIGTERM');
    }
    if (statusTarget.registered) {
      await uninstallProfileService({ descriptor: descriptorFor(targetHome), serviceHome }).catch(() => undefined);
    }
    if (await waitForCloudStopped(previousHome ?? cloud.root, { pid: oldPid, timeoutMs: 10_000 })) return;
    if (!serviceManaged && force && oldPid !== null && pidAliveSafe(oldPid)) {
      process.kill(oldPid, 'SIGKILL');
      if (await waitForCloudStopped(previousHome ?? cloud.root, { pid: oldPid, timeoutMs: 5_000 })) return;
    }
    throw new Error('旧忆云未能停止（端口/锁仍被占用）：请检查诊断');
  };

  const start = async ({ to, toHome }) => {
    // 回滚到一个切换前就未运行的旧忆云：恢复「未运行」状态，不额外拉起。
    if (to?.id === previous?.id && !oldWasLive) return;
    if (serviceManaged) {
      await installProfileService({
        descriptor: descriptorFor(toHome),
        serviceHome,
        autostart: statusNew.autostart ?? statusLegacy.autostart ?? true,
      });
      return;
    }
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [cliBin, 'serve'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MEBULAR_HOME: toHome, MEBULAR_CLOUD_ROOT: cloud.root },
    });
    child.unref();
  };

  const verify = async ({ to, home, rollback }) => {
    if (to?.id === previous?.id && !oldWasLive) return true;
    const result = await waitForCloudHealthy(home, {
      expectedInstance: homeKey(home),
      cloudId: to?.id ?? null,
      timeoutMs: 20_000,
    });
    if (result.ok) return true;
    if (result.reason === 'instance_mismatch') {
      throw new Error(`端口上运行的是另一张忆云（instance=${result.instance}），不是「${to?.name ?? '目标'}」`);
    }
    if (result.reason === 'instance_missing') {
      throw new Error('目标端口上的守护没有 /healthz instance 身份（旧版本？）：无法确认是目标忆云');
    }
    if (result.reason === 'cloud_mismatch') {
      throw new Error(`/healthz cloudId=${result.cloudId} 与目标「${to?.id}」不一致`);
    }
    void rollback;
    return false;
  };

  // 起新失败/健康校验失败：停掉可能已半启动的新忆云，避免回滚时双活。
  const abortTarget = async ({ toHome }) => {
    if (serviceManaged) {
      try {
        await uninstallProfileService({ descriptor: descriptorFor(toHome), serviceHome });
      } catch {
        // 未安装/已退出：继续按 PID 兜底
      }
    }
    const lock = await readHomeLock(toHome);
    const pid = Number.isInteger(lock?.pid) && pidAliveSafe(lock.pid) ? lock.pid : null;
    if (pid === null || !(await looksLikeMebularServeAsync(pid))) return;
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    if (await waitForCloudStopped(toHome, { pid, timeoutMs: 5_000 })) return;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    await waitForCloudStopped(toHome, { pid, timeoutMs: 3_000 });
  };

  try {
    const result = await switchProfile({ root: cloud.root, id, stop, start, verify, abort: abortTarget });
    console.log(JSON.stringify({
      ok: true,
      changed: result.changed,
      current: result.current,
      previous: result.previous,
      profile: result.profile,
      consoleUrl: await consoleUrlForHome(result.home),
      ...(result.warning ? { warning: result.warning } : {}),
    }, null, 2));
    console.log(`控制台：${await consoleUrlForHome(result.home)}`);
  } catch (error) {
    console.error(`✗ 切换失败（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
    if (error?.rollback && error.rollback.ok === false) {
      console.error(`  回滚也失败：${error.rollback.error}`);
    }
    process.exit(2);
  }
}

async function runCloud(action, args, flags) {
  if (action === 'list') return runCloudList();
  if (action === 'use') return runCloudUse(args[0], flags);
  if (action === 'rename') return runCloudRename(args[0], args[1]);
  console.error('用法：mebular cloud <list|use|rename> [id] [name] [--force]');
  process.exit(2);
}

// ---------- 共享 runtime：resolve / ensure / status + provider 注册表 ----------

function runtimeCliError(error) {
  return {
    ok: false,
    mode: 'error',
    reason: error?.code ?? 'error',
    message: error?.message ?? String(error),
  };
}

function printRuntimeJson(value, exitCode = 0) {
  console.log(JSON.stringify(value, null, 2));
  process.exit(exitCode);
}

async function runtimeRootForCli() {
  const { resolveCloudRoot } = await import('../src/profiles.mjs');
  const cloud = resolveCloudRoot({ env: process.env });
  if (!cloud.available) {
    const error = new Error(`runtime 上下文不可用（${cloud.reason ?? 'cloud_unavailable'}）`);
    error.code = 'CLOUD_UNAVAILABLE';
    throw error;
  }
  return cloud.root;
}

async function runRuntimeProvider(args, flags) {
  const { listRuntimeProviders, registerRuntimeProvider, removeRuntimeProvider } = await import('../src/runtime-providers.mjs');
  const root = await runtimeRootForCli();
  const sub = args[0];
  if (sub === 'list') {
    const state = await listRuntimeProviders(root);
    printRuntimeJson({
      ok: true,
      root,
      source: state.source,
      providers: state.providers,
      warnings: state.warnings,
    });
    return;
  }
  if (sub === 'add') {
    if (typeof flags.kind !== 'string' || typeof flags.path !== 'string') {
      const error = new Error('用法：mebular runtime provider add --kind app|cli|shared --path <abs> [--version V] [--capabilities a,b]');
      error.code = 'USAGE';
      throw error;
    }
    if (!existsSync(flags.path)) {
      const error = new Error(`provider 路径不存在：${flags.path}`);
      error.code = 'PROVIDER_PATH_MISSING';
      throw error;
    }
    const capabilities = typeof flags.capabilities === 'string'
      ? flags.capabilities.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
    const result = await registerRuntimeProvider(root, {
      kind: flags.kind,
      path: flags.path,
      version: typeof flags.version === 'string' ? flags.version : null,
      capabilities,
    });
    printRuntimeJson({
      ok: true,
      root,
      created: result.created,
      provider: { ...result.provider, available: true },
      warnings: result.warnings,
    });
    return;
  }
  if (sub === 'remove') {
    const result = await removeRuntimeProvider(root, {
      id: typeof flags.id === 'string' ? flags.id : undefined,
      kind: typeof flags.kind === 'string' ? flags.kind : undefined,
      path: typeof flags.path === 'string' ? flags.path : undefined,
    });
    printRuntimeJson({
      ok: true,
      root,
      removed: result.removed,
      warnings: result.warnings,
    });
    return;
  }
  const error = new Error('用法：mebular runtime provider <list|add|remove> [--kind ...] [--path ...] [--id ...]');
  error.code = 'USAGE';
  throw error;
}

async function runRuntimeInstall(action, flags) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let result;
  try {
    const { installRuntime } = await import('../src/runtime-installer.mjs');
    let home;
    try {
      // 只用于检测是否有正在运行的 daemon/service；失败不影响安装。
      const { resolveRuntimeContext } = await import('../src/runtime-supervisor.mjs');
      const context = await resolveRuntimeContext({ env: process.env });
      if (context.ok) home = context.home;
    } catch {
      home = undefined;
    }
    const inlineVersion = process.argv.slice(2).find((token) => token.startsWith('--version='));
    const requestedVersion = inlineVersion === undefined
      ? flags.version
      : inlineVersion.slice('--version='.length);
    result = await installRuntime({
      version: requestedVersion,
      reinstall: action === 'reinstall',
      home,
      env: process.env,
      signal: controller.signal,
    });
  } catch (error) {
    result = {
      ok: false,
      code: error?.code ?? 'install_failed',
      reason: error?.code ?? 'install_failed',
      message: `runtime 安装失败（${error?.code ?? 'install_failed'}）`,
      command: action,
      version: null,
      manualCommand: null,
      runtimeInstalled: false,
      providerRegistered: false,
    };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  printRuntimeJson(result, result.ok ? 0 : 2);
}

async function runRuntimeCurrent(args, flags) {
  const { readRuntimeCurrent, writeRuntimeCurrent, clearRuntimeCurrent, publicRuntimeCurrent } = await import('../src/runtime-current.mjs');
  const root = await runtimeRootForCli();
  const sub = args[0];
  if (sub === 'show' || sub === undefined) {
    const state = await readRuntimeCurrent(root);
    printRuntimeJson({
      ok: true,
      root,
      current: publicRuntimeCurrent(state.current),
      usable: state.usable === true,
      source: state.source,
      warnings: state.warnings,
    });
    return;
  }
  if (sub === 'set') {
    if (typeof flags.version !== 'string' || typeof flags['runtime-path'] !== 'string' || typeof flags.cli !== 'string') {
      const error = new Error('用法：mebular runtime current set --version V --runtime-path P --cli C [--provider shared] [--owner O] [--installed-at ISO] [--json]');
      error.code = 'USAGE';
      throw error;
    }
    const current = await writeRuntimeCurrent(root, {
      version: flags.version,
      runtimePath: flags['runtime-path'],
      cliPath: flags.cli,
      provider: typeof flags.provider === 'string' ? flags.provider : 'shared',
      owner: typeof flags.owner === 'string' ? flags.owner : 'shared',
      ...(typeof flags['installed-at'] === 'string' ? { installedAt: flags['installed-at'] } : {}),
    });
    printRuntimeJson({ ok: true, root, current });
    return;
  }
  if (sub === 'clear') {
    const cleared = await clearRuntimeCurrent(root);
    printRuntimeJson({ ok: true, root, cleared });
    return;
  }
  const error = new Error('用法：mebular runtime current <show|set|clear> [--version V --runtime-path P --cli C] [--json]');
  error.code = 'USAGE';
  throw error;
}

async function runtimeContextForService() {
  const { resolveRuntimeContext } = await import('../src/runtime-supervisor.mjs');
  const context = await resolveRuntimeContext({ env: process.env });
  if (!context.ok) {
    const error = new Error(`runtime 上下文不可用（${context.reason ?? 'cloud_unavailable'}）`);
    error.code = context.reason ?? 'CLOUD_UNAVAILABLE';
    throw error;
  }
  return context;
}

async function runRuntimeService(action) {
  if (!['install', 'uninstall', 'restart', 'status'].includes(action)) {
    const error = new Error('用法：mebular runtime service <install|uninstall|restart|status> [--json]');
    error.code = 'USAGE';
    throw error;
  }
  const context = await runtimeContextForService();
  const {
    installRuntimeService,
    restartRuntimeService,
    runtimeServiceStatus,
    uninstallRuntimeService,
  } = await import('../src/runtime-service.mjs');
  const common = {
    root: context.cloudRoot,
    home: context.home,
    env: process.env,
  };
  let result;
  if (action === 'install') {
    result = await installRuntimeService({ ...common, http: context.http });
    printRuntimeJson({ ...result, action }, result.ok ? 0 : 2);
    return;
  }
  if (action === 'uninstall') {
    result = await uninstallRuntimeService(common);
    printRuntimeJson({ ...result, action }, result.ok ? 0 : 2);
    return;
  }
  if (action === 'restart') {
    result = await restartRuntimeService(common);
    printRuntimeJson({ ...result, action }, result.ok ? 0 : 2);
    return;
  }
  result = await runtimeServiceStatus(common);
  printRuntimeJson({ ...result, action }, result.ok ? 0 : 2);
}

async function detectRunningRuntimeVersion() {
  try {
    const { resolveRuntimeContext, probeRuntimeHealth } = await import('../src/runtime-supervisor.mjs');
    const context = await resolveRuntimeContext({ env: process.env });
    if (!context.ok || !context.http) return null;
    const health = await probeRuntimeHealth(fetch, context.http, {
      expectedInstance: context.homeKey,
      cloudId: context.profileId,
      timeoutMs: 800,
    });
    return health?.ok === true ? (health.body?.version ?? null) : null;
  } catch {
    return null;
  }
}

async function runRuntimeCheckUpdate(flags) {
  const { checkRuntimeUpdate, runtimeUpdateExitCode } = await import('../src/runtime-update.mjs');
  const result = await checkRuntimeUpdate({
    env: process.env,
    force: flags.force === true,
    entry: 'cli',
    detectRunningVersion: detectRunningRuntimeVersion,
  });
  printRuntimeJson(result, runtimeUpdateExitCode(result));
}

async function runRuntimeUpdateState(args, flags = {}) {
  const sub = args[0] ?? 'show';
  const {
    publicRuntimeUpdateState,
    readRuntimeUpdateState,
    runtimeUpdateStatePath,
    setRuntimeUpdatePromptedVersion,
    setRuntimeUpdateSkippedVersion,
  } = await import('../src/runtime-update.mjs');
  const root = await runtimeRootForCli();
  if (sub === 'skip' || sub === 'prompted') {
    if (typeof flags.version !== 'string' || flags.version.length === 0) {
      const error = new Error(`用法：mebular runtime update-state ${sub} --version V [--json]`);
      error.code = 'USAGE';
      throw error;
    }
    const result = sub === 'skip'
      ? await setRuntimeUpdateSkippedVersion(root, flags.version)
      : await setRuntimeUpdatePromptedVersion(root, flags.version);
    printRuntimeJson({
      ok: true,
      root,
      path: runtimeUpdateStatePath(root),
      source: result.source,
      state: publicRuntimeUpdateState(result.state),
      warnings: result.warnings,
    });
    return;
  }
  if (sub !== 'show') {
    const error = new Error('用法：mebular runtime update-state <show|skip|prompted> [--version V] [--json]');
    error.code = 'USAGE';
    throw error;
  }
  const state = await readRuntimeUpdateState(root);
  printRuntimeJson({
    ok: true,
    root,
    path: runtimeUpdateStatePath(root),
    source: state.source,
    state: publicRuntimeUpdateState(state.state),
    warnings: state.warnings,
  });
}

async function runRuntimeUpgradeState(args) {
  const sub = args[0] ?? 'show';
  if (sub !== 'show') {
    const error = new Error('用法：mebular runtime upgrade-state show [--json]');
    error.code = 'USAGE';
    throw error;
  }
  const {
    inspectRuntimeUpgradeLock,
    publicRuntimeUpgradeState,
    readRuntimeUpgradeState,
    runtimeUpgradeStatePath,
  } = await import('../src/runtime-upgrade.mjs');
  const root = await runtimeRootForCli();
  const [state, lock] = await Promise.all([
    readRuntimeUpgradeState(root),
    inspectRuntimeUpgradeLock(root),
  ]);
  printRuntimeJson({
    ok: true,
    root,
    path: runtimeUpgradeStatePath(root),
    source: state.source,
    state: publicRuntimeUpgradeState(state.state),
    lock: {
      busy: lock.busy === true,
      stale: lock.stale !== false,
      holder: lock.holder ?? null,
    },
    warnings: state.warnings,
  });
}

/** `--to latest`：只接受共享 check 缓存里的 stable 目标，不接受任意 URL/registry。 */
async function resolveUpgradeTarget(to) {
  if (to !== 'latest') return { target: to, check: null };
  const { checkRuntimeUpdate } = await import('../src/runtime-update.mjs');
  const check = await checkRuntimeUpdate({
    env: process.env,
    entry: 'cli',
    detectRunningVersion: detectRunningRuntimeVersion,
  });
  if (check.available !== true || typeof check.latestVersion !== 'string') {
    return {
      target: null,
      check,
      error: {
        ok: false,
        action: 'upgrade',
        command: 'upgrade',
        reason: check.reason ?? check.decision ?? check.status ?? 'no_update_available',
        message: check.message ?? '没有可用的共享 runtime 更新；请先运行 runtime check-update',
        to: 'latest',
        status: check.status,
        currentVersion: check.currentVersion ?? null,
        latestVersion: check.latestVersion ?? null,
        available: false,
        busy: check.busy === true,
        runtimeChanged: false,
        serviceChanged: false,
      },
    };
  }
  return { target: check.latestVersion, check };
}

async function runRuntimeUpgrade(flags) {
  const { upgradeRuntime } = await import('../src/runtime-upgrade.mjs');
  const context = await runtimeContextForService().catch(() => null);
  const requested = typeof flags.to === 'string' ? flags.to : undefined;
  const resolved = await resolveUpgradeTarget(requested);
  if (resolved.error) {
    printRuntimeJson(resolved.error, 2);
    return;
  }
  const result = await upgradeRuntime({
    to: resolved.target,
    entry: 'cli',
    env: process.env,
    ...(context ? { root: context.cloudRoot, home: context.home } : {}),
  });
  printRuntimeJson(result, result.ok ? 0 : 2);
}

async function runRuntime(action, args, flags) {
  try {
    if (action === 'provider') {
      await runRuntimeProvider(args, flags);
      return;
    }
    if (action === 'current') {
      await runRuntimeCurrent(args, flags);
      return;
    }
    if (action === 'service') {
      await runRuntimeService(args[0], flags);
      return;
    }
    if (action === 'upgrade') {
      await runRuntimeUpgrade(flags);
      return;
    }
    if (action === 'upgrade-state') {
      await runRuntimeUpgradeState(args);
      return;
    }
    if (action === 'check-update') {
      await runRuntimeCheckUpdate(flags);
      return;
    }
    if (action === 'update-state') {
      await runRuntimeUpdateState(args, flags);
      return;
    }
    if (action === 'install' || action === 'reinstall') {
      await runRuntimeInstall(action, flags);
      return;
    }
    if (action === 'resolve' || action === 'ensure' || action === 'status' || action === 'supervise') {
      const {
        ensureRuntime,
        resolveRuntime,
        runtimeStatus,
        superviseRuntime,
        toPublicRuntimeResult,
      } = await import('../src/runtime-supervisor.mjs');
      const mode = typeof flags.start === 'string' ? flags.start : 'auto';
      const options = { env: process.env, mode, allowDownload: false };
      if (flags.port !== undefined) {
        const port = Number(flags.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          const error = new Error(`端口非法：${flags.port}`);
          error.code = 'INVALID_PORT';
          throw error;
        }
        options.port = port;
      }
      if (action === 'resolve') {
        const result = await resolveRuntime(options);
        printRuntimeJson(toPublicRuntimeResult(result), result.ok ? 0 : 2);
      }
      if (action === 'status') {
        const result = await runtimeStatus(options);
        printRuntimeJson(toPublicRuntimeResult(result), result.ok ? 0 : 2);
      }
      if (action === 'supervise') {
        // 入口所有权路径：前台持有 child；SIGTERM/SIGINT 时只停止自己拉起的 child。
        const exitCode = await superviseRuntime({ ...options, detached: false });
        process.exit(exitCode);
      }
      // ensure 默认成为 detached child 的 owner；CLI 退出后 daemon 继续运行。
      // 这是人工/诊断路径；入口（App/Plugin）不得依赖它拥有 child。
      options.detached = true;
      const result = await ensureRuntime(options);
      if (result.ok && result.mode === 'child') {
        console.error('note: runtime ensure 以 detached 方式启动 child（诊断用途）；入口请使用 mebular runtime supervise 持有 child');
      }
      printRuntimeJson(toPublicRuntimeResult(result), result.ok ? 0 : 2);
    }
    const error = new Error(
      '用法：mebular runtime <resolve|ensure|status|supervise|provider|install|reinstall|current|service|upgrade|upgrade-state|check-update|update-state> [--start auto|child|service] [--port N] [--version V] [--to V|latest] [--force] [--json]',
    );
    error.code = 'USAGE';
    throw error;
  } catch (error) {
    printRuntimeJson(runtimeCliError(error), 2);
  }
}

async function main() {
  const flags = parseFlags(argv.slice(1));
  switch (command) {
    case 'mcp': {
      const { startStdioServer } = await import('../src/server.mjs');
      try {
        await startStdioServer();
      } catch (error) {
        console.error(`✗ mcp 启动失败（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
        process.exit(2);
      }
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
        const { loadServiceModule } = await import('../src/service-loader.mjs');
        const { startHeartbeat, resolveBuildSha } = await loadServiceModule();
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
          console.log('引导态：家目录为空。请在浏览器打开控制台完成「新建忆云 / 加入已有忆云」，之后各设备自行订阅记忆域。');
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
      const { loadServiceModule } = await import('../src/service-loader.mjs');
      let serviceLib;
      try {
        serviceLib = await loadServiceModule();
      } catch (error) {
        console.error(`✗ service 不可用（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
        process.exit(2);
      }
      const { runServiceCli } = serviceLib;
      const home = homeDir();
      const bin = process.argv[1];
      const descriptor = {
        kind: 'mebular-serve',
        args: [bin, 'serve'],
        heartbeatDir: home,
        workingDir: home,
        env: { MEBULAR_HOME: home },
      };
      process.exit(runServiceCli({ descriptors: [descriptor], argv: argv.slice(1), sha: serviceBuildSha() }));
      return;
    }
    case 'console': {
      await runConsole(flags);
      return;
    }
    case 'cloud': {
      await runCloud(argv[1], argv.slice(2), flags);
      return;
    }
    case 'runtime': {
      await runRuntime(argv[1], argv.slice(2), flags);
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
          '  cloud list|use|rename [id] [name] [--force]   忆云管理（use 停旧/起新/失败回滚）',
          '  runtime resolve|ensure|status|supervise [--start auto|child|service] [--port N] [--json]  共享 runtime（supervise 持有 child）',
          '  runtime install|reinstall [--version V] [--json]  安装/重装共享 runtime（固定 @mebular/core 版本）',
          '  runtime upgrade --to V|latest [--json]  显式升级共享 runtime（复用 installer；service 存在时更新并重启；跨入口 upgrade.lock）',
          '  runtime upgrade-state show [--json]  查看共享升级状态（只读诊断，不联网）',
          '  runtime check-update [--force] [--json]  只读检查官方 npm @mebular/core stable 更新（24h 节流；不安装）',
          '  runtime update-state show [--json]  查看共享更新状态（只读诊断，不联网）',
          '  runtime update-state skip --version V [--json]  跳过此版本（写共享 skippedVersion，两个入口都遵守）',
          '  runtime update-state prompted --version V [--json]  记录已提示版本（两入口共享去重）',
          '  runtime current show|set|clear [--version V --runtime-path P --cli C --provider shared --owner O --installed-at ISO]  current 指针（非敏感）',
          '  runtime service install|uninstall|restart|status [--json]  共享 mebular-serve 所有权/生命周期',
          '  runtime provider list|add|remove [--kind app|cli|shared --path P --version V --capabilities a,b --id ID]  runtime provider 注册表',
          '  token grant|list|revoke [--scope a,b] [--id x] [--tokens-file p]   bearer 令牌管理',
          '  token client add|list|remove [--redirect uri] [--scope a,b] [--id x]   OAuth 客户端预注册',
          '  token consent [--scope a,b] [--ttl sec]   生成一次性本地同意码（/authorize 用）',
          '  init / keygen / print-config / status|doctor   初始化（已有身份时沿用其 deviceId）、状态与自检',
          '  doctor --net                 网络排障：地址簿/路径状态 + relay 可达性 + 下一步建议',
          '  tools                        打印 MCP 工具 ↔ CLI 对照表',
          '  memory_write|memory_write_batch|memory_query|memory_search|memory_profile|memory_skills|',
          '  memory_history|memory_graph|memory_import|memory_status|memory_sync   与 MCP 同名同 handler',
        ].join('\n'),
      );
      process.exit(0);
      return;
    case 'init':
      try {
        await runInit(flags);
      } catch (error) {
        console.error(`✗ init 失败（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
        process.exit(2);
      }
      return;
    case 'keygen':
      await runKeygen(flags);
      return;
    case 'print-config':
      await runPrintConfig(flags);
      return;
    case 'tools': {
      const { ALL_TOOL_SPECS } = await import('../src/tools.mjs');
      console.log(JSON.stringify({ ok: true, tools: ALL_TOOL_SPECS.map((t) => ({ tool: t.name, cli: t.name })) }, null, 2));
      return;
    }
    case 'status':
      try {
        await runStatus();
      } catch (error) {
        console.error(`✗ status 失败（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
        process.exit(2);
      }
      return;
    case 'doctor':
      if (flags.net === true || flags.net === 'true') {
        await runNetDoctor();
        return;
      }
      try {
        await runStatus();
      } catch (error) {
        console.error(`✗ doctor 失败（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
        process.exit(2);
      }
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
