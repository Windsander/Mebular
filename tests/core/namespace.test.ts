// namespace 原语单测：归一化、匹配、allow list 交集与订阅转换。

import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_NAMESPACE,
  normalizeNamespace,
  normalizeNamespaceList,
  matchesNamespace,
  intersectNamespaceAllowLists,
  subscriptionToAllowList,
  declarationToAllowList,
  isNamespaceAllowed,
  mergeClockInto,
  mergeNamespaceClocks,
  namespaceClockOf,
  type NamespaceClocks,
} from '../../src/core/namespace.js';

describe('namespace 原语', () => {
  it('normalizeNamespace / normalizeNamespaceList', () => {
    expect(normalizeNamespace(undefined)).toBe(DEFAULT_NAMESPACE);
    expect(normalizeNamespace('  ')).toBe(DEFAULT_NAMESPACE);
    expect(normalizeNamespace(' a ')).toBe('a');
    expect(normalizeNamespaceList(undefined)).toEqual([]);
    expect(normalizeNamespaceList([])).toEqual([]);
    expect(normalizeNamespaceList(['a', ' a ', '', 'b'])).toEqual(['a', DEFAULT_NAMESPACE, 'b']);
  });

  it('matchesNamespace：undefined/空数组 = 全部', () => {
    expect(matchesNamespace('a', undefined)).toBe(true);
    expect(matchesNamespace('a', [])).toBe(true);
    expect(matchesNamespace(undefined, 'default')).toBe(true);
    expect(matchesNamespace('a', 'b')).toBe(false);
    expect(matchesNamespace('a', ['a', 'b'])).toBe(true);
  });

  it('intersectNamespaceAllowLists：null = 不限制，空数组 = 不允许', () => {
    expect(intersectNamespaceAllowLists(null, null)).toBeNull();
    expect(intersectNamespaceAllowLists(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(intersectNamespaceAllowLists(['a'], [])).toEqual([]);
    expect(intersectNamespaceAllowLists(null, [])).toEqual([]);
    expect(intersectNamespaceAllowLists(['a'], null, ['a'])).toEqual(['a']);
  });

  it('declarationToAllowList：subscribeAll=true → 不限制；false → 显式白名单（[] = 不订阅）', () => {
    // 声明槽：subscribeAll 是「全部」的唯一表达；[] 不再有「全部」的反向含义
    expect(declarationToAllowList(true, [])).toBeNull();
    expect(declarationToAllowList(true, ['a', 'b'])).toBeNull();
    // 授权/显式订阅槽：[] 明确表示「不允许任何分区」
    expect(declarationToAllowList(false, [])).toEqual([]);
    expect(declarationToAllowList(false, ['a', 'a'])).toEqual(['a']);
  });

  it('分区时钟：mergeClockInto / mergeNamespaceClocks / namespaceClockOf', () => {
    const existing: NamespaceClocks = { nsA: { dev1: 1, dev2: 2 } };
    const target: NamespaceClocks = {};
    mergeClockInto(target, 'nsA', { dev1: 3 });
    mergeClockInto(target, 'nsB', { dev1: 1 });
    expect(target).toEqual({ nsA: { dev1: 3 }, nsB: { dev1: 1 } });
    expect(namespaceClockOf(target, 'nsX')).toEqual({});

    const merged = mergeNamespaceClocks(existing, target);
    expect(merged).toEqual({ nsA: { dev1: 3, dev2: 2 }, nsB: { dev1: 1 } });
    // 纯合并：不改动入参（逐分区、逐作者取最大值）
    expect(existing).toEqual({ nsA: { dev1: 1, dev2: 2 } });
    expect(target).toEqual({ nsA: { dev1: 3 }, nsB: { dev1: 1 } });
  });

  it('subscriptionToAllowList / isNamespaceAllowed', () => {
    expect(subscriptionToAllowList(undefined)).toBeNull();
    expect(subscriptionToAllowList([])).toBeNull();
    expect(subscriptionToAllowList(['a', 'a'])).toEqual(['a']);

    expect(isNamespaceAllowed(undefined, null)).toBe(true);
    expect(isNamespaceAllowed(undefined, ['default'])).toBe(true);
    expect(isNamespaceAllowed('x', ['y'])).toBe(false);
    expect(isNamespaceAllowed('x', [])).toBe(false);
  });
});
