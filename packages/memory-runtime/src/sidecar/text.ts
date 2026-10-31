// Sidecar 文本工具：脱敏、字节/token 估算、gist 截断。
//
// 召回/context 的输入与输出都按不可信背景数据对待；这些工具不改变
// 记忆语义，只做确定性处理：
// - 密钥/token 模式替换为 [redacted]；
// - 中英文混排的粗略 token 估算（预算以字节硬顶兜底）；
// - gist/详情按句子或空白边界截断，不截断数字/命令中段。
//
// 本模块不 import @mebular/core，也不打开图/事件日志。

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]'],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)\b(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi,
    '$1$2$3[redacted]$3',
  ],
];

export interface RedactionResult {
  text: string;
  redacted: boolean;
}

/** 替换常见密钥/token 模式；不声称脱敏后的文本仍是原文。 */
export function redactText(input: string): RedactionResult {
  let text = String(input ?? '');
  let redacted = false;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const next = text.replace(pattern, replacement);
    if (next !== text) {
      redacted = true;
      text = next;
    }
  }
  return { text, redacted };
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 粗略 token 估算：CJK/其他非 ASCII 字符按 1 token，ASCII 按 4 字符 1 token。
 * 仅用于 sidecar 预算，不冒充具体模型 tokenizer。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of String(text ?? '')) {
    if (char.codePointAt(0)! < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

/**
 * 在句子/空白/换行边界截断；宁可在边界前结束，也不截断数字/命令中段。
 * 长度按字符计；调用方仍须做字节预算。
 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const value = String(text ?? '');
  const limit = Math.max(1, Math.floor(maxChars));
  if (value.length <= limit) return { text: value, truncated: false };

  const window = value.slice(0, limit + 1);
  const boundary = Math.max(
    window.lastIndexOf('\n'),
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('. '),
    window.lastIndexOf('; '),
    window.lastIndexOf('；'),
    window.lastIndexOf(' '),
    window.lastIndexOf('\t'),
  );
  const cut = boundary >= Math.floor(limit * 0.6) ? boundary + 1 : limit;
  return { text: `${window.slice(0, cut).trimEnd()}…`, truncated: true };
}

/** 命令行/代码行整体保留或整体丢弃，不用省略号截半行。 */
export function truncateLines(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const lines = String(text ?? '').split('\n');
  const out: string[] = [];
  let used = 0;
  let truncated = false;
  for (const line of lines) {
    const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (used + bytes > maxBytes) {
      truncated = true;
      break;
    }
    out.push(line);
    used += bytes;
  }
  return { text: out.join('\n'), truncated };
}

/** 稳定 JSON（键排序），用于 trace 的 queryHash/内容 hash。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/**
 * 转义可能闭合宿主记忆块或伪装系统消息的标签；记忆内容永远只是数据。
 * 只处理标签名，不改变普通文本/数字/命令。
 */
export function escapeContextTags(input: string): string {
  return String(input ?? '').replace(
    /<\s*\/?\s*(mebular_memory|system|instructions?)\b/gi,
    (match) => match.replace('<', '&lt;'),
  );
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}
