// Small CDP driver for the real DSH Web conversation used by the immersive
// journey. It only touches documented DOM seams (composer, send button, session
// rows) and never reads application internals.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const FAKE_REPLY = 'FAKE_ASSISTANT_REPLY';

async function clickText(page, text) {
  return page.evalJs(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => entry.textContent?.trim() === ${JSON.stringify(text)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

export async function dismissOnboarding(page) {
  if (await clickText(page, '继续')) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
    return true;
  }
  return false;
}

export async function newSession(page) {
  const clicked = await page.evalJs(`(() => {
    const button = document.querySelector('button[aria-label="新建会话"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
  return clicked;
}

export async function sendPrompt(page, text) {
  const probe = text.slice(0, Math.min(text.length, 8));
  let value = '';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const ready = await page.evalJs(`(() => {
      const editor = document.querySelector('[data-composer-input]');
      if (!editor) return false;
      editor.click();
      editor.focus();
      return document.activeElement === editor || editor.contains(document.activeElement);
    })()`);
    if (!ready) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      continue;
    }
    await page.send('Input.insertText', { text });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    value = await page.evalJs('document.querySelector("[data-composer-input]")?.innerText ?? ""');
    if (value.includes(probe)) break;
    // A DSH navigation can drop the first insertText; retry with the DOM
    // editing primitive before failing the turn.
    await page.evalJs(`(() => {
      const editor = document.querySelector('[data-composer-input]');
      if (!editor) return false;
      editor.focus();
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      return true;
    })()`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    value = await page.evalJs('document.querySelector("[data-composer-input]")?.innerText ?? ""');
    if (value.includes(probe)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  if (!value.includes(probe)) {
    throw new Error(`DSH composer did not accept text (${JSON.stringify(value)})`);
  }
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

export async function bodyText(page) {
  return page.evalJs('document.body?.innerText ?? ""');
}

export async function waitForAssistantTurns(page, count, { timeoutMs = 45000, reply = FAKE_REPLY } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await bodyText(page);
    const matches = last.split(reply).length - 1;
    const running = /运行中|生成中|Waiting|Thinking/.test(last);
    if (matches >= count && !running) return { ok: true, text: last, matches };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  return { ok: false, text: last, matches: last.split(reply).length - 1 };
}

export async function captureEvidence(page, directory, name) {
  await mkdir(directory, { recursive: true });
  const shot = await page.screenshot();
  const dom = await page.dom();
  const text = await bodyText(page);
  await writeFile(join(directory, `${name}.png`), shot);
  await writeFile(join(directory, `${name}.html`), dom);
  await writeFile(join(directory, `${name}.txt`), text);
  return {
    screenshot: join(directory, `${name}.png`),
    dom: join(directory, `${name}.html`),
    text: join(directory, `${name}.txt`),
  };
}

export async function openSession(page, sessionId) {
  const clicked = await page.evalJs(`(() => {
    const row = document.querySelector('[data-row-key=${JSON.stringify(`session:${sessionId}`)}]');
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (clicked) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  return clicked;
}

export async function openSidebar(page) {
  return page.evalJs(`(() => {
    const button = document.querySelector('button[aria-label="打开侧边栏"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

/** Visible-memory assertions shared by every DSH screenshot/DOM step. */
export function visibleMemoryFindings(text, { detailText, gistPrefix = '用户偏好' } = {}) {
  const findings = [];
  if (text.includes('<mebular_memory')) findings.push('raw-memory-block');
  if (text.includes('mebular_memory')) findings.push('memory-tag');
  if (text.includes(gistPrefix)) findings.push('memory-gist');
  if (typeof detailText === 'string' && detailText.length > 0) {
    const occurrences = text.split(detailText).length - 1;
    if (occurrences > 1) findings.push(`detail-duplicated:${occurrences}`);
  }
  return findings;
}

async function walkFiles(directory, out = []) {
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decompress one concatenated-frame zstd file (DSH appends one frame per write). */
function decompressZstdFrames(buffer) {
  const offsets = [];
  for (let index = 0; index <= buffer.length - ZSTD_MAGIC.length; index += 1) {
    if (buffer.subarray(index, index + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) offsets.push(index);
  }
  if (offsets.length === 0 || offsets[0] !== 0) return zstdDecompressSync(buffer).toString('utf8');
  const parts = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const end = offsets[index + 1] ?? buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8'));
    } catch {
      // A live session may be mid-frame; skip this frame and keep earlier ones.
    }
  }
  return parts.join('\n');
}

/** Decompressed DSH session log text (v4 JSONL is zstd-compressed). */
export async function sessionLogText(dshHome) {
  const files = await walkFiles(join(dshHome, 'sessions'));
  const parts = [];
  for (const path of files) {
    if (!path.endsWith('.zstd')) continue;
    const buffer = await readFile(path);
    try {
      parts.push(decompressZstdFrames(buffer));
    } catch {
      // A live session may still be appending; the next poll retries.
    }
  }
  return parts.join('\n');
}
