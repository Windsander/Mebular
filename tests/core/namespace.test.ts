// namespace 原语单测：归一化、匹配、allow list 交集与订阅转换。

import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_NAMESPACE,
  normalizeNamespace,
  normalizeNamespaceList,
  matchesNamespace,
  intersectNamespaceAllowLists,
  subscriptionToAllowList,
  isNamespaceAllowed,
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

  it('intersectNamespaceAllowLists：null = 未声明，空数组 = 不允许', () => {
    expect(intersectNamespaceAllowLists(null, null)).toBeNull();
    expect(intersectNamespaceAllowLists(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(intersectNamespaceAllowLists(['a'], [])).toEqual([]);
    expect(intersectNamespaceAllowLists(null, [])).toEqual([]);
    expect(intersectNamespaceAllowLists(['a'], null, ['a'])).toEqual(['a']);
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
