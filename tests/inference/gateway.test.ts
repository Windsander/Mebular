// OpenAI-compatible gateway：schema 请求/校验、超时、429 重试、熔断、heuristic 回退。

import { describe, it, expect } from '@jest/globals';
import {
  ChatCompletionGateway,
  GatewayError,
  type ChatFetch,
  type ChatFetchResponse,
  type ChatJsonRequest,
} from '../../src/inference/index.js';
import { headerMap } from './helpers.js';

const schema = {
  name: 'extract',
  schema: {
    type: 'object',
    required: ['records'],
    properties: {
      records: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

const request: ChatJsonRequest = {
  messages: [{ role: 'user', content: 'extract this' }],
  responseSchema: schema,
};

function chatResponse(
  status: number,
  content: string,
  headers: Record<string, string> = {},
): ChatFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap(headers),
    text: async () => JSON.stringify({
      choices: [{ message: { content } }],
    }),
  };
}

function gateway(fetchImpl: ChatFetch, overrides: {
  timeoutMs?: number;
  maxRetries?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  return new ChatCompletionGateway({
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen-test',
    apiKey: 'secret-key',
    fetch: fetchImpl,
    timeoutMs: overrides.timeoutMs ?? 100,
    maxRetries: overrides.maxRetries ?? 1,
    circuitFailureThreshold: overrides.circuitFailureThreshold ?? 5,
    circuitCooldownMs: overrides.circuitCooldownMs ?? 30_000,
    now: () => 1000,
    sleep: overrides.sleep ?? (async () => {}),
  });
}

describe('ChatCompletionGateway', () => {
  it('发送 JSON schema 请求并校验返回结构', async () => {
    const calls: Array<{ url: string; init: Parameters<ChatFetch>[1] }> = [];
    const fetchImpl: ChatFetch = async (url, init) => {
      calls.push({ url, init });
      return chatResponse(200, JSON.stringify({ records: [{ text: 'user prefers dark mode' }] }));
    };

    const result = await gateway(fetchImpl).completeJson<{ records: Array<{ text: string }> }>(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ records: [{ text: 'user prefers dark mode' }] });
    expect(result.attempts).toBe(1);
    expect(result.degraded).toBe(false);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen-test',
      stream: false,
      messages: [{ role: 'user', content: 'extract this' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extract', strict: true },
      },
    });
  });

  it('超时：重试一次后回退 heuristic，不切换供应商', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl: ChatFetch = async (_url, init) => {
      calls += 1;
      return new Promise<ChatFetchResponse>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    const result = await gateway(fetchImpl, {
      timeoutMs: 10,
      maxRetries: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).completeJson<{ records: [] }>(request, () => ({ records: [] }));

    expect(result).toMatchObject({
      ok: false,
      fallback: 'heuristic',
      degraded: true,
      error: { code: 'timeout' },
      attempts: 2,
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it('非法 JSON：一次失败后回退，不无限重试', async () => {
    let calls = 0;
    const fetchImpl: ChatFetch = async () => {
      calls += 1;
      return chatResponse(200, 'not valid json');
    };
    const result = await gateway(fetchImpl).completeJson<{ records: [] }>(request, () => ({ records: [] }));
    expect(result).toMatchObject({
      ok: false,
      fallback: 'heuristic',
      error: { code: 'invalid_json' },
      attempts: 1,
    });
    expect(calls).toBe(1);
  });

  it('schema 不匹配：回退 heuristic', async () => {
    const fetchImpl: ChatFetch = async () => chatResponse(200, JSON.stringify({ records: 'wrong-shape' }));
    const result = await gateway(fetchImpl).completeJson<{ records: [] }>(request, () => ({ records: [] }));
    expect(result).toMatchObject({
      ok: false,
      fallback: 'heuristic',
      error: { code: 'schema_mismatch' },
      attempts: 1,
    });
  });

  it('429 尊重 Retry-After 并重试一次后成功', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl: ChatFetch = async () => {
      calls += 1;
      if (calls === 1) return chatResponse(429, '', { 'Retry-After': '2' });
      return chatResponse(200, JSON.stringify({ records: [] }));
    };
    const result = await gateway(fetchImpl, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).completeJson<{ records: [] }>(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(calls).toBe(2);
  });

  it('5xx 连续失败触发熔断；熔断后不再发请求，直接 heuristic', async () => {
    let calls = 0;
    const fetchImpl: ChatFetch = async () => {
      calls += 1;
      return chatResponse(500, '');
    };
    const client = gateway(fetchImpl, { maxRetries: 0, circuitFailureThreshold: 2 });

    const first = await client.completeJson<{ records: [] }>(request, () => ({ records: [] }));
    expect(first).toMatchObject({ ok: false, error: { code: 'http', status: 500 } });
    const second = await client.completeJson<{ records: [] }>(request, () => ({ records: [] }));
    expect(second).toMatchObject({ ok: false, error: { code: 'http', status: 500 } });
    expect(client.isCircuitOpen()).toBe(true);

    const third = await client.completeJson<{ records: [] }>(request, () => ({ records: [] }));
    expect(third).toMatchObject({
      ok: false,
      error: { code: 'circuit_open' },
      attempts: 0,
    });
    expect(calls).toBe(2);

    client.resetCircuit();
    expect(client.isCircuitOpen()).toBe(false);
  });

  it('无 fallback 时抛出 GatewayError，错误不含响应体', async () => {
    const fetchImpl: ChatFetch = async () => chatResponse(500, 'secret-response-body');
    await expect(gateway(fetchImpl, { maxRetries: 0 }).completeJson(request))
      .rejects.toMatchObject({ failure: { code: 'http', status: 500 } });
    try {
      await gateway(fetchImpl, { maxRetries: 0 }).completeJson(request);
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect(String((error as Error).message)).not.toContain('secret-response-body');
    }
  });
});
