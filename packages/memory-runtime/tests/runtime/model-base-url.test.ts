// Runtime api baseUrl：无 /v1 时归一化；userinfo/metadata/link-local/非 https 拒绝。

import { describe, expect, it } from '@jest/globals';
import {
  createRuntimeModelRuntime,
  normalizeRuntimeSettings,
} from '../../src/index.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';

function settings(baseUrl: string) {
  return normalizeRuntimeSettings({
    model: {
      source: 'api',
      api: {
        baseUrl,
        model: 'test-model',
        keyRef: 'env:TEST_RUNTIME_KEY',
        allowRemote: true,
        timeoutMs: 20,
      },
    },
  }).model;
}

function response(): ChatFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async text() {
      return JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              candidates: [{
                kind: 'preference',
                data: { entity: 'user', preferenceType: 'theme', value: 'dark' },
              }],
            }),
          },
        }],
      });
    },
  };
}

function request() {
  return {
    source: 'api' as const,
    chunks: [{ role: 'user' as const, text: '以后默认用深色主题' }],
    namespace: 'notes',
    agentId: 'opencode',
    allowRemote: true,
  };
}

function runtime(baseUrl: string, fetchImpl: ChatFetch) {
  return createRuntimeModelRuntime(settings(baseUrl), {
    env: { TEST_RUNTIME_KEY: 'sk-base-url-secret' },
    fetch: fetchImpl,
    sleep: async () => undefined,
  });
}

describe('Runtime api baseUrl', () => {
  it('normalizeRuntimeSettings 把合法地址规范到 /v1，非法值保留给 probe 拒绝', () => {
    expect(settings('https://api.example.test').api.baseUrl).toBe('https://api.example.test/v1');
    expect(settings('https://api.example.test/v1/').api.baseUrl).toBe('https://api.example.test/v1');
    expect(settings('https://user:pass@api.example.test/v1').api.baseUrl)
      .toBe('https://user:pass@api.example.test/v1');
  });

  it('不带 /v1 也能请求，并规范到 /v1/chat/completions', async () => {
    const urls: string[] = [];
    const model = runtime('https://api.example.test', async (url) => {
      urls.push(url);
      return response();
    });

    const result = await model.extractCandidates(request());
    expect(result.ok).toBe(true);
    expect(urls).toEqual(['https://api.example.test/v1/chat/completions']);
    expect((await model.probe()).api).toMatchObject({ configured: true, available: true });
  });

  it.each([
    ['userinfo', 'https://user:pass@api.example.test/v1'],
    ['metadata IPv4', 'https://169.254.169.254/v1'],
    ['metadata host', 'https://metadata.google.internal/v1'],
    ['link-local IPv4', 'https://169.254.1.1/v1'],
    ['link-local IPv6', 'https://[fe80::1]/v1'],
    ['non-https', 'http://api.example.test/v1'],
  ])('拒绝 %s，不发起 fetch', async (_label, baseUrl) => {
    let calls = 0;
    const model = runtime(baseUrl, async () => {
      calls += 1;
      return response();
    });

    const result = await model.extractCandidates(request());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_base_url');
    expect(result.warnings).toEqual(expect.arrayContaining([
      'model_api_insecure_url',
      'model_unavailable',
    ]));
    expect(calls).toBe(0);

    const probe = await model.probe();
    expect(probe.api).toMatchObject({ available: false, reason: 'invalid_base_url' });
    expect(JSON.stringify({ result, probe })).not.toContain('pass@');
  });

  it('http loopback 仍然允许（本地 OpenAI-compatible 服务）', async () => {
    const urls: string[] = [];
    const model = runtime('http://127.0.0.1:8080', async (url) => {
      urls.push(url);
      return response();
    });
    const result = await model.extractCandidates(request());
    expect(result.ok).toBe(true);
    expect(urls).toEqual(['http://127.0.0.1:8080/v1/chat/completions']);
  });
});
