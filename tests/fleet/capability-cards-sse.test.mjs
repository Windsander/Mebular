// P1：能力卡不是 task_event，不得进入 fleet SSE / 星图。
import { describe, it, expect } from '@jest/globals';
import { fleetEventFromEvent } from '../../packages/mcp/src/fleet-events.mjs';

const card = {
  v: 1,
  kind: 'agent_capability_card',
  device: 'device-B',
  agent: 'worker',
  version: 1,
  capabilities: ['fleet.task'],
  tools: ['task_submit'],
  limits: { maxConcurrency: 1 },
  permissions: { taskNamespaces: ['tasks'] },
  runtime: { os: 'test', arch: 'test', runtime: 'node', runtimeVersion: 'test' },
  provenance: { source: 'test', configHash: 'sha256:x', registryHash: 'sha256:y', publishedAt: 1 },
  signature: { alg: 'Ed25519', keyId: 'device-B', sig: 'x' },
};

describe('P1 能力卡与 fleet SSE 隔离', () => {
  it('card 节点（即使 namespace=agents）不产生 fleet 广播', () => {
    const nodeCreated = {
      type: 'node_created',
      namespace: 'agents',
      data: { node: { type: 'agent_capability_card', namespace: 'agents', content: card } },
    };
    expect(fleetEventFromEvent(nodeCreated)).toBeNull();
    expect(fleetEventFromEvent({ type: 'agent_capability_card', namespace: 'agents', content: card })).toBeNull();
    // 即使卡节点被错误放进 tasks 域，只要 type 不是 task_event 就不广播。
    expect(fleetEventFromEvent({ type: 'agent_capability_card', namespace: 'tasks', content: { ...card, type: 'created' } })).toBeNull();
  });

  it('真实 task created 仍照常广播（旧行为不变）', () => {
    const payload = fleetEventFromEvent({
      type: 'node_created',
      namespace: 'tasks',
      data: {
        node: {
          type: 'task_event',
          namespace: 'tasks',
          content: {
            v: 1,
            eventId: 'task-1#created',
            taskId: 'task-1',
            type: 'created',
            actor: { device: 'device-A', agent: 'board' },
            to: { device: 'device-B', agent: 'worker' },
            toStatus: 'queued',
            at: 1,
            trace: { chain: [] },
            intent: 'hello',
          },
        },
      },
    }, { namespace: 'tasks', now: 123 });
    expect(payload).toEqual({
      at: 123,
      fromDeviceId: 'device-A',
      toDeviceId: 'device-B',
      taskId: 'task-1',
      eventType: 'created',
      namespace: 'tasks',
    });
  });
});
