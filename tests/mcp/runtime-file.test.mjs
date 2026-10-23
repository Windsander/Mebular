// P4 · <home>/runtime.json：listen 成功后原子写入；停止时按 pid 清理；
// provision 模式同样可发现；新实例的文件不会被旧实例删除。

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_FILE,
  clearRuntimeFile,
  readRuntimeFile,
  runtimePath,
  writeRuntimeFile,
} from '../../packages/mcp/src/runtime-file.mjs';
import { APP_VERSION, EMBED_PROTOCOL, startHttpServer } from '../../packages/mcp/src/serve.mjs';

const RECORD = {
  version: APP_VERSION,
  pid: 1234,
  host: '127.0.0.1',
  port: 7331,
  embedProtocol: EMBED_PROTOCOL,
};

let home = null;

async function tempHome() {
  home = await mkdtemp(join(tmpdir(), 'mebular-runtime-'));
  return home;
}

afterEach(async () => {
  if (home !== null) await rm(home, { recursive: true, force: true });
  home = null;
});

describe('P4 runtime.json：文件契约', () => {
  it('原子写入完整非敏感文档，不留下临时文件', async () => {
    const dir = await tempHome();
    const written = await writeRuntimeFile(dir, RECORD);
    expect(written).toEqual({
      version: APP_VERSION,
      pid: 1234,
      http: { host: '127.0.0.1', port: 7331 },
      consolePath: '/console',
      mcpPath: '/mcp',
      embedProtocol: EMBED_PROTOCOL,
    });
    expect(await readRuntimeFile(dir)).toEqual(written);
    expect(await readdir(dir)).toEqual([RUNTIME_FILE]);
    expect(await readFile(runtimePath(dir), 'utf-8')).not.toContain('token');
  });

  it('只删除 pid 匹配的文件；新实例文件保留', async () => {
    const dir = await tempHome();
    await writeRuntimeFile(dir, { ...RECORD, pid: 111 });
    expect(await clearRuntimeFile(dir, { pid: 222 })).toBe(false);
    expect(await readRuntimeFile(dir)).not.toBeNull();
    expect(await clearRuntimeFile(dir, { pid: 111 })).toBe(true);
    expect(await readRuntimeFile(dir)).toBeNull();
  });

  it('损坏文件不会被当作自己的 runtime 删除', async () => {
    const dir = await tempHome();
    await writeFile(runtimePath(dir), '{broken', 'utf-8');
    expect(await readRuntimeFile(dir)).toBeNull();
    expect(await clearRuntimeFile(dir, { pid: 111 })).toBe(false);
    expect(existsSync(runtimePath(dir))).toBe(true);
  });
});

describe('P4 runtime.json：真实 HTTP 生命周期', () => {
  it('listen 后写入实际端口，/app/embed/info 与 runtime 共用协议版本，close 清理', async () => {
    const dir = await tempHome();
    const running = await startHttpServer({ home: dir, host: '127.0.0.1', port: 0 });
    try {
      expect(await readRuntimeFile(dir)).toEqual({
        version: APP_VERSION,
        pid: process.pid,
        http: { host: '127.0.0.1', port: running.port },
        consolePath: '/console',
        mcpPath: '/mcp',
        embedProtocol: EMBED_PROTOCOL,
      });
      const info = await (await fetch(`http://127.0.0.1:${running.port}/app/embed/info`)).json();
      expect(info.embedProtocol).toBe(EMBED_PROTOCOL);
      expect(info.version).toBe(APP_VERSION);
    } finally {
      await running.close();
    }
    expect(existsSync(runtimePath(dir))).toBe(false);
  });

  it('provision 模式也写入并清理 runtime.json', async () => {
    const dir = await tempHome();
    const running = await startHttpServer({ home: dir, host: '127.0.0.1', port: 0, provision: true });
    try {
      expect(await readRuntimeFile(dir)).toMatchObject({
        pid: process.pid,
        http: { host: '127.0.0.1', port: running.port },
        embedProtocol: EMBED_PROTOCOL,
      });
    } finally {
      await running.close();
    }
    expect(existsSync(runtimePath(dir))).toBe(false);
  });

  it('旧实例停止不删除新实例已写入的 runtime.json', async () => {
    const dir = await tempHome();
    const running = await startHttpServer({ home: dir, host: '127.0.0.1', port: 0 });
    await writeRuntimeFile(dir, { ...RECORD, pid: process.pid + 1 });
    await running.close();
    expect(await readRuntimeFile(dir)).toMatchObject({ pid: process.pid + 1 });
  });
});
