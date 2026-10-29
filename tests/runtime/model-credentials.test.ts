// Runtime 模型凭据：keychain 读取（macOS/unsupported）与 file: 0600 权限。

import { afterEach, describe, expect, it } from '@jest/globals';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeModelRuntime,
  normalizeRuntimeSettings,
  type RuntimeKeychainExec,
  type RuntimeModelRuntime,
} from '../../src/runtime/index.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';

const SECRET = 'sk-keychain-or-file-secret-never-log';

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mebular-model-credentials-'));
  dirs.push(dir);
  return dir;
}

function apiSettings(overrides: Record<string, unknown> = {}) {
  return normalizeRuntimeSettings({
    model: {
      source: 'api',
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_RUNTIME_KEY',
        allowRemote: true,
        timeoutMs: 20,
        ...overrides,
      },
    },
  }).model;
}

function validCandidates(): string {
  return JSON.stringify({
    candidates: [
      {
        kind: 'preference',
        data: { entity: 'user', preferenceType: 'theme', value: 'dark' },
      },
    ],
  });
}

function response(content = validCandidates()): ChatFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async text() {
      return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
    },
  };
}

function authorizedFetch(): { fetch: ChatFetch; calls: Array<{ url: string; authorization?: string }> } {
  const calls: Array<{ url: string; authorization?: string }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization });
      return response();
    },
  };
}

function candidateRequest() {
  return {
    source: 'api' as const,
    chunks: [{ role: 'user' as const, text: '以后默认用深色主题' }],
    namespace: 'notes',
    agentId: 'opencode',
    allowRemote: true,
  };
}

function runtimeWith(
  settings: ReturnType<typeof apiSettings>,
  options: Parameters<typeof createRuntimeModelRuntime>[1],
): RuntimeModelRuntime {
  return createRuntimeModelRuntime(settings, {
    env: {},
    sleep: async () => undefined,
    ...options,
  });
}

describe('Runtime 模型凭据 · keychain', () => {
  it('macOS：通过 security 读取 service/account，密钥只进入 Authorization', async () => {
    const fake = authorizedFetch();
    const invocations: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
    const exec: RuntimeKeychainExec = async (file, args, options) => {
      invocations.push({ file, args, timeoutMs: options.timeoutMs });
      return { stdout: `${SECRET}\n` };
    };
    const model = runtimeWith(
      apiSettings({ keyRef: 'keychain:mebular-runtime/cloud_abc' }),
      { platform: 'darwin', keychainExec: exec, fetch: fake.fetch },
    );

    const result = await model.extractCandidates(candidateRequest());
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${SECRET}`);
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations[0]).toEqual({
      file: 'security',
      args: ['find-generic-password', '-s', 'mebular-runtime', '-w', '-a', 'cloud_abc'],
      timeoutMs: 3000,
    });

    const probe = await model.probe();
    expect(probe.api.credential).toEqual({ configured: true, source: 'keychain' });
    expect(JSON.stringify({ result, probe })).not.toContain(SECRET);
  });

  it('非 macOS：结构化 unsupported，不执行命令、不发请求', async () => {
    const fake = authorizedFetch();
    let invoked = 0;
    const model = runtimeWith(
      apiSettings({ keyRef: 'keychain:mebular-runtime/cloud_abc' }),
      {
        platform: 'linux',
        keychainExec: async () => {
          invoked += 1;
          return { stdout: SECRET };
        },
        fetch: fake.fetch,
      },
    );

    const result = await model.extractCandidates(candidateRequest());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('credential_unsupported');
    expect(result.warnings).toEqual(expect.arrayContaining([
      'model_credential_unsupported',
      'model_unavailable',
    ]));
    expect(invoked).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('macOS 条目不存在 / 命令失败：区分 missing 与 unreadable，不泄漏 stderr', async () => {
    const missing = runtimeWith(
      apiSettings({ keyRef: 'keychain:mebular-runtime/cloud_abc' }),
      {
        platform: 'darwin',
        keychainExec: async () => {
          throw Object.assign(new Error('command failed'), { code: 44, stderr: 'item could not be found' });
        },
      },
    );
    const missingResult = await missing.extractCandidates(candidateRequest());
    expect(missingResult.reason).toBe('credential_missing');
    expect(missingResult.warnings).toContain('model_credential_missing');

    const unreadable = runtimeWith(
      apiSettings({ keyRef: 'keychain:mebular-runtime/cloud_abc' }),
      {
        platform: 'darwin',
        keychainExec: async () => {
          throw Object.assign(new Error(`keychain exploded with ${SECRET}`), { code: 1, stderr: SECRET });
        },
      },
    );
    const unreadableResult = await unreadable.extractCandidates(candidateRequest());
    expect(unreadableResult.reason).toBe('credential_unreadable');
    expect(unreadableResult.warnings).toContain('model_credential_unreadable');
    expect(JSON.stringify(unreadableResult)).not.toContain(SECRET);
  });

  it('非法 keychain 引用：不执行命令', async () => {
    const fake = authorizedFetch();
    let invoked = 0;
    const model = runtimeWith(
      apiSettings({ keyRef: 'keychain:-s evil' }),
      {
        platform: 'darwin',
        keychainExec: async () => {
          invoked += 1;
          return { stdout: SECRET };
        },
        fetch: fake.fetch,
      },
    );
    const result = await model.extractCandidates(candidateRequest());
    expect(result.reason).toBe('credential_invalid_ref');
    expect(result.warnings).toContain('model_credential_invalid_ref');
    expect(invoked).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('Runtime 模型凭据 · file:', () => {
  // Windows 的 chmod/st_mode 不能表达 ACL，权限拒绝用例只在 POSIX 跑。
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  async function writeKey(root: string, mode: number): Promise<string> {
    await mkdir(join(root, 'secrets'), { recursive: true });
    const path = join(root, 'secrets', 'runtime-model.key');
    await writeFile(path, `${SECRET}\n`, 'utf8');
    await chmod(path, mode);
    return path;
  }

  posixOnly('0600：读取成功，状态只显示 file 来源', async () => {
    const root = await tempDir();
    await writeKey(root, 0o600);
    const fake = authorizedFetch();
    const model = runtimeWith(
      apiSettings({ keyRef: 'file:secrets/runtime-model.key' }),
      { homeDir: root, platform: 'linux', fetch: fake.fetch },
    );

    const result = await model.extractCandidates(candidateRequest());
    expect(result.ok).toBe(true);
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${SECRET}`);
    const probe = await model.probe();
    expect(probe.api.credential).toEqual({ configured: true, source: 'file' });
    expect(JSON.stringify({ result, probe })).not.toContain(SECRET);
  });

  posixOnly('0644：POSIX 拒绝使用并给出结构化 warning，不发请求', async () => {
    const root = await tempDir();
    await writeKey(root, 0o644);
    const fake = authorizedFetch();
    const model = runtimeWith(
      apiSettings({ keyRef: 'file:secrets/runtime-model.key' }),
      { homeDir: root, platform: 'linux', fetch: fake.fetch },
    );

    const result = await model.extractCandidates(candidateRequest());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('credential_insecure_permissions');
    expect(result.warnings).toContain('model_credential_insecure_permissions');
    expect(fake.calls).toHaveLength(0);

    const probe = await model.probe();
    expect(probe.api.available).toBe(false);
    expect(probe.api.reason).toBe('credential_insecure_permissions');
    expect(probe.api.warnings).toContain('model_credential_insecure_permissions');
    expect(JSON.stringify({ result, probe })).not.toContain(SECRET);
  });

  it('Windows：ACL 无法用 st_mode 校验时降级为可读', async () => {
    const root = await tempDir();
    await writeKey(root, 0o644);
    const fake = authorizedFetch();
    const model = runtimeWith(
      apiSettings({ keyRef: 'file:secrets/runtime-model.key' }),
      { homeDir: root, platform: 'win32', fetch: fake.fetch },
    );

    const result = await model.extractCandidates(candidateRequest());
    expect(result.ok).toBe(true);
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('缺失 / 目录穿越：结构化失败，不读取越界文件', async () => {
    const root = await tempDir();
    const missingFetch = authorizedFetch();
    const missing = runtimeWith(
      apiSettings({ keyRef: 'file:secrets/missing.key' }),
      { homeDir: root, platform: 'linux', fetch: missingFetch.fetch },
    );
    const missingResult = await missing.extractCandidates(candidateRequest());
    expect(missingResult.reason).toBe('credential_missing');
    expect(missingFetch.calls).toHaveLength(0);

    const traversal = runtimeWith(
      apiSettings({ keyRef: 'file:../outside.key' }),
      { homeDir: root, platform: 'linux' },
    );
    const traversalResult = await traversal.extractCandidates(candidateRequest());
    expect(traversalResult.reason).toBe('credential_invalid_ref');
    expect(traversalResult.warnings).toContain('model_credential_invalid_ref');
  });

  posixOnly('无 keyRef：默认文件权限过宽时不被伪装成 missing', async () => {
    const root = await tempDir();
    await writeKey(root, 0o644);
    const model = runtimeWith(
      normalizeRuntimeSettings({
        model: {
          source: 'api',
          api: {
            baseUrl: 'https://api.example.test/v1',
            model: 'test-model',
            allowRemote: true,
            timeoutMs: 20,
          },
        },
      }).model,
      { homeDir: root, platform: 'linux' },
    );
    const result = await model.extractCandidates(candidateRequest());
    expect(result.reason).toBe('credential_insecure_permissions');
    expect(result.warnings).toContain('model_credential_insecure_permissions');
  });

  posixOnly('无 keyRef：按 env → 默认文件顺序回退', async () => {
    const root = await tempDir();
    await writeKey(root, 0o600);
    const fake = authorizedFetch();
    const model = runtimeWith(
      normalizeRuntimeSettings({
        model: {
          source: 'api',
          api: {
            baseUrl: 'https://api.example.test/v1',
            model: 'test-model',
            allowRemote: true,
            timeoutMs: 20,
          },
        },
      }).model,
      { homeDir: root, platform: 'linux', fetch: fake.fetch },
    );

    const result = await model.extractCandidates(candidateRequest());
    expect(result.ok).toBe(true);
    expect((await model.probe()).api.credential).toEqual({ configured: true, source: 'file' });
  });
});
