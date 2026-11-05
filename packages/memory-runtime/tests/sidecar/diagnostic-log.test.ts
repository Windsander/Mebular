import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticLog } from '../../src/sidecar/diagnostic-log.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(options: { maxBytes?: number; maxFiles?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'mebular-diagnostic-log-'));
  dirs.push(home);
  let clock = 1_000;
  const log = new DiagnosticLog({
    dir: join(home, 'logs'),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    now: () => clock++,
  });
  await log.init();
  return { home, log };
}

describe('DiagnosticLog', () => {
  it('有界轮转且读取最近事件', async () => {
    const { home, log } = await setup({ maxBytes: 420, maxFiles: 3 });
    for (let index = 0; index < 80; index += 1) {
      await log.append(index % 10 === 0 ? 'error' : 'info', 'outbox_replay_error', {
        code: index % 10 === 0 ? 'timeout' : 'retry',
        attempt: index,
        detail: 'x'.repeat(80),
      });
    }
    const files = (await readdir(join(home, 'logs'))).filter((name) => name.startsWith('runtime.jsonl'));
    expect(files.length).toBeLessThanOrEqual(3);
    const stats = await log.stats();
    expect(stats.files).toBe(files.length);
    expect(stats.bytes).toBeLessThanOrEqual(420 * 3 + 200);
    const recent = await log.readRecent(5);
    expect(recent).toHaveLength(5);
    expect(recent[recent.length - 1]!.attempt).toBe(79);
    expect(recent.every((entry) => typeof entry.ts === 'number')).toBe(true);
  });

  it('脱敏 token/正文/真实 home 与路径', async () => {
    const { log } = await setup();
    const secret = 'sk-live-SECRET_SENTINEL_1234567890';
    const bodySentinel = 'RAW_BODY_SENTINEL';
    const homeSentinel = '/Users/real-user/private/memory-runtime';
    await log.append('error', 'capability_probe', {
      code: 'timeout',
      token: secret,
      authorization: `Bearer ${secret}`,
      body: { text: bodySentinel },
      prompt: bodySentinel,
      content: bodySentinel,
      message: bodySentinel,
      location: `failed under ${homeSentinel}`,
      nested: { apiKey: secret, text: bodySentinel, safe: 'ok' },
    });
    const text = JSON.stringify(await log.readRecent(10));
    expect(text).not.toContain(secret);
    expect(text).not.toContain(bodySentinel);
    expect(text).not.toContain('/Users/real-user');
    expect(text).not.toContain('Bearer ');
    expect(text).toContain('[redacted]');
    expect(text).toContain('[omitted]');
    expect(text).toContain('[path]');
    expect(text).toContain('"code":"timeout"');
  });
});
