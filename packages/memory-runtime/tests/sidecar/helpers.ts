// sidecar 测试共用工具：临时 home、清理、HTTP 请求。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function tempHome(prefix = 'mebular-memory-runtime-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDirs(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.json() };
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
