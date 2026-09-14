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
      sync: { autoSync: true },
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

async function runStatus() {
  const { createMebular } = await import('../src/config.mjs');
  const { MemoryService } = await import('@mebular/core');
  const { app, home, storagePath } = await createMebular();
  try {
    const status = await new MemoryService(app).status();
    console.log(JSON.stringify({ ...status, home, storagePath }, null, 2));
  } finally {
    await app.shutdown().catch(() => undefined);
  }
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
      try {
        const result = await startServeServer({
          host: typeof flags.host === 'string' ? flags.host : undefined,
          port: flags.port !== undefined ? Number(flags.port) : undefined,
          auth: typeof flags.auth === 'string' ? flags.auth : undefined,
          tlsKey: typeof flags['tls-key'] === 'string' ? flags['tls-key'] : undefined,
          tlsCert: typeof flags['tls-cert'] === 'string' ? flags['tls-cert'] : undefined,
          tokensFile: typeof flags['tokens-file'] === 'string' ? flags['tokens-file'] : undefined,
        });
        console.log(`SERVE_READY ${JSON.stringify({ host: result.host, port: result.port, auth: result.auth, issuer: result.issuer })}`);
      } catch (error) {
        console.error(`✗ serve 启动失败（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`);
        process.exit(2);
      }
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
          '  token grant|list|revoke [--scope a,b] [--id x] [--tokens-file p]   bearer 令牌管理',
          '  token client add|list|remove [--redirect uri] [--scope a,b] [--id x]   OAuth 客户端预注册',
          '  token consent [--scope a,b] [--ttl sec]   生成一次性本地同意码（/authorize 用）',
          '  init / keygen / print-config / status   初始化与状态',
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
    case 'status':
      await runStatus();
      return;
    default:
      console.error(`未知命令：${command ?? '(空)'}`);
      process.exit(2);
  }
}

await main();
