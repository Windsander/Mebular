// Minimal OpenAI-compatible endpoint used only to let real OpenCode execute a
// turn without a real LLM. It records request bodies so the test can prove the
// plugin's context block reached the outgoing model request.

import { createServer } from 'node:http';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

function isSummaryRequest(body) {
  // Only the user prompt decides. OpenCode's system prompt mentions
  // compaction in normal turns, so looking at every message misclassifies the
  // agent's first request as a summary request.
  const text = (body?.messages ?? [])
    .filter((message) => message?.role === 'user')
    .map((message) => textOf(message?.content))
    .join('\n')
    .toLowerCase();
  return text.includes('summar') || text.includes('compact');
}

/**
 * @param {{ reply?: string, summary?: string }} [options]
 */
export async function createFakeOpenAI(options = {}) {
  const reply = options.reply ?? 'OK';
  // OpenCode validates the summary template. Keep the required headings so the
  // real host reaches session.compaction.ended without a real model.
  const summary = options.summary ?? [
    '## Objective',
    '- Host E2E compaction objective.',
    '## Requirements',
    '- (none)',
    '## Decisions',
    '- (none)',
    '## Work State',
    '### Completed',
    '- (none)',
    '### Active',
    '- (none)',
    '### Blocked',
    '- (none)',
    '## Next Move',
    '1. (none)',
    '## Relevant Files',
    '- (none)',
    '## Important Context',
    '- (none)',
  ].join('\n');
  const state = { requests: [] };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const bodyBuffer = await readBody(req);
    let body = null;
    try {
      body = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString('utf8')) : null;
    } catch {
      body = null;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const content = isSummaryRequest(body) ? summary : reply;
      state.requests.push({
        at: new Date().toISOString(),
        path: url.pathname,
        body,
        content,
      });
      if (body?.stream === false) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'chatcmpl-host-e2e',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body?.model ?? 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-host-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? 'mock',
      };
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content }));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
