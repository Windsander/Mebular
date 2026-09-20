// MCP server 装配（G6.2）：stdio 传输 + 11 工具 + memory_policy prompt。
// 全部委托 MemoryService（D33 单一实现）。

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MemoryService } from '@mebular/core';
import { createMebular } from './config.mjs';
import { registerTools } from './tools.mjs';
import { startHttpServer, acquireLock } from './serve.mjs';
import { startJoinService } from '@mebular/fleet';

const MEMORY_POLICY = `# Mebular 记忆使用规约（memory_policy）
1. 先查后写：写入前先用 memory_query/memory_search 查重，避免重复。
2. 类型选择：稳定事实→fact；用户偏好→preference；会话/任务过程→episode；可复用步骤→skill；观察→observation。
3. 时效：有有效期的用 metadata.expiresAt；过期事实不要当现状。
4. 关系：相关对象用 metadata.relatedTo 精确关联（仅链接已存在节点）。
5. 隐私：不要写入密钥、口令、完整身份证件等高敏感信息。
6. 无结果别编：召回为空就如实说明，不要臆造记忆。`;

export function buildServer(service) {
  const server = new McpServer({ name: 'mebular', version: '0.1.0' });
  registerTools(server, service);
  server.registerPrompt(
    'memory_policy',
    {
      title: 'Mebular 记忆使用规约',
      description: '先查后写 / 类型选择 / 时效 / 隐私 / 关系 / 无结果别编',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: MEMORY_POLICY },
        },
      ],
    }),
  );
  return server;
}

/** 启动 stdio MCP server；返回句柄用于收尾 */
export async function startStdioServer() {
  const { app } = await createMebular();
  const service = new MemoryService(app);
  const handle = serveStdio(() => buildServer(service));

  const shutdown = async () => {
    await handle.close().catch(() => undefined);
    await app.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { handle, app, service };
}

/**
 * 启动 Streamable HTTP server（G6.3）。
 * 单实例：先取 <home>/lock；被占抛 MCP_STORAGE_LOCKED。
 */
export async function startServeServer(options = {}) {
  const { app, home, storagePath, deviceId, config } = await createMebular();
  const lock = await acquireLock(home, storagePath);
  let joinServer = null;
  try {
    const service = new MemoryService(app);
    const joinConf = config.joinService;
    const joinEndpointDemo = joinConf?.enabled
      ? `http://${joinConf.bind && joinConf.bind !== '0.0.0.0' ? joinConf.bind : '127.0.0.1'}:${joinConf.port ?? 4002}`
      : undefined;
    const http = await startHttpServer({
      home,
      app,
      service,
      buildServer,
      host: options.host,
      port: options.port,
      auth: options.auth,
      tls: Boolean(options.tlsKey),
      tlsKey: options.tlsKey,
      tlsCert: options.tlsCert,
      tokensFile: options.tokensFile,
      deviceId,
      namespace: config.sync?.namespaces?.[0] ?? 'tasks',
      ...(joinEndpointDemo !== undefined ? { joinEndpoint: joinEndpointDemo } : {}),
    });
    // W2 A4：join 服务由守护托管（令牌 → 委派证书）。fleet 不再托管生产 join。
    if (joinConf?.enabled) {
      joinServer = await startJoinService({
        mebular: app,
        deviceId,
        storagePath,
        bind: joinConf.bind ?? '0.0.0.0',
        port: joinConf.port ?? 4002,
        log: (m) => console.error(m),
      });
      console.error(`JOIN_READY ${JSON.stringify({ endpoint: joinEndpointDemo, port: joinServer.port })}`);
    }
    const shutdown = async () => {
      await joinServer?.close().catch(() => undefined);
      await http.close().catch(() => undefined);
      await lock.release();
      await app.shutdown().catch(() => undefined);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return { ...http, lock, app, service, joinServer, joinPort: joinServer?.port ?? null };
  } catch (error) {
    await joinServer?.close().catch(() => undefined);
    await lock.release();
    await app.shutdown().catch(() => undefined);
    throw error;
  }
}
