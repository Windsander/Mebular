// Sidecar 脱敏 JSONL 运行日志。
//
// 边界（C17 / WP5）：
// - 只记录稳定 code、阶段、计数、年龄和状态，不记录正文、prompt、token 或真实 home；
// - 有界轮转：单个文件达到 maxBytes 后滚动，最多保留 maxFiles 个文件；
// - 文件 0600，目录由 local-layer 以 0700 创建；
// - 读取接口只返回脱敏事件，供 `mebular memory-runtime logs|doctor` 使用。
//
// 本模块不 import @mebular/core，也不打开图/事件日志。

import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redactText } from './text.js';

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 3;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_STRING = 512;
const MAX_DEPTH = 4;
const SENSITIVE_KEY_RE = /^(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|credential|private[-_]?key|keyref|cookie)$/i;
const BODY_KEY_RE = /^(?:body|content|contents|text|prompt|prompts|response|responses|messages|message|chunks?|items?|payload|raw|detailtext)$/i;
const PATH_RE = /(?:\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|]+[\\/])*[^\\/\s"'<>|]*|\\\\[^\\/\s"'<>|]+\\[^\s"'<>|]*|\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*|\/(?:opt|root)(?=$|[\s"',;:]))/g;

export type DiagnosticLogLevel = 'info' | 'warn' | 'error';

export interface DiagnosticLogEvent {
  ts: number;
  level: DiagnosticLogLevel;
  event: string;
  [key: string]: unknown;
}

export interface DiagnosticLogStatus {
  files: number;
  bytes: number;
  latestAt: number | null;
}

export interface DiagnosticLogOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value: string): string {
  return redactText(value).text
    .replace(PATH_RE, '[path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, MAX_STRING);
}

function sanitizeValue(value: unknown, key: string | undefined, depth: number): unknown {
  if (key && SENSITIVE_KEY_RE.test(key)) return '[redacted]';
  if (key && BODY_KEY_RE.test(key)) return '[omitted]';
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, undefined, depth + 1));
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryValue === undefined) continue;
      out[entryKey] = sanitizeValue(entryValue, entryKey, depth + 1);
      count += 1;
      if (count >= 40) break;
    }
    return out;
  }
  return '[truncated]';
}

function sanitizeEvent(event: DiagnosticLogEvent): DiagnosticLogEvent {
  const out: DiagnosticLogEvent = {
    ts: Number.isFinite(event.ts) ? Math.floor(event.ts) : Date.now(),
    level: event.level === 'warn' || event.level === 'error' ? event.level : 'info',
    event: sanitizeString(event.event),
  };
  for (const [key, value] of Object.entries(event)) {
    if (key === 'ts' || key === 'level' || key === 'event') continue;
    out[key] = sanitizeValue(value, key, 0);
  }
  return out;
}

export class DiagnosticLog {
  readonly dir: string;
  readonly currentPath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;

  private readonly now: () => number;
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options: DiagnosticLogOptions) {
    this.dir = options.dir;
    this.currentPath = join(options.dir, 'runtime.jsonl');
    this.maxBytes = Math.max(256, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => undefined);
    this.initialized = true;
  }

  private rotatedPath(index: number): string {
    return `${this.currentPath}.${index}`;
  }

  private async rotateUnlocked(extraBytes: number): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.currentPath)).size;
    } catch {
      size = 0;
    }
    if (size === 0 || size + extraBytes <= this.maxBytes) return;
    if (this.maxFiles === 1) {
      await rm(this.currentPath, { force: true }).catch(() => undefined);
      return;
    }
    // 保留 maxFiles 个文件：current + .1 .. .(maxFiles-1)。
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.currentPath : this.rotatedPath(index - 1);
      const target = this.rotatedPath(index);
      if (index === this.maxFiles - 1) await rm(target, { force: true }).catch(() => undefined);
      try {
        await rename(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    }
  }

  async append(
    level: DiagnosticLogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): Promise<DiagnosticLogEvent> {
    return this.exclusive(async () => {
      await this.init();
      const sanitized = sanitizeEvent({
        ts: this.now(),
        level,
        event,
        ...fields,
      });
      let line = `${JSON.stringify(sanitized)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        line = `${JSON.stringify({
          ts: sanitized.ts,
          level: sanitized.level,
          event: sanitized.event,
          truncated: true,
        })}\n`;
      }
      await this.rotateUnlocked(Buffer.byteLength(line, 'utf8'));
      const handle = await open(this.currentPath, 'a', 0o600);
      try {
        await handle.write(line, null, 'utf8');
        await handle.chmod(0o600).catch(() => undefined);
      } finally {
        await handle.close().catch(() => undefined);
      }
      return sanitized;
    });
  }

  async readRecent(limit = 50): Promise<DiagnosticLogEvent[]> {
    const max = Math.max(1, Math.min(500, Math.floor(limit)));
    const files = [this.currentPath];
    for (let index = 1; index < this.maxFiles; index += 1) files.push(this.rotatedPath(index));
    const events: DiagnosticLogEvent[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isObject(parsed) && typeof parsed.event === 'string') {
            events.push(sanitizeEvent(parsed as DiagnosticLogEvent));
          }
        } catch {
          // 损坏行不进入诊断输出，也不回写日志。
        }
      }
    }
    events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    return events.slice(-max);
  }

  async stats(): Promise<DiagnosticLogStatus> {
    const files = [this.currentPath];
    for (let index = 1; index < this.maxFiles; index += 1) files.push(this.rotatedPath(index));
    let bytes = 0;
    let count = 0;
    let latestAt: number | null = null;
    for (const file of files) {
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size === 0) continue;
        count += 1;
        bytes += info.size;
      } catch {
        continue;
      }
    }
    const recent = await this.readRecent(1);
    latestAt = recent.length > 0 && typeof recent[0]!.ts === 'number' ? recent[0]!.ts : null;
    return { files: count, bytes, latestAt };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
