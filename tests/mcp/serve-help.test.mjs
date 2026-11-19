// D6: `mebular serve --help` / `-h` must short-circuit before config load, heartbeat
// and store-lock acquisition:
//   - exit 0 and print the dedicated serve usage block (including MEBULAR_HOME);
//   - never print SERVE_READY/PROVISION_READY;
//   - never hit MCP_STORAGE_LOCKED, even when a live daemon lock already exists;
//   - leave the (temporary) MEBULAR_HOME untouched: no store/lock/heartbeat writes.

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages/mcp/bin/mebular.mjs');
const tempDirs = [];

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'mebular-serve-help-'));
  tempDirs.push(home);
  return home;
}

function invokeServe(home, args) {
  const env = { ...process.env, MEBULAR_HOME: home };
  delete env.MEBULAR_STORAGE_PATH;
  delete env.MEBULAR_TOKENS_FILE;
  return spawnSync(process.execPath, [CLI, 'serve', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function expectServeUsage(result) {
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('用法：mebular serve');
  expect(result.stdout).toContain('MEBULAR_HOME=<dir>');
  for (const flag of ['--host', '--port', '--auth', '--tls-key', '--tls-cert', '--tokens-file', '--help']) {
    expect(result.stdout).toContain(flag);
  }
  expect(result.stdout).not.toContain('SERVE_READY');
  expect(result.stdout).not.toContain('PROVISION_READY');
  expect(result.stdout).not.toContain('MCP_STORAGE_LOCKED');
  expect(result.stderr).not.toContain('MCP_STORAGE_LOCKED');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('mebular serve help (D6)', () => {
  it('serve --help exits 0 with serve usage and writes nothing to MEBULAR_HOME', async () => {
    const home = await makeHome();

    const result = invokeServe(home, ['--help']);

    expectServeUsage(result);
    // No store lock, heartbeat, config or provision artifacts.
    expect(await readdir(home)).toEqual([]);
    expect(existsSync(join(home, 'lock'))).toBe(false);
    expect(existsSync(join(home, 'service.heartbeat'))).toBe(false);
    expect(existsSync(join(home, 'store.jsonl'))).toBe(false);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('serve -h behaves like --help', async () => {
    const home = await makeHome();

    const result = invokeServe(home, ['-h']);

    expectServeUsage(result);
    expect(await readdir(home)).toEqual([]);
  });

  it('serve --help is not blocked by a live daemon lock and does not write heartbeat/store', async () => {
    const home = await makeHome();
    const lockPath = join(home, 'lock');
    // The spawned CLI sees this PID alive (it is this jest worker), so a normal
    // `serve` start would fail fast with MCP_STORAGE_LOCKED after writing heartbeat.
    const lockBody = JSON.stringify({ pid: process.pid, at: Date.now() });
    await writeFile(lockPath, lockBody, 'utf-8');

    const result = invokeServe(home, ['--port', '7331', '--help']);

    expectServeUsage(result);
    expect(await readFile(lockPath, 'utf-8')).toBe(lockBody);
    expect(await readdir(home)).toEqual(['lock']);
    expect(existsSync(join(home, 'service.heartbeat'))).toBe(false);
    expect(existsSync(join(home, 'store.jsonl'))).toBe(false);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });
});
