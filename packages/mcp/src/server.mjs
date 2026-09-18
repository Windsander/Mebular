// MCP server 装配（G6.2）：stdio 传输 + 11 工具 + memory_policy prompt。
// 全部委托 MemoryService（D33 单一实现）。

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MemoryService } from '@mebular/core';
import { createMebular } from './config.mjs';
import { registerTools } from './tools.mjs';
import { startHttpServer, acquireLock } from './serve.mjs';

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
  const { app, home, storagePath, config, effective } = await createMebular();
  const lock = await acquireLock(home, storagePath);
  try {
    const service = new MemoryService(app);
    // 参与配置：CLI 优先，其次 config.mcp.http（此前 serve 完全忽略 config，设置卡会失真）
    const httpCfg = config?.mcp?.http ?? {};
    const tlsKey = options.tlsKey ?? httpCfg.tlsKey;
    const tlsCert = options.tlsCert ?? httpCfg.tlsCert;
    const runtime = {
      ...effective,
      storagePath,
      mcp: {
        host: options.host ?? httpCfg.host ?? '127.0.0.1',
        port: options.port ?? httpCfg.port ?? 7331,
        auth: options.auth ?? httpCfg.auth ?? 'none',
        tls: Boolean(tlsKey && tlsCert),
      },
    };
    const http = await startHttpServer({
      home,
      app,
      service,
      config,
      buildServer,
      host: runtime.mcp.host,
      port: runtime.mcp.port,
      auth: runtime.mcp.auth,
      tls: runtime.mcp.tls,
      tlsKey,
      tlsCert,
      tokensFile: options.tokensFile ?? httpCfg.tokensFile,
      runtime,
      // D2：写端点开启（仍需 memory.admin scope + CSRF 双提交）
      writesEnabled: true,
    });
    // 监听端口 0 / 默认值时以实际绑定为准
    runtime.mcp.host = http.host;
    runtime.mcp.port = http.port;
    runtime.mcp.auth = http.auth;
    const shutdown = async () => {
      await http.close().catch(() => undefined);
      await lock.release();
      await app.shutdown().catch(() => undefined);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return { ...http, lock, app, service };
  } catch (error) {
    await lock.release();
    await app.shutdown().catch(() => undefined);
    throw error;
  }
}
