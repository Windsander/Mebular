// W10c 契约：MCP task tools 与 fleet CLI 只共用 @mebular/fleet 的 TASK_TOOLS handler。
//
// actor 规则：
// - MCP 协议没有稳定 Agent 身份 → 显式默认 `board`（DEFAULT_TASK_AGENT）；
// - fleet CLI 未传 --agent 时同一默认；传 --agent 是显式操作者覆盖；
// - 两侧都只把 agent 放进同一 handler 的 ToolContext，不存在第二套任务实现。

import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TASK_TOOLS,
  toolByCli,
  toolByName,
  onboardDevice,
} from '../../packages/fleet/src/index.js';
import {
  DEFAULT_TASK_AGENT,
  TASK_TOOL_SCOPES,
  TASK_TOOL_SPECS,
} from '../../packages/mcp/src/task-tools.mjs';
import { TOOL_ALL_SCOPES } from '../../packages/mcp/src/tools.mjs';
import { codeFor } from '../../packages/mcp/src/tool-envelope.mjs';

const AGENTS = [{ name: 'echo', kind: 'echo' }];

async function setupDir() {
  const dir = await mkdtemp(join(tmpdir(), 'task-surface-parity-'));
  await onboardDevice({ dir, device: 'device-A', agents: AGENTS });
  return dir;
}

function spec(name) {
  return TASK_TOOL_SPECS.find((tool) => tool.name === name);
}

describe('W10c 任务面统一', () => {
  it('TASK_TOOLS 定义唯一，MCP/CLI scope 与 fleet 逐工具一致', () => {
    expect(TASK_TOOLS).toHaveLength(16);
    expect(Object.keys(TASK_TOOL_SCOPES)).toHaveLength(16);
    for (const tool of TASK_TOOLS) {
      expect(spec(tool.name)).toBeDefined();
      expect(TASK_TOOL_SCOPES[tool.name]).toBe(tool.scope);
      expect(TOOL_ALL_SCOPES[tool.name]).toBe(tool.scope);
      expect(toolByCli(tool.cli)?.name).toBe(tool.name);
      expect(toolByCli(tool.cli)?.handler).toBe(toolByName(tool.name)?.handler);
    }
  });

  it('同一 task_submit/task_status：MCP 适配器与 fleet handler 返回一致，默认 actor=board', async () => {
    const dir = await setupDir();
    try {
      const fleetSubmit = await toolByName('task_submit').handler(
        { intent: 'parity-root', to: { device: 'device-B', agent: 'echo' } },
        { dir },
      );
      expect(fleetSubmit.ok).toBe(true);
      expect(fleetSubmit.from).toEqual({ device: 'device-A', agent: DEFAULT_TASK_AGENT });

      const mcpSubmit = await spec('task_submit').handler(null, {
        intent: 'parity-mcp',
        to: { device: 'device-B', agent: 'echo' },
      }, { home: dir });
      expect(mcpSubmit.isError).toBeUndefined();
      expect(mcpSubmit.structuredContent.ok).toBe(true);
      expect(mcpSubmit.structuredContent.from).toEqual({ device: 'device-A', agent: DEFAULT_TASK_AGENT });

      const taskId = fleetSubmit.taskId;
      const fleetStatus = await toolByName('task_status').handler({ taskId }, { dir });
      const mcpStatus = await spec('task_status').handler(null, { taskId }, { home: dir });
      expect(mcpStatus.structuredContent).toEqual(fleetStatus);
      expect(mcpStatus.structuredContent.state.status).toBe('queued');

      const mcpReadBack = await spec('task_status').handler(null, {
        taskId: mcpSubmit.structuredContent.taskId,
      }, { home: dir });
      expect(mcpReadBack.structuredContent).toEqual(
        await toolByName('task_status').handler({ taskId: mcpSubmit.structuredContent.taskId }, { dir }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('显式 agent 覆盖：MCP context.agent 与 CLI --agent 进入同一 ToolContext', async () => {
    const dir = await setupDir();
    try {
      const fleetSubmit = await toolByName('task_submit').handler(
        { intent: 'reviewer-root', to: { device: 'device-B', agent: 'echo' } },
        { dir, agent: 'reviewer' },
      );
      const mcpSubmit = await spec('task_submit').handler(null, {
        intent: 'reviewer-mcp',
        to: { device: 'device-B', agent: 'echo' },
      }, { home: dir, agent: 'reviewer' });
      expect(fleetSubmit.from.agent).toBe('reviewer');
      expect(mcpSubmit.structuredContent.from.agent).toBe('reviewer');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('错误码一致：同一非法输入在 MCP 信封与 fleet handler 之间可映射', async () => {
    const dir = await setupDir();
    try {
      const missingIntent = { to: { device: 'device-B', agent: 'echo' } };
      const fleetError = await toolByName('task_submit').handler(missingIntent, { dir })
        .then(() => null, (error) => error);
      expect(fleetError).toBeInstanceOf(Error);
      expect(codeFor(fleetError.message)).toBe('E_INPUT');

      const mcpError = await spec('task_submit').handler(null, missingIntent, { home: dir });
      expect(mcpError.isError).toBe(true);
      expect(mcpError.structuredContent.error.code).toBe('E_INPUT');

      const mcpStatusError = await spec('task_status').handler(null, {}, { home: dir });
      expect(mcpStatusError.structuredContent.error.code).toBe('E_INPUT');
      await expect(toolByName('task_status').handler({}, { dir })).rejects.toThrow(/taskId/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
