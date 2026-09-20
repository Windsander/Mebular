// W1 fleet MCP 任务面（**独立于守护的记忆 MCP**）：stdio + newline-delimited JSON-RPC 2.0。
//
// 暴露 `TASK_TOOLS`（与 CLI 同一 handler，能力完全一致）：`initialize` / `tools/list` / `tools/call`。
// 只消费 `@mebular/core` 公共 API；输出为 MCP `content[].text`（JSON 字符串）。

import { TASK_TOOLS, toolByName, type ToolContext } from './surface.js';

export interface FleetMcpOptions {
  dir: string;
  namespace?: string;
  agent?: string;
}

const SERVER_INFO = { name: 'mebular-fleet', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function reply(id: number | string | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}
function replyError(id: number | string | null | undefined, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** 处理单条 JSON-RPC 请求；返回响应字符串（通知返回 null）。 */
export async function handleMcpMessage(line: string, ctx: ToolContext): Promise<string | null> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return replyError(null, -32700, 'parse error');
  }
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return replyError(req.id, -32600, 'invalid request');
  if (req.id === undefined) return null; // 通知：无响应
  switch (req.method) {
    case 'initialize':
      return reply(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'tools/list':
      return reply(req.id, {
        tools: TASK_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const params = req.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = toolByName(name);
      if (tool === undefined) return replyError(req.id, -32602, `unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        const result = await tool.handler(args, ctx);
        return reply(req.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        return reply(req.id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (error as Error).message }) }], isError: true });
      }
    }
    default:
      return replyError(req.id, -32601, `method not found: ${req.method}`);
  }
}

/** stdio 主循环：逐行读 JSON-RPC，逐行回写响应。 */
export async function runFleetMcp(options: FleetMcpOptions, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const ctx: ToolContext = { dir: options.dir, ...(options.namespace !== undefined ? { namespace: options.namespace } : {}), ...(options.agent !== undefined ? { agent: options.agent } : {}) };
  let buffer = '';
  for await (const chunk of input) {
    buffer += String(chunk);
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length === 0) continue;
      const response = await handleMcpMessage(line, ctx);
      if (response !== null) output.write(response + '\n');
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    const response = await handleMcpMessage(tail, ctx);
    if (response !== null) output.write(response + '\n');
  }
}
