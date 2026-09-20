// 最小 MCP Streamable HTTP 客户端（CLI 在**守护持锁**时作为本机 MCP 客户端调用 `/mcp`）。
//
// 仅覆盖 CLI 所需：initialize → notifications/initialized → tools/call。
// 复用既有 bearer token 体系（`mebular token`）。

async function rpc(endpoint, token, message, sessionId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(message), signal: controller.signal });
    const sid = res.headers.get('mcp-session-id') ?? sessionId ?? null;
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}：${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const dataLines = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      const last = dataLines[dataLines.length - 1];
      return { sessionId: sid, json: last ? JSON.parse(last) : null };
    }
    return { sessionId: sid, json: text.trim().length > 0 ? JSON.parse(text) : null };
  } finally {
    clearTimeout(timer);
  }
}

/** 调用守护 MCP 的某个工具；返回 MCP result（{content, structuredContent}）。 */
export async function callToolViaHttp({ endpoint, token, name, args, timeoutMs = 30000 }) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new Error('缺少守护 MCP 端点');
  const url = `${endpoint.replace(/\/+$/, '')}/mcp`;
  const init = await rpc(url, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mebular-cli', version: '0.1.0' } },
  }, null, timeoutMs);
  const sessionId = init.sessionId;
  await rpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId, timeoutMs);
  const res = await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, sessionId, timeoutMs);
  if (res.json?.error) throw new Error(`MCP 错误：${res.json.error.message ?? JSON.stringify(res.json.error)}`);
  return res.json?.result ?? null;
}
