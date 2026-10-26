// Minimal zero-dependency Chrome/CDP helper for the real DSH E2E harness.
//
// This is intentionally a subset of packages/console/scripts/verify-console-ui.mjs:
// launch a system Chrome/Chromium (or an already-cached Chrome for Testing),
// connect over the DevTools WebSocket, and give the caller a small page façade
// (eval, waitFor, screenshot, frame evaluation).
//
// The existing console UI script keeps its inline copy; this module is only
// used by scripts/verify-dsh-e2e.mjs so a flaky DSH/Chrome combination never
// changes the console smoke behavior.

/* global WebSocket */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function playwrightCacheDirs() {
  const dirs = [];
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (typeof explicit === 'string' && explicit.length > 0 && explicit !== '0') dirs.push(explicit);
  const home = homedir();
  dirs.push(join(home, 'Library', 'Caches', 'ms-playwright'));
  dirs.push(join(home, '.cache', 'ms-playwright'));
  return dirs.filter((dir) => existsSync(dir));
}

function versionedDirs(root, prefix) {
  try {
    return readdirSync(root)
      .filter((name) => name.startsWith(`${prefix}-`))
      .sort((a, b) => {
        const na = Number.parseInt(a.slice(prefix.length + 1), 10);
        const nb = Number.parseInt(b.slice(prefix.length + 1), 10);
        return (Number.isFinite(nb) ? nb : 0) - (Number.isFinite(na) ? na : 0);
      })
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}

/** Chrome/Chromium binaries already present on this machine. */
export function findChrome(extraCandidates = []) {
  const candidates = [
    process.env.CHROME_PATH,
    ...extraCandidates,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ].filter(Boolean);

  for (const cache of playwrightCacheDirs()) {
    for (const dir of versionedDirs(cache, 'chromium')) {
      candidates.push(join(dir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
      candidates.push(join(dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
      candidates.push(join(dir, 'chrome-linux', 'chrome'));
      candidates.push(join(dir, 'chrome-linux64', 'chrome'));
    }
    for (const dir of versionedDirs(cache, 'chromium_headless_shell')) {
      candidates.push(join(dir, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'));
      candidates.push(join(dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'));
      candidates.push(join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    }
  }

  return candidates.find((path) => existsSync(path)) ?? null;
}

async function launchOnce(executablePath, { timeoutMs = 20000 } = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'mebular-dsh-e2e-chrome-'));
  const proc = spawn(executablePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  const started = Date.now();
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearInterval(timer);
          resolve(match[1]);
        } else if (proc.exitCode !== null || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Chrome 未就绪（exit=${proc.exitCode}）：${stderr.slice(-400)}`));
        }
      }, 100);
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.once('error', (error) => {
        clearInterval(timer);
        reject(error);
      });
      proc.once('exit', (code) => {
        if (code !== null && !stderr.includes('DevTools listening on')) {
          clearInterval(timer);
          reject(new Error(`Chrome 提前退出（code=${code}）：${stderr.slice(-400)}`));
        }
      });
    });

    let closed = false;
    return {
      proc,
      wsUrl,
      userDataDir,
      async close() {
        if (closed) return;
        closed = true;
        try {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    try { proc.kill('SIGKILL'); } catch { /* Already gone. */ }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Launch Chrome with the same small retry policy as the console smoke. */
export async function launchChrome(executablePath, { attempts = 3, timeoutMs = 20000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await launchOnce(executablePath, { timeoutMs });
    } catch (error) {
      lastError = error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError ?? new Error('Chrome 启动失败');
}

/** Tiny CDP client over Node's built-in WebSocket. */
export function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  const listeners = new Set();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (event) => reject(new Error(`CDP 连接失败：${event?.message ?? 'error'}`));
    ws.onclose = () => {
      for (const handler of pending.values()) handler.reject(new Error('CDP 连接已关闭'));
      pending.clear();
    };
  });

  ws.onmessage = (event) => {
    let msg = null;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const handler = pending.get(msg.id);
      pending.delete(msg.id);
      handler.resolve(msg);
    } else if (msg.method) {
      events.push(msg);
      for (const listener of listeners) {
        try { listener(msg); } catch { /* A listener must not break the client. */ }
      }
    }
  };

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, {
      resolve: (msg) => {
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      },
      reject,
    });
    try {
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });

  return {
    ws,
    ready,
    send,
    events,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      try { ws.close(); } catch { /* Already closed. */ }
    },
  };
}

function flattenFrames(node, out = []) {
  if (!node) return out;
  out.push(node.frame);
  for (const child of node.childFrames ?? []) flattenFrames(child, out);
  return out;
}

/**
 * Create a target, attach a flat session, and expose the operations the DSH
 * E2E needs. Browser console errors are collected for failure artifacts.
 */
export async function openPage(cdp, { url = 'about:blank', timeoutMs = 30000 } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => cdp.send(method, params, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const errors = [];
  cdp.onEvent((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params?.exceptionDetails ?? {};
      errors.push({
        kind: 'exception',
        text: details.exception?.description ?? details.text ?? 'unknown exception',
        url: details.url ?? null,
        line: details.lineNumber ?? null,
      });
    } else if (msg.method === 'Log.entryAdded') {
      const entry = msg.params?.entry ?? {};
      if (entry.level === 'error') {
        errors.push({ kind: 'log', text: entry.text ?? '', url: entry.url ?? null });
      }
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      if (msg.params?.type === 'error') {
        errors.push({
          kind: 'console',
          text: (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' '),
        });
      }
    }
  });

  async function evalJs(expression, { contextId } = {}) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId === undefined ? {} : { contextId }),
    });
    if (result.exceptionDetails) {
      throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  const transient = (error) => /Cannot read properties of null|Execution context was destroyed|Cannot find context|Inspected target navigated|No frame for given id|Session with given id not found/.test(String(error?.message ?? error));

  async function waitFor(expression, { timeout = 15000, intervalMs = 200 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        if (await evalJs(expression)) return true;
      } catch (error) {
        if (!transient(error)) throw error;
      }
      await sleep(intervalMs);
    }
    return false;
  }

  async function navigate(targetUrl) {
    await send('Page.navigate', { url: targetUrl });
    const loaded = await waitFor('document.readyState === "complete"', { timeout: timeoutMs });
    if (!loaded) throw new Error(`页面加载超时：${targetUrl}`);
  }

  async function frameTree() {
    const { frameTree } = await send('Page.getFrameTree');
    return flattenFrames(frameTree);
  }

  async function evalInFrame(frameId, expression) {
    const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'mebular-dsh-e2e' });
    return evalJs(expression, { contextId: world.executionContextId });
  }

  async function findFrame(predicate) {
    const frames = await frameTree();
    return frames.find((frame) => {
      try { return predicate(frame); } catch { return false; }
    }) ?? null;
  }

  /**
   * Evaluate inside an iframe without depending on same-origin access from the
   * parent. First uses the page frame tree; if Chrome isolates the frame, falls
   * back to attaching to the iframe target directly.
   */
  async function evalInFrameByUrl(urlPrefix, expression) {
    const frame = await findFrame((entry) => typeof entry.url === 'string' && entry.url.startsWith(urlPrefix));
    if (frame?.id) {
      try {
        return await evalInFrame(frame.id, expression);
      } catch {
        // Fall through to the target-based path.
      }
    }

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((info) => (info.type === 'iframe' || info.type === 'page')
      && typeof info.url === 'string'
      && info.url.startsWith(urlPrefix));
    if (!target) return undefined;
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const frameSend = (method, params = {}) => cdp.send(method, params, attached.sessionId);
    await frameSend('Runtime.enable');
    const result = await frameSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`iframe 求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async function screenshot() {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    return Buffer.from(result.data, 'base64');
  }

  async function dom() {
    return evalJs('document.documentElement ? document.documentElement.outerHTML : ""');
  }

  if (typeof url === 'string' && url.length > 0 && url !== 'about:blank') {
    await navigate(url);
  }

  return {
    targetId,
    sessionId,
    send,
    evalJs,
    waitFor,
    navigate,
    frameTree,
    findFrame,
    evalInFrame,
    evalInFrameByUrl,
    screenshot,
    dom,
    errors,
    async close() {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    },
  };
}
