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

async function runToken(action, flags) {
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
      await runToken(argv[1], flags);
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
          '  token grant|list|revoke [--scope a,b] [--id x] [--tokens-file p]   访问令牌管理',
          '  init / keygen / print-config / status   （G6.4+ 计划）',
        ].join('\n'),
      );
      process.exit(0);
      return;
    case 'init':
    case 'keygen':
    case 'print-config':
    case 'status':
      console.error(`mebular ${command}：尚未实现（按 G6 计划补齐）`);
      process.exit(2);
      return;
    default:
      console.error(`未知命令：${command ?? '(空)'}`);
      process.exit(2);
  }
}

await main();
