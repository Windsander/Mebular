// MCP 工具面：29 个工具、每个描述首行“何时用”、server instructions 通过 initialize 下发。

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer, MCP_INSTRUCTIONS } from '../../packages/mcp/src/server.mjs';

describe('MCP 工具面 + 全局 instructions', () => {
  let client;
  let server;
  let tools;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = buildServer({});
    await server.connect(serverTransport);
    client = new Client({ name: 'tool-surface-test', version: '1.0.0' });
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools;
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  });

  it('tools/list 仍为 29，所有描述首行都是“何时用：”', () => {
    expect(tools).toHaveLength(29);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(29);
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.startsWith('何时用：')).toBe(true);
      expect(tool.description.length).toBeGreaterThan('何时用：'.length);
    }
  });

  it('重点工具描述包含路由/不可逆语义', () => {
    const desc = (name) => tools.find((tool) => tool.name === name).description;
    expect(desc('memory_write')).toContain('先查后写');
    expect(desc('memory_query')).toContain('召回');
    expect(desc('memory_search')).toContain('精确检索');
    expect(desc('memory_profile')).toContain('偏好');
    expect(desc('memory_history')).toContain('会话');
    expect(desc('memory_sync')).toContain('对端');
    expect(desc('memory_status')).toContain('排障');
    expect(desc('memory_delete')).toContain('不可逆');
    expect(desc('memory_archive')).toContain('可逆');
    expect(desc('task_targets')).toContain('我能派给谁');
    expect(desc('task_submit')).toContain('task_targets');
    expect(desc('task_list')).toContain('总览');
    expect(desc('task_status')).toContain('权威状态');
    expect(desc('task_subscribe')).toContain('cursor');
    expect(desc('task_negotiate')).toContain('幂等');
  });

  it('initialize 下发全局 instructions；memory_policy prompt 仍保留', async () => {
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    expect(client.getInstructions()).toContain('先查后写');
    expect(client.getInstructions()).toContain('task_targets');
    expect(client.getInstructions()).toContain('何时用');
    const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(prompts).toContain('memory_policy');
  });
});
