// W4 outcome binding：签发/校验/过期/轮换/tamper/跨域/note 新旧协议/通道边界。
// 只启动 fake capability + sidecar HTTP；不读宿主私有存储。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig } from '../../src/sidecar/config.js';
import { DiagnosticLog } from '../../src/sidecar/diagnostic-log.js';
import { defaultSidecarPolicy } from '../../src/sidecar/domains.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import {
  issueOutcomeBinding,
  verifyOutcomeBinding,
} from '../../src/sidecar/outcome-token.js';
import { SidecarServer } from '../../src/sidecar/server.js';
import { SettlementRuntime } from '../../src/sidecar/settlement.js';
import { startFakeCapability, type FakeCapabilityServer, type FakeMemoryRecord } from './fake-capability.js';

const NOW = 1_760_000_000_000;
const HOST_TOKEN = 'host-token';
const ADMIN_TOKEN = 'admin-secret';

interface Harness {
  home: string;
  fake: FakeCapabilityServer;
  runtime: SettlementRuntime;
  server: SidecarServer;
  diagnostics: DiagnosticLog;
}

const harnesses: Harness[] = [];

function preference(): FakeMemoryRecord {
  return {
    id: '01JW4PREF1',
    type: 'fact',
    kind: 'preference',
    domain: 'user',
    namespace: 'user',
    ownerType: 'user',
    ownerId: 'u_test',
    content: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.92 },
    text: '用户偏好：theme=dark',
    tags: ['preference'],
    provenance: {
      source: 'runtime',
      writerType: 'agent',
      writerId: 'opencode',
      extractor: 'host',
      model: 'host-provided',
      version: '0.3.0',
      deviceId: 'device-local',
      hostId: 'h_test',
      threadId: 'th_w4',
      agentId: 'opencode',
      agentName: 'OpenCode',
      confirmation: 'explicit',
      at: NOW - 86_400_000,
    },
    validFrom: NOW - 86_400_000,
    validTo: null,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    detailAvailable: true,
    legacy: false,
    score: 0.9,
  };
}

async function setup(options: {
  now?: () => number;
  trace?: 'off' | 'local';
} = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-w4-outcome-'));
  const now = options.now ?? (() => NOW);
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now });
  await local.init();
  const fake = await startFakeCapability({ now });
  fake.setRecords([preference()]);
  const client = new CapabilityClient({
    baseUrl: fake.baseUrl,
    token: 'cap-token',
    retries: 0,
    retryDelayMs: 0,
  });
  const identity = { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' };
  const config = defaultSidecarConfig();
  config.http.port = 0;
  config.model.source = 'heuristic';
  config.intervention = { ...config.intervention, mode: 'heuristic', legacyModePresent: true };
  if (options.trace) config.trace = options.trace;
  const diagnostics = new DiagnosticLog({ dir: join(home, 'memory-runtime', 'logs'), now });
  await diagnostics.init();
  const runtime = new SettlementRuntime({
    config,
    local,
    client,
    identity,
    policy: defaultSidecarPolicy(),
    policyStatePath: join(home, 'memory-runtime', 'policy', 'state.json'),
    diagnostics,
    autoStartReplayer: false,
    now,
  });
  await runtime.init();
  const server = new SidecarServer({
    config,
    hostToken: HOST_TOKEN,
    adminToken: ADMIN_TOKEN,
    identity,
    ingest: runtime,
    namespaces: runtime,
    recall: runtime,
    objects: runtime,
    intervention: runtime,
    getDegraded: () => runtime.degraded,
    now,
  });
  await server.listen();
  const harness = { home, fake, runtime, server, diagnostics };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.runtime.stop();
    await harness.server.close();
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${HOST_TOKEN}` };
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function context(
  harness: Harness,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = { 'x-mebular-host-app': 'opencode' },
): Promise<{ traceId: string; bindingToken: string }> {
  const result = await post(`${harness.server.url}/context`, {
    agentId: 'opencode',
    threadId: 'th_w4',
    turnId: 'turn_w4',
    query: '我的偏好是什么？',
    ...overrides,
  }, headers);
  expect(result.status).toBe(200);
  return {
    traceId: result.body.data.traceId as string,
    bindingToken: result.body.data.bindingToken as string,
  };
}

describe('outcome binding token（unit）', () => {
  const scope = {
    traceId: 'tr_0123456789',
    agentId: 'opencode',
    threadId: 'th_w4',
    turnId: 'turn_w4',
    hostApp: 'opencode' as const,
  };

  it('签发/校验 round-trip，TTL 精确到 outcomeWindowMs', () => {
    const token = issueOutcomeBinding({ scope, hostToken: HOST_TOKEN, now: NOW, windowMs: 120_000 });
    expect(token).toMatch(/^obt_/);
    const verified = verifyOutcomeBinding(token!, HOST_TOKEN, NOW + 1);
    expect(verified).toMatchObject({ ok: true, expiresAt: NOW + 120_000, scope });
    // token 只编码 ID/exp，不含 query/note/正文。
    const segment = token!.slice('obt_'.length).split('.')[0]!;
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['a', 'e', 'h', 't', 'th', 'tu', 'v']);
    expect(JSON.stringify(payload)).not.toContain('我的偏好');
  });

  it('过期 / host token 轮换 / tamper 一律拒绝', () => {
    const token = issueOutcomeBinding({ scope, hostToken: HOST_TOKEN, now: NOW, windowMs: 1000 })!;
    expect(verifyOutcomeBinding(token, HOST_TOKEN, NOW + 1000 + 1)).toEqual({
      ok: false,
      code: 'outcome_binding_expired',
    });
    expect(verifyOutcomeBinding(token, 'rotated-host-token', NOW + 1)).toEqual({
      ok: false,
      code: 'outcome_binding_invalid',
    });
    const [prefix, signature] = token.split('.') as [string, string];
    const tamperedPayload = `${prefix.slice(0, -2)}AA.${signature}`;
    expect(verifyOutcomeBinding(tamperedPayload, HOST_TOKEN, NOW + 1)).toEqual({
      ok: false,
      code: 'outcome_binding_invalid',
    });
    expect(verifyOutcomeBinding(`${prefix}.${signature.slice(0, -2)}AA`, HOST_TOKEN, NOW + 1)).toEqual({
      ok: false,
      code: 'outcome_binding_invalid',
    });
  });

  it('traceId null / 空 key / 非正 TTL fail closed：不签发', () => {
    expect(issueOutcomeBinding({ scope, hostToken: '', now: NOW, windowMs: 1000 })).toBeNull();
    expect(issueOutcomeBinding({ scope, hostToken: HOST_TOKEN, now: NOW, windowMs: 0 })).toBeNull();
    expect(issueOutcomeBinding({
      scope: { ...scope, traceId: '' },
      hostToken: HOST_TOKEN,
      now: NOW,
      windowMs: 1000,
    })).toBeNull();
  });
});

describe('outcome binding over HTTP', () => {
  it('/context 签发 token；trace 记录 turnId/hostApp 且不落 token', async () => {
    const harness = await setup();
    const { traceId, bindingToken } = await context(harness);
    expect(bindingToken).toMatch(/^obt_/);
    const trace = await fetch(`${harness.server.url}/traces/${traceId}`, { headers: auth() });
    const body = await trace.json() as any;
    expect(body.data.turnId).toBe('turn_w4');
    expect(body.data.hostApp).toBe('opencode');
    expect(JSON.stringify(body)).not.toContain(bindingToken);
  });

  it('source=host 必须带 token/host；token 与 URL trace 必须一致', async () => {
    const harness = await setup();
    const a = await context(harness);
    const b = await context(harness, { turnId: 'turn_w4_b', threadId: 'th_w4_b' });

    const missingToken = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'host', host: 'opencode',
    });
    expect(missingToken.status).toBe(400);
    expect(missingToken.body.error.code).toBe('outcome_binding_required');

    const missingHost = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'host', bindingToken: a.bindingToken,
    });
    expect(missingHost.status).toBe(400);
    expect(missingHost.body.error.code).toBe('outcome_host_invalid');

    const invalidHost = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'host', host: 'cursor', bindingToken: a.bindingToken,
    });
    expect(invalidHost.status).toBe(400);
    expect(invalidHost.body.error.code).toBe('outcome_host_invalid');

    const crossTrace = await post(`${harness.server.url}/recall/${b.traceId}/outcome`, {
      kind: 'accepted', source: 'host', host: 'opencode', bindingToken: a.bindingToken,
    });
    expect(crossTrace.status).toBe(400);
    expect(crossTrace.body.error.code).toBe('outcome_scope_mismatch');
  });

  it('跨 agent/session/thread/turn/host 一律拒绝', async () => {
    const harness = await setup();
    const a = await context(harness);
    const cases: Array<Record<string, unknown>> = [
      { agentId: 'other-agent' },
      { sessionId: 'th_other' },
      { threadId: 'th_other' },
      { turnId: 'turn_other' },
    ];
    for (const extra of cases) {
      const result = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
        kind: 'accepted',
        source: 'host',
        host: 'opencode',
        bindingToken: a.bindingToken,
        ...extra,
      });
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('outcome_scope_mismatch');
    }
    const hostMismatch = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'host', host: 'dsh', bindingToken: a.bindingToken,
    });
    expect(hostMismatch.status).toBe(400);
    expect(hostMismatch.body.error.code).toBe('outcome_scope_mismatch');
  });

  it('tamper / 过期 token 拒绝，且不写 trace', async () => {
    let now = NOW;
    const harness = await setup({ now: () => now });
    const a = await context(harness);
    const tampered = `${a.bindingToken.slice(0, -2)}AA`;
    const bad = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'host', host: 'opencode', bindingToken: tampered,
    });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('outcome_binding_invalid');

    now = NOW + 120_001;
    const expired = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'host', host: 'opencode', bindingToken: a.bindingToken,
    });
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('outcome_binding_expired');
    const trace = await fetch(`${harness.server.url}/traces/${a.traceId}`, { headers: auth() });
    const body = await trace.json() as any;
    expect(body.data.outcome ?? null).toBeNull();
  });

  it('note：新协议 400，旧 0.3 客户端接受但忽略且不落盘', async () => {
    const harness = await setup();
    const a = await context(harness);
    const rejected = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted',
      source: 'host',
      host: 'opencode',
      bindingToken: a.bindingToken,
      note: 'raw follow-up text must never be stored',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('outcome_note_unsupported');

    const legacy = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted',
      source: 'host',
      note: 'raw follow-up text must never be stored',
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body.data.warnings).toEqual(['outcome_note_ignored']);
    expect(legacy.body.data.recorded).toBe(false);

    const trace = await fetch(`${harness.server.url}/traces/${a.traceId}`, { headers: auth() });
    const body = await trace.json() as any;
    expect(body.data.outcome ?? null).toBeNull();
    expect(body.data.outcomeHistory ?? []).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('raw follow-up text');
  });

  it('source=console 只认独立 admin secret；host token 不能伪造；heuristic 仅内部', async () => {
    const harness = await setup();
    const a = await context(harness);

    const consoleDenied = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'dismissed', source: 'console',
    });
    expect(consoleDenied.status).toBe(403);
    expect(consoleDenied.body.error.code).toBe('outcome_source_invalid');

    // B1：host token 已在 Authorization；只加“admin”header、省略 host-app 仍拒绝。
    const forgedByHostToken = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'dismissed', source: 'console',
    }, { 'x-mebular-outcome-channel': 'admin', 'x-mebular-admin-token': HOST_TOKEN });
    expect(forgedByHostToken.status).toBe(403);
    expect(forgedByHostToken.body.error.code).toBe('outcome_source_invalid');

    const legacyHeaderOnly = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'dismissed', source: 'console',
    }, { 'x-mebular-outcome-channel': 'admin' });
    expect(legacyHeaderOnly.status).toBe(403);

    const wrongAdminSecret = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'dismissed', source: 'console',
    }, { 'x-mebular-admin-token': 'wrong-admin-secret' });
    expect(wrongAdminSecret.status).toBe(403);

    // 真正的 admin 代理：独立 secret 正确即可；host-app header 不是凭据。
    const consoleOk = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'dismissed', source: 'console',
    }, { 'x-mebular-admin-token': ADMIN_TOKEN, 'x-mebular-host-app': 'opencode' });
    expect(consoleOk.status).toBe(200);

    // 即使 admin secret 正确，console 也不接受 token/host 冒充 host 通道。
    const hostSelfConsole = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'console', host: 'opencode', bindingToken: a.bindingToken,
    }, { 'x-mebular-admin-token': ADMIN_TOKEN });
    expect(hostSelfConsole.status).toBe(403);

    const heuristicHttp = await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'heuristic',
    });
    expect(heuristicHttp.status).toBe(403);
    expect(heuristicHttp.body.error.code).toBe('outcome_source_invalid');

    const internal = await harness.runtime.recall.submitOutcome(a.traceId, {
      kind: 'accepted', source: 'heuristic',
    }, { internal: true });
    expect(internal.recorded).toBe(true);
  });

  it('adminToken 缺省或等于 host token 时 console 通道 fail closed', async () => {
    for (const adminToken of [undefined, HOST_TOKEN]) {
      const home = await mkdtemp(join(tmpdir(), 'mebular-w4-outcome-admin-'));
      const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
      await local.init();
      const fake = await startFakeCapability({ now: () => NOW });
      fake.setRecords([preference()]);
      const client = new CapabilityClient({
        baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0,
      });
      const identity = { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' };
      const config = defaultSidecarConfig();
      config.http.port = 0;
      config.model.source = 'heuristic';
      config.intervention = { ...config.intervention, mode: 'heuristic', legacyModePresent: true };
      const runtime = new SettlementRuntime({
        config, local, client, identity, policy: defaultSidecarPolicy(),
        policyStatePath: join(home, 'memory-runtime', 'policy', 'state.json'),
        autoStartReplayer: false, now: () => NOW,
      });
      await runtime.init();
      const server = new SidecarServer({
        config,
        hostToken: HOST_TOKEN,
        ...(adminToken ? { adminToken } : {}),
        identity,
        ingest: runtime,
        namespaces: runtime,
        recall: runtime,
        objects: runtime,
        intervention: runtime,
        getDegraded: () => runtime.degraded,
        now: () => NOW,
      });
      await server.listen();
      try {
        const ctx = await post(`${server.url}/context`, {
          agentId: 'opencode', threadId: 'th_w4', turnId: 'turn_w4', query: '我的偏好是什么？',
        }, { 'x-mebular-host-app': 'opencode' });
        const denied = await post(`${server.url}/recall/${ctx.body.data.traceId}/outcome`, {
          kind: 'dismissed', source: 'console',
        }, { 'x-mebular-admin-token': HOST_TOKEN });
        expect(denied.status).toBe(403);
      } finally {
        await runtime.stop();
        await server.close();
        await fake.close();
        await rm(home, { recursive: true, force: true });
      }
    }
  });

  it('traceId null 不签发 token；宿主无法合法上报', async () => {
    const harness = await setup({ trace: 'off' });
    const a = await context(harness);
    expect(a.traceId).toBeNull();
    expect(a.bindingToken).toBeNull();
    const hostOutcome = await post(`${harness.server.url}/recall/tr_off_w4/outcome`, {
      kind: 'missed', source: 'host', host: 'opencode',
    });
    expect(hostOutcome.status).toBe(400);
    expect(hostOutcome.body.error.code).toBe('outcome_binding_required');
  });

  it('token/host token/keyRef/raw note 不进入 diagnostics / trace', async () => {
    const harness = await setup();
    const a = await context(harness);
    await post(`${harness.server.url}/recall/${a.traceId}/outcome`, {
      kind: 'accepted', source: 'host', host: 'opencode', bindingToken: a.bindingToken,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const log = await readFile(harness.diagnostics.currentPath, 'utf8').catch(() => '');
    expect(log).not.toContain(a.bindingToken);
    expect(log).not.toContain(HOST_TOKEN);
    expect(log).not.toMatch(/keyRef|authorization|我的偏好/iu);
    const trace = await fetch(`${harness.server.url}/traces/${a.traceId}`, { headers: auth() });
    const body = await trace.json() as any;
    expect(JSON.stringify(body)).not.toContain(a.bindingToken);
    expect(JSON.stringify(body)).not.toContain(HOST_TOKEN);
  });
});
