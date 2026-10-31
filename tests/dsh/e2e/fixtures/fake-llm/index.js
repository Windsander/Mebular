// Test-only DSH LLM adapter for the immersive journey.
//
// It registers one provider route (`fake`) and answers every model request with
// deterministic text. It never opens a socket and never calls an external model.
// The adapter records the exact request DSH assembled (messages, source tags,
// tools) so the harness can prove:
//   - recalled memory arrives as one source-tagged `mebular-memory` message;
//   - no `memory_*` tool reaches the ordinary Agent tool list;
//   - a silent turn carries no memory block at all.
//
// The observation document is written to MEMORY_E2E_LLM_OUT (a temporary
// directory owned by the harness). Nothing is written when the variable is unset.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const name = '@mebular/dsh-fake-llm';
export const inject = ['llm'];

const DEFAULT_REPLY = 'FAKE_ASSISTANT_REPLY';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function sourceKind(message) {
  return typeof message?.source?.kind === 'string' ? message.source.kind : null;
}

function summarizeMessage(message) {
  return {
    id: typeof message?.id === 'string' ? message.id : null,
    role: typeof message?.role === 'string' ? message.role : null,
    source: sourceKind(message),
    text: textOf(message?.content),
  };
}

function toolNames(options) {
  return Array.isArray(options?.tools)
    ? options.tools.map((tool) => String(tool?.name ?? '')).filter(Boolean)
    : [];
}

function historicalToolNames(options) {
  return Array.isArray(options?.toolHistory?.tools)
    ? [...new Set(options.toolHistory.tools.map((tool) => String(tool?.name ?? '')).filter(Boolean))]
    : [];
}

function summaryText() {
  return [
    '## Objective',
    '- Fake DSH compaction objective.',
    '## Requirements',
    '- Keep checkpoint schema 2',
    '## Decisions',
    '- Use the real Mebular adapter',
    '## Work State',
    '- Done: fake compaction summary',
    '- Doing: next turn',
    '- Blocked: none',
    '## Next Move',
    '- Verify the next turn injects the checkpoint',
    '## Relevant Files',
    '- tests/dsh/e2e/fixtures/fake-llm/index.js (read)',
  ].join('\n');
}

export function apply(ctx, config = {}) {
  const out = typeof process.env.MEMORY_E2E_LLM_OUT === 'string'
    && process.env.MEMORY_E2E_LLM_OUT.length > 0
    ? process.env.MEMORY_E2E_LLM_OUT
    : null;
  const reply = typeof config.reply === 'string' && config.reply.length > 0
    ? config.reply
    : DEFAULT_REPLY;
  const requests = [];
  let sequence = 0;

  function persist() {
    if (out === null) return;
    try {
      mkdirSync(dirname(out), { recursive: true });
      const tmp = `${out}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        requests,
      }, null, 2)}\n`, 'utf-8');
      renameSync(tmp, out);
    } catch {
      // The harness treats a missing observation as a failed assertion.
    }
  }

  function responseFor(options) {
    if (options?.purpose === 'session-title') return 'Fake Session';
    if (options?.purpose === 'compaction') return summaryText();
    return reply;
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'Fake LLM' };
    },
    providerRetryPolicy() {},
    imageRequestPricing() {},
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes };
    },
    listModels(provider) {
      return Promise.resolve([{ provider, id: 'fake', name: 'Fake' }]);
    },
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model });
    },
    async prepareCall(provider, model) {
      return {
        model: await this.resolveModel(provider, model),
        stream: (options) => this.stream(options),
      };
    },
    async *stream(options) {
      const messages = Array.isArray(options?.messages)
        ? options.messages.map(summarizeMessage)
        : [];
      const content = responseFor(options);
      requests.push({
        sequence,
        at: new Date().toISOString(),
        purpose: typeof options?.purpose === 'string' ? options.purpose : null,
        sessionId: typeof options?.sessionId === 'string' ? options.sessionId : null,
        provider: typeof options?.provider === 'string' ? options.provider : null,
        model: typeof options?.model === 'string' ? options.model : null,
        tools: toolNames(options),
        historicalTools: historicalToolNames(options),
        messages,
        reply: content,
      });
      sequence += 1;
      persist();
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: content };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: content } };
      yield {
        type: 'usage',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  ctx.llm.registerAdapter(['fake'], adapter);
}
