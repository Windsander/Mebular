// Redaction for DSH E2E artifacts.
//
// Failure artifacts are uploaded by CI in Phase 3, so every text file written by
// the harness passes through redactText first: one-time DSH URL tokens,
// Authorization headers, token/secret/password/api_key values, the per-run seed
// token, and the ephemeral home/CLI paths used by this run.
//
// The same primitives are used by detectLeaks() to audit the written files, so
// a regression in redaction fails the run instead of silently leaking.

const REDACTED = '<redacted>';
const SECRET_KEY = '[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|csrf)[A-Za-z0-9_.-]*';
const SECRET_KV = new RegExp(
  `(["']?)(${SECRET_KEY})\\1(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}"']+)`,
  'gi',
);

/**
 * @param {unknown} input
 * @param {{
 *   secrets?: string[],
 *   paths?: Array<{ value: string, label: string }>,
 * }} [options]
 * @returns {string}
 */
export function redactText(input, options = {}) {
  let text = String(input ?? '');
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  const paths = Array.isArray(options.paths) ? options.paths : [];

  // Exact per-run secrets first: the seed token has no `token=` shape.
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      text = text.split(secret).join(REDACTED);
    }
  }

  // Longest path first so a home inside the scenario root is labelled more
  // precisely than the root itself.
  const orderedPaths = paths
    .filter((entry) => typeof entry?.value === 'string' && entry.value.length > 1)
    .sort((left, right) => right.value.length - left.value.length);
  for (const entry of orderedPaths) {
    text = text.split(entry.value).join(entry.label);
  }

  // URL query tokens: `?token=...`, `&token=...`, `;token=...`.
  text = text.replace(/([?&;]\s*token\s*=)[^&\s"'<>]+/gi, `$1${REDACTED}`);
  // Loose `token=...` occurrences (logs, shell snippets).
  text = text.replace(/\btoken\s*=\s*[^\s,&;"'<>]+/gi, `token=${REDACTED}`);

  // Authorization header, with or without a scheme.
  text = text.replace(
    /(\bAuthorization["']?\s*[:=]\s*)(Bearer|Basic)\s+[^\s,;"']+/gi,
    `$1$2 ${REDACTED}`,
  );
  text = text.replace(
    /(\bAuthorization["']?\s*[:=]\s*)(?!(?:Bearer|Basic)\b)[^\s,;"']+/gi,
    `$1${REDACTED}`,
  );
  // Standalone bearer credentials in logs.
  text = text.replace(/\bBearer\s+(?!<redacted>)[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  text = text.replace(/\bBasic\s+(?!<redacted>)[A-Za-z0-9+/=]{8,}/gi, `Basic ${REDACTED}`);

  // key=value / "key": "value" pairs for token/secret/password/api_key.
  text = text.replace(SECRET_KV, (_match, quote, key, separator, value) => {
    const prefix = `${quote}${key}${quote}${separator}`;
    if (value.startsWith('"')) return `${prefix}"${REDACTED}"`;
    if (value.startsWith("'")) return `${prefix}'${REDACTED}'`;
    return `${prefix}${REDACTED}`;
  });

  return text;
}

/**
 * Redact a JSON-compatible value without breaking its structure. Secret-keyed
 * fields become "<redacted>" whatever their type; strings go through
 * redactText(); arrays and objects are rebuilt.
 * @param {unknown} value
 * @param {{
 *   secrets?: string[],
 *   paths?: Array<{ value: string, label: string }>,
 * }} [options]
 * @returns {unknown}
 */
export function redactValue(value, options = {}) {
  if (typeof value === 'string') return redactText(value, options);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, options));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = new RegExp(`^(?:${SECRET_KEY})$`, 'i').test(key) && entry !== null && entry !== undefined
        ? REDACTED
        : redactValue(entry, options);
    }
    return out;
  }
  return value;
}

/**
 * Sensitive fragments that must not appear in a written artifact.
 * @param {unknown} input
 * @param {{
 *   secrets?: string[],
 *   paths?: Array<{ value: string, label: string }>,
 * }} [options]
 * @returns {string[]}
 */
export function detectLeaks(input, options = {}) {
  const text = String(input ?? '');
  const leaks = new Set();
  const secrets = Array.isArray(options.secrets) ? options.secrets : [];
  const paths = Array.isArray(options.paths) ? options.paths : [];

  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6 && text.includes(secret)) {
      leaks.add('exact-secret');
    }
  }
  for (const entry of paths) {
    if (typeof entry?.value === 'string' && entry.value.length > 1 && text.includes(entry.value)) {
      leaks.add(`path:${entry.label}`);
    }
  }
  if (/[?&;]\s*token\s*=(?!<redacted>)/i.test(text)) leaks.add('url-token');
  if (/\btoken\s*=(?!<redacted>)/i.test(text)) leaks.add('token-assignment');
  if (/\bBearer\s+(?!<redacted>)[A-Za-z0-9._~+/=-]+/i.test(text)) leaks.add('bearer');
  if (/\bAuthorization["']?\s*[:=]\s*(?!Bearer\s+<redacted>|Basic\s+<redacted>)["']?[A-Za-z0-9._~+/=-]{8,}/i.test(text)) {
    leaks.add('authorization');
  }
  // Inspect the captured value instead of using a lookahead: optional quotes
  // around a key or value let a lookahead backtrack into a false positive.
  for (const match of text.matchAll(SECRET_KV)) {
    const value = String(match[4] ?? '').replace(/^["']|["']$/g, '');
    if (!/^<redacted>$/.test(value)) {
      leaks.add('secret-key-value');
      break;
    }
  }

  return [...leaks];
}
