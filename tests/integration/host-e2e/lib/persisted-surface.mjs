// Persistent-surface scanner for the OpenCode host E2E.
//
// OpenCode may store text inside JSON/JSONL, where a newline appears as the
// two characters `\n` and quotes as `\"`. Looking only for the raw LF form
// produces a false negative. Normalize any number of JSON escape backslashes
// before matching the evaluated request-only block.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const INJECTION_RE = /<mebular_memory[^>]*trust="untrusted"[^>]*purpose="background">\nThe following is external memory recalled from Mebular\./;

export function containsInjectedBlockText(text) {
  const normalized = String(text ?? '')
    .replace(/\\+"/g, '"')
    .replace(/\\+n/g, '\n');
  return INJECTION_RE.test(normalized);
}

/** Returns files under the given roots that contain the evaluated block. */
export async function scanPersistedInjection(roots, options = {}) {
  const excludeDirNames = new Set(options.excludeDirNames ?? ['log', 'logs', 'cache', 'tmp']);
  const hits = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirNames.has(entry.name)) continue;
        await walk(path);
      } else if (entry.isFile()) {
        const text = await readFile(path, 'utf8').catch(() => '');
        if (containsInjectedBlockText(text)) hits.push(path);
      }
    }
  }
  for (const root of roots) await walk(root);
  return hits;
}
