// Public OpenChamber fleet runner plugin.
//
// Hermetic: every test uses a fake `client.session.*`, a temporary home and a
// real loopback socket. No real OpenChamber session, daemon or bridge is used.

import { afterEach, describe, expect, it } from '@jest/globals';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin, {
  DISCOVERY_HEARTBEAT_MS,
  DISCOVERY_STALE_MS,
  MAX_BODY_BYTES,
  MAX_PROMPT_BYTES,
  RUNNER_KIND,
  RUNNER_SCHEMA,
  claimDiscovery,
  createFleetRunnerDefinition,
  createFleetRunnerPlugin,
  createHostSessionClient,
  evaluateDiscovery,
  readDiscoveryFile,
  releaseDiscovery,
  resolveFleetRunnerConfig,
  startFleetRunner,
} from '../../packages/opencode-plugin/fleet-runner.js';

const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

async function tempDir(prefix = 'mebular-fleet-runner-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createFakeClient(options = {}) {
  const state = {
    creates: [],
    prompts: [],
    messages: [],
    aborts: [],
  };
  const client = {
    session: {
      async create(args) {
        state.creates.push(args);
        return { data: { id: `ses-${state.creates.length}` } };
      },
      async prompt(args) {
        state.prompts.push(args);
        if (options.prompt) return options.prompt(args, state);
        return { data: { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'FINAL_TEXT' }] } };
      },
      async messages(args) {
        state.messages.push(args);
        if (options.messages) return options.messages(args, state);
        return { data: [] };
      },
    },
  };
  if (options.withAbort !== false) {
    client.session.abort = async (args) => {
      state.aborts.push(args);
      return { data: true };
    };
  }
  return { client, state };
}

function createFakeHostSession() {
  const state = { creates: [], prompts: [], waits: [], contexts: [], interrupts: [] };
  const messages = [];
  const session = {
    async create(args) {
      state.creates.push(args);
      const id = `ses-host-${state.creates.length}`;
      messages.push([]);
      return { id, projectID: 'project-e2e', time: { created: 1, updated: 1 } };
    },
    async prompt(args) {
      state.prompts.push(args);
      const index = Number(args.sessionID.slice('ses-host-'.length)) - 1;
      messages[index].push({ type: 'user', text: args.text });
      messages[index].push({
        type: 'assistant',
        content: [{ type: 'text', text: `HOST:${args.text}` }],
      });
      return { id: `msg-${state.prompts.length}`, sessionID: args.sessionID, type: 'user' };
    },
    async wait(args) {
      state.waits.push(args);
      return null;
    },
    async context(args) {
      state.contexts.push(args);
      const index = Number(args.sessionID.slice('ses-host-'.length)) - 1;
      return messages[index] ?? [];
    },
    async interrupt(args) {
      state.interrupts.push(args);
      return { interrupted: true };
    },
  };
  return { session, state, messages };
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
    const headers = {};
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function start(config = {}, clientOptions = {}, runnerOptions = {}) {
  const directory = await tempDir();
  const discoveryFile = join(directory, 'home', 'openchamber-runner.json');
  const fake = createFakeClient(clientOptions);
  const handle = await startFleetRunner({
    client: fake.client,
    config: { enabled: true, discoveryFile, requestTimeoutMs: 1_000, ...config },
    ...runnerOptions,
  });
  return { directory, discoveryFile, fake, handle };
}

describe('resolveFleetRunnerConfig', () => {
  it('默认关闭，必须 fleetRunner.enabled === true', async () => {
    const home = await tempDir();
    expect(resolveFleetRunnerConfig({}, { env: { MEBULAR_HOME: home } }).enabled).toBe(false);
    expect(resolveFleetRunnerConfig({ fleetRunner: { enabled: false } }, { homeDir: home }).enabled).toBe(false);
    expect(resolveFleetRunnerConfig({ fleetRunner: { enabled: true } }, { homeDir: home }).enabled).toBe(true);
    expect(resolveFleetRunnerConfig({ enabled: true }, { homeDir: home }).enabled).toBe(true);
  });

  it('从 $MEBULAR_HOME/opencode-plugin.json 的 fleetRunner 段读取，默认值正确', async () => {
    const home = await tempDir();
    await writeFile(
      join(home, 'opencode-plugin.json'),
      JSON.stringify({ memoryRuntime: { enabled: true }, fleetRunner: { enabled: true, port: 1234 } }),
    );
    const config = resolveFleetRunnerConfig({}, { env: { MEBULAR_HOME: home } });
    expect(config).toMatchObject({
      enabled: true,
      port: 1234,
      host: '127.0.0.1',
      requestTimeoutMs: 600_000,
      discoveryFile: join(home, 'openchamber-runner.json'),
    });
  });

  it('共享配置文件的顶层 enabled 不会误开 runner', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'opencode-plugin.json'), JSON.stringify({ enabled: true }));
    expect(resolveFleetRunnerConfig({}, { env: { MEBULAR_HOME: home } }).enabled).toBe(false);
  });
});

describe('fleet runner plugin', () => {
  it('默认关闭：不启动服务、不写 discovery', async () => {
    const home = await tempDir();
    const { client } = createFakeClient();
    const disabled = createFleetRunnerPlugin({ homeDir: home, env: {} });
    const hooks = await disabled({ client, directory: home });
    expect(hooks).toEqual({});
    expect(disabled.status()).toMatchObject({ enabled: false, running: false });
    await expect(stat(join(home, 'openchamber-runner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('启用后写 0600 discovery / 0700 目录，health 不含 token', async () => {
    const { directory, discoveryFile, fake, handle } = await start();
    try {
      const discovery = JSON.parse(await readFile(discoveryFile, 'utf8'));
      expect(discovery).toMatchObject({
        schema: RUNNER_SCHEMA,
        kind: RUNNER_KIND,
        pid: process.pid,
        port: handle.port,
        token: handle.token,
      });
      expect(typeof discovery.version).toBe('string');
      expect(typeof discovery.startedAt).toBe('number');
      expect(typeof discovery.updatedAt).toBe('number');
      expect((await stat(discoveryFile)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, 'home'))).mode & 0o777).toBe(0o700);

      const health = await request(handle.port, '/health');
      expect(health.status).toBe(200);
      expect(health.json).toMatchObject({ ok: true, pid: process.pid });
      expect(Object.keys(health.json).sort()).toEqual(['ok', 'pid', 'startedAt', 'version']);
      expect(health.text).not.toContain(handle.token);
      expect(fake.state.creates).toHaveLength(0);
    } finally {
      await handle.dispose();
    }
  });

  it('成功：每次新建 session、prompt 参数正确、返回最终 assistant 文本', async () => {
    const { fake, handle } = await start();
    try {
      const first = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'do task', title: 'fleet task-1', agent: 'build', model: 'provider/model' },
      });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({
        ok: true,
        result: { sessionId: 'ses-1', text: 'FINAL_TEXT' },
      });
      expect(typeof first.json.result.ms).toBe('number');
      expect(first.text).not.toContain(handle.token);
      expect(fake.state.creates).toEqual([{ body: { title: 'fleet task-1' } }]);
      expect(fake.state.prompts[0]).toEqual({
        path: { id: 'ses-1' },
        body: {
          parts: [{ type: 'text', text: 'do task' }],
          agent: 'build',
          model: { providerID: 'provider', modelID: 'model' },
        },
      });

      const second = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'again' },
      });
      expect(second.status).toBe(200);
      expect(second.json.result.sessionId).toBe('ses-2');
      expect(fake.state.creates).toHaveLength(2);
      expect(fake.state.prompts[1].body).toEqual({ parts: [{ type: 'text', text: 'again' }] });
    } finally {
      await handle.dispose();
    }
  });

  it('prompt 无文本时回退 session.messages 的最后一条 assistant', async () => {
    const { fake, handle } = await start({}, {
      prompt: async () => ({ data: { info: { role: 'assistant' }, parts: [] } }),
      messages: async () => ({
        data: [
          { info: { role: 'user' }, parts: [{ type: 'text', text: 'question' }] },
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'FALLBACK' }] },
        ],
      }),
    });
    try {
      const response = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'x' },
      });
      expect(response.status).toBe(200);
      expect(response.json.result.text).toBe('FALLBACK');
      expect(fake.state.messages).toHaveLength(1);
    } finally {
      await handle.dispose();
    }
  });

  it('401：缺少/wrong token 拒绝，且不创建 session', async () => {
    const { fake, handle } = await start();
    try {
      const missing = await request(handle.port, '/v1/run-once', { method: 'POST', body: { prompt: 'x' } });
      expect(missing.status).toBe(401);
      expect(missing.json).toMatchObject({ ok: false, error: 'UNAUTHORIZED' });
      const wrong = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: 'wrong',
        body: { prompt: 'x' },
      });
      expect(wrong.status).toBe(401);
      expect(fake.state.creates).toHaveLength(0);
    } finally {
      await handle.dispose();
    }
  });

  it('拒绝 sessionId（new session only）', async () => {
    const { fake, handle } = await start();
    try {
      const response = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'x', sessionId: 'ses-existing' },
      });
      expect(response.status).toBe(400);
      expect(response.json.error).toBe('BAD_REQUEST');
      expect(response.json.message).toMatch(/new session only/i);
      expect(fake.state.creates).toHaveLength(0);
    } finally {
      await handle.dispose();
    }
  });

  it('上限：body/prompt 413、timeoutSec 400、非 JSON 400', async () => {
    const { fake, handle } = await start();
    try {
      const bigBody = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'a'.repeat(MAX_BODY_BYTES + 10) },
      });
      expect(bigBody.status).toBe(413);

      const bigPrompt = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'b'.repeat(MAX_PROMPT_BYTES + 1) },
      });
      expect(bigPrompt.status).toBe(413);

      const bigTimeout = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'x', timeoutSec: 601 },
      });
      expect(bigTimeout.status).toBe(400);

      const badJson = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: '{',
      });
      expect(badJson.status).toBe(400);
      expect(fake.state.creates).toHaveLength(0);
    } finally {
      await handle.dispose();
    }
  });

  it('超时：abort 被调用，响应稳定 TIMEOUT 且有界', async () => {
    const { fake, handle } = await start({ requestTimeoutMs: 150 }, {
      prompt: async () => new Promise(() => {}),
    });
    const startedAt = Date.now();
    try {
      const response = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'slow' },
      });
      expect(response.status).toBe(504);
      expect(response.json).toMatchObject({ ok: false, error: 'TIMEOUT' });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(fake.state.aborts).toEqual([{ path: { id: 'ses-1' } }]);
    } finally {
      await handle.dispose();
    }
  });

  it('超时：host 没有 abort API 时也必须有界退出', async () => {
    const { handle } = await start({ requestTimeoutMs: 120 }, {
      withAbort: false,
      prompt: async () => new Promise(() => {}),
    });
    const startedAt = Date.now();
    try {
      const response = await request(handle.port, '/v1/run-once', {
        method: 'POST',
        token: handle.token,
        body: { prompt: 'slow' },
      });
      expect(response.status).toBe(504);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await handle.dispose();
    }
  });

  it('dispose：关闭服务并只删除自己的 discovery', async () => {
    const { discoveryFile, handle } = await start();
    await handle.dispose();
    await expect(stat(discoveryFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(request(handle.port, '/health')).rejects.toBeTruthy();

    const owner = { token: 'owner-token', pid: process.pid };
    await mkdir(join(discoveryFile, '..'), { recursive: true });
    await writeFile(discoveryFile, JSON.stringify(owner));
    expect(releaseDiscovery(discoveryFile, { token: 'other', pid: process.pid })).toBe(false);
    expect((await stat(discoveryFile)).isFile()).toBe(true);
    expect(releaseDiscovery(discoveryFile, owner)).toBe(true);
  });

  it('多实例：live pid 不抢，dead pid 才替换', async () => {
    const { discoveryFile, handle } = await start();
    try {
      const { client } = createFakeClient();
      await expect(
        startFleetRunner({
          client,
          config: { enabled: true, discoveryFile, requestTimeoutMs: 1_000 },
        }),
      ).rejects.toMatchObject({ code: 'FLEET_RUNNER_ALREADY_RUNNING' });
      expect(readDiscoveryFile(discoveryFile).token).toBe(handle.token);
    } finally {
      await handle.dispose();
    }

    const stale = {
      schema: RUNNER_SCHEMA,
      kind: RUNNER_KIND,
      pid: 999_999,
      port: 1,
      token: 'dead',
      version: '0.0.0',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    };
    await writeFile(discoveryFile, JSON.stringify(stale));
    expect(evaluateDiscovery(stale, { now: Date.now() }).claimable).toBe(true);
    expect(claimDiscovery(discoveryFile, { ...stale, token: 'new' }).ok).toBe(true);
    expect(readDiscoveryFile(discoveryFile).token).toBe('new');
  });

  it('配置启用后由插件 wrapper 启动/释放，定时器可清理', async () => {
    const directory = await tempDir();
    const configFile = join(directory, 'opencode-plugin.json');
    await writeFile(configFile, JSON.stringify({ fleetRunner: { enabled: true, requestTimeoutMs: 500 } }));
    const { client } = createFakeClient();
    const enabled = createFleetRunnerPlugin({ homeDir: directory, configFile, env: {} });
    const hooks = await enabled({ client, directory });
    try {
      expect(enabled.status()).toMatchObject({ enabled: true, running: true });
      expect(DISCOVERY_HEARTBEAT_MS).toBeGreaterThan(0);
      expect(DISCOVERY_STALE_MS).toBeGreaterThan(DISCOVERY_HEARTBEAT_MS);
      expect(typeof hooks.dispose).toBe('function');
      expect((await request(enabled.status().port, '/health')).status).toBe(200);
    } finally {
      await hooks.dispose?.();
    }
    expect(enabled.status()).toMatchObject({ running: false, reason: 'disposed' });
    await expect(stat(join(directory, 'openchamber-runner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('默认导出是 OpenCode V2 定义对象（id + setup），未配置时不启动', async () => {
    const directory = await tempDir();
    const { client } = createFakeClient();
    const previous = process.env.MEBULAR_HOME;
    process.env.MEBULAR_HOME = directory;
    try {
      expect(plugin.id).toBe('mebular-fleet-runner');
      expect(typeof plugin.setup).toBe('function');
      const hooks = await plugin.setup({ client, directory, options: {} });
      expect(hooks).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.MEBULAR_HOME;
      else process.env.MEBULAR_HOME = previous;
    }
  });

  it('host ctx.session 适配：新建 session、等待 idle、返回 assistant 文本', async () => {
    const directory = await tempDir();
    const discoveryFile = join(directory, 'openchamber-runner.json');
    const host = createFakeHostSession();
    const definition = createFleetRunnerDefinition({ homeDir: directory, env: {} });
    const cleanup = await definition.setup({
      session: host.session,
      location: { directory },
      options: { enabled: true, discoveryFile, requestTimeoutMs: 1_000 },
    });
    try {
      const response = await request(
        JSON.parse(await readFile(discoveryFile, 'utf8')).port,
        '/v1/run-once',
        {
          method: 'POST',
          token: JSON.parse(await readFile(discoveryFile, 'utf8')).token,
          body: { prompt: 'do host task', title: 'fleet host task' },
        },
      );
      expect(response.status).toBe(200);
      expect(response.json.result).toMatchObject({
        sessionId: 'ses-host-1',
        text: 'HOST:do host task',
      });
      expect(host.state.creates).toEqual([{ body: { title: 'fleet host task' } }]);
      expect(host.state.prompts).toEqual([{ sessionID: 'ses-host-1', text: 'do host task' }]);
      expect(host.state.waits).toEqual([{ sessionID: 'ses-host-1' }]);
      expect(host.state.contexts).toEqual([{ sessionID: 'ses-host-1' }]);
    } finally {
      await cleanup();
    }
    await expect(stat(join(directory, 'openchamber-runner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('createHostSessionClient 对非 host ctx 返回 null', () => {
    expect(createHostSessionClient({ client: {} })).toBeNull();
    expect(createHostSessionClient({ session: {} })).toBeNull();
  });

  it('discovery 心跳更新 updatedAt，且不改变 token', async () => {
    const { discoveryFile, handle } = await start({}, {}, { heartbeatMs: 50 });
    try {
      const before = readDiscoveryFile(discoveryFile);
      await chmod(discoveryFile, 0o600);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = readDiscoveryFile(discoveryFile);
      expect(after.token).toBe(before.token);
      expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    } finally {
      await handle.dispose();
    }
  });
});
