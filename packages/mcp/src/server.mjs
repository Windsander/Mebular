// MCP server 装配（G6.2）：stdio 传输 + 11 工具 + memory_policy prompt。
// 全部委托 MemoryService（D33 单一实现）。

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MemoryService } from '@mebular/core';
import { createMebular } from './config.mjs';
import { registerTools } from './tools.mjs';

const MEMORY_POLICY = `# Mebular 记忆使用规约（memory_policy）
1. 先查后写：写入前先用 memory_query/memory_search 查重，避免重复。
2. 类型选择：稳定事实→fact；用户偏好→preference；会话/任务过程→episode；可复用步骤→skill；观察→observation。
3. 时效：有有效期的用 metadata.expiresAt；过期事实不要当现状。
4. 关系：相关对象用 metadata.relatedTo 精确关联（仅链接已存在节点）。
5. 隐私：不要写入密钥、口令、完整身份证件等高敏感信息。
6. 无结果别编：召回为空就如实说明，不要臆造记忆。`;

function buildServer(service) {
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
