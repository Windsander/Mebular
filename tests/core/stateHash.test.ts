// stateHash（G6.1）：规范化图状态哈希从脚本抽到 core，脚本与 MCP 共用。

import { describe, it, expect } from '@jest/globals';
import { computeStateHash, isEvidenceNode } from '../../src/core/stateHash.js';
import type { Node, Edge } from '../../src/types/index.js';

function node(id: string, text: string, type = 'fact'): Node {
  return {
    id,
    type,
    content: { text },
    labels: [],
    createdBy: 'device-A',
    signature: '',
    createdAt: 1000,
    updatedAt: 1000,
    validFrom: 1000,
    validTo: 9999999999999,
    tags: [],
  };
}

function edge(id: string, source: string, target: string): Edge {
  return {
    id,
    type: 'edge',
    source,
    target,
    relation: 'related',
    createdBy: 'device-A',
    signature: '',
    createdAt: 1000,
    updatedAt: 1000,
    labels: [],
  };
}

describe('computeStateHash', () => {
  it('与节点顺序无关（规范化排序）', () => {
    const a = node('n1', 'a');
    const b = node('n2', 'b');
    expect(computeStateHash([a, b], [])).toBe(computeStateHash([b, a], []));
  });

  it('内容变化即哈希变化', () => {
    const h1 = computeStateHash([node('n1', 'a')], []);
    const h2 = computeStateHash([node('n1', 'b')], []);
    expect(h1).not.toBe(h2);
  });

  it('包含边；边顺序无关', () => {
    const e1 = edge('e1', 'n1', 'n2');
    const e2 = edge('e2', 'n2', 'n3');
    const h = computeStateHash([], [e1, e2]);
    expect(h).toBe(computeStateHash([], [e2, e1]));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('排除 wan-evidence-* 证据 meta 节点，其余 meta 计入', () => {
    const fact = node('n1', 'a');
    const evidence = node('m1', 'x', 'meta');
    evidence.content = { name: 'wan-evidence-run1', value: '{}' };
    const otherMeta = node('m2', 'y', 'meta');
    otherMeta.content = { metaType: 'other', name: 'normal-meta' };

    expect(isEvidenceNode(evidence)).toBe(true);
    expect(isEvidenceNode(otherMeta)).toBe(false);

    const withoutEvidence = computeStateHash([fact, otherMeta], []);
    expect(computeStateHash([fact, otherMeta, evidence], [])).toBe(withoutEvidence);
  });
});
