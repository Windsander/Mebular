// Shared process/HTTP helpers for the real DSH E2E scenarios.
//
// Kept separate from the scenario runner so create-world / daemon / DSH helpers
// and the runner use one implementation of spawn, wait, fetch, and tarball
// packing.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';

import { sleep } from './cdp.mjs';

export { sleep };

export function tail(text, max = 3000) {
  const value = String(text ?? '');
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

export function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

export function runCommand(label, command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* Already gone. */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ label, code: null, stdout, stderr: `${stderr}${error.message}`, timedOut, elapsedMs: Date.now() - started });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ label, code, signal, stdout, stderr, timedOut, elapsedMs: Date.now() - started });
    });
  });
}

export function spawnLogged(label, command, args, options = {}) {
  const handle = {
    label,
    command,
    args,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    stoppedAt: null,
  };
  handle.proc = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  handle.proc.stdout.on('data', (chunk) => { handle.stdout += chunk.toString(); });
  handle.proc.stderr.on('data', (chunk) => { handle.stderr += chunk.toString(); });
  handle.proc.once('exit', (code, signal) => {
    handle.exitCode = code;
    handle.signal = signal;
  });
  return handle;
}

export async function stopProcess(handle, { timeoutMs = 5000 } = {}) {
  if (!handle?.proc || handle.proc.exitCode !== null) return;
  try { handle.proc.kill('SIGTERM'); } catch { return; }
  const exited = await Promise.race([
    once(handle.proc, 'exit').then(() => true).catch(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
  if (exited) {
    handle.stoppedAt = Date.now();
    return;
  }
  try { handle.proc.kill('SIGKILL'); } catch { /* Already gone. */ }
  await Promise.race([
    once(handle.proc, 'exit').catch(() => undefined),
    sleep(2000),
  ]);
  handle.stoppedAt = Date.now();
}

export async function waitForValue(read, predicate, { timeoutMs = 30000, intervalMs = 150, describe = '条件' } = {}) {
  const started = Date.now();
  let last = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await read();
      if (predicate(last)) return { ok: true, value: last };
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  return { ok: false, value: last, error: lastError, describe };
}

export async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

export async function fetchRaw(url, timeoutMs = 5000) {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headers = Object.fromEntries(response.headers.entries());
  return {
    status: response.status,
    headers,
    text: await response.text().catch(() => ''),
  };
}

export async function waitForHttpOk(url, timeoutMs = 30000) {
  return waitForValue(
    async () => {
      // The printed DSH URL carries a one-time token; a cookie-less redirect
      // lands on 401. Accept the token entry (200) or its redirect (3xx).
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return response.status;
    },
    (status) => status >= 200 && status < 400,
    { timeoutMs, intervalMs: 200, describe: `HTTP ${url}` },
  );
}

export async function packPackage(directory, packDir, label) {
  const result = await runCommand(`npm pack ${label}`, 'npm', [
    'pack', directory,
    '--pack-destination', packDir,
    '--json',
  ], { timeoutMs: 120000 });
  if (result.code !== 0) throw new Error(`npm pack ${label} 失败：${tail(result.stderr, 1200)}`);
  let entries = null;
  try {
    entries = JSON.parse(result.stdout.trim());
  } catch {
    entries = null;
  }
  const file = Array.isArray(entries) && entries[0]?.filename
    ? join(packDir, entries[0].filename)
    : await (async () => {
      const files = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'));
      return files.length === 1 ? join(packDir, files[0]) : null;
    })();
  if (file === null || !existsSync(file)) throw new Error(`npm pack ${label} 未产出 tarball`);
  const info = await stat(file);
  return { path: file, size: info.size, filename: file.split('/').pop() };
}

export function countMatches(text, pattern) {
  return [...String(text ?? '').matchAll(pattern)].length;
}

export async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

export async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}
