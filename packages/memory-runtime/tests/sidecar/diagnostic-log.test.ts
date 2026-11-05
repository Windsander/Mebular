import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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
      optPath: '/opt/mebular/private/model.gguf',
      rootPath: '/root/.mebular/store.jsonl',
      windowsPath: 'C:\\Users\\real-user\\AppData\\Local\\Mebular',
      windowsForward: 'C:/Users/real-user/AppData/Local/Mebular',
      nested: { apiKey: secret, text: bodySentinel, safe: 'ok' },
    });
    const text = JSON.stringify(await log.readRecent(10));
    expect(text).not.toContain(secret);
    expect(text).not.toContain(bodySentinel);
    expect(text).not.toContain('/Users/real-user');
    expect(text).not.toContain('/opt/mebular');
    expect(text).not.toContain('/root/.mebular');
    expect(text).not.toContain('C:\\\\Users');
    expect(text).not.toContain('C:/Users');
    expect(text).not.toContain('Bearer ');
    expect(text).toContain('[redacted]');
    expect(text).toContain('[omitted]');
    expect(text).toContain('[path]');
    expect(text).toContain('"code":"timeout"');
  });

  it('读取 legacy 行时二次脱敏，日志/目录权限为 0600/0700', async () => {
    const { home, log } = await setup();
    const file = join(home, 'logs', 'runtime.jsonl');
    await log.append('info', 'runtime_start', { reason: 'test' });
    const fileMode = (await stat(file)).mode & 0o777;
    const dirMode = (await stat(join(home, 'logs'))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);

    const legacySecret = 'sk-legacy-SECRET_1234567890';
    await appendFile(file, `${JSON.stringify({
      ts: 9_999,
      level: 'error',
      event: 'legacy_event',
      token: legacySecret,
      home: '/opt/legacy/home',
      root: '/root/legacy',
      win: 'C:\\Users\\legacy\\AppData',
      message: 'RAW_LEGACY_BODY',
    })}\n`);
    const text = JSON.stringify(await log.readRecent(10));
    expect(text).not.toContain(legacySecret);
    expect(text).not.toContain('/opt/legacy');
    expect(text).not.toContain('/root/legacy');
    expect(text).not.toContain('C:\\\\Users');
    expect(text).not.toContain('RAW_LEGACY_BODY');
    expect(text).toContain('[path]');
    expect(text).toContain('[redacted]');
  });
});
