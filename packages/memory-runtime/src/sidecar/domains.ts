// 记忆域语法、归属推导与按 Agent 的本地读写策略。
//
// 契约（contract v2 §4.2 / §6、sidecar §7.2）：
// - domain 就是节点的 namespace；`user` / `agent:<id>` / `default` /
//   `task:<threadId>` / `shared` / `system` 是保留域；
// - 其他 0.2 namespace 是 Other 显式域；
// - `__*` 是保留 namespace，不是记忆域；
// - 归属由 capability 服务端按 domain 推导，sidecar 只做本地约束，
//   不把 ownerType/ownerId 发给服务端冒充权威。
//
// 本模块不 import @mebular/core，也不打开图/事件日志。

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const THREAD_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const RESERVED_DOMAINS = new Set(['user', 'default', 'shared', 'system']);
export const DOMAIN_MAX_LENGTH = 128;

export type OwnerType = 'user' | 'agent' | 'other';

export interface DomainOwner {
  ownerType: OwnerType;
  ownerId: string;
}

export function isValidAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_RE.test(value);
}

export function isValidThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID_RE.test(value);
}

/** 记忆域语法；非法返回 null（与 capability API 保持同一规则）。 */
export function normalizeDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.trim();
  if (domain.length === 0 || domain.length > DOMAIN_MAX_LENGTH) return null;
  if (domain.startsWith('__')) return null;
  if (RESERVED_DOMAINS.has(domain)) return domain;
  if (domain.startsWith('agent:')) {
    return isValidAgentId(domain.slice('agent:'.length)) ? domain : null;
  }
  if (domain.startsWith('task:')) {
    return isValidThreadId(domain.slice('task:'.length)) ? domain : null;
  }
  // 0.2 任意 namespace = Other 显式域，原样保留。
  if (/[\u0000-\u001f\u007f/\\]/.test(domain)) return null;
  return domain;
}

/** 域 → 归属；仅用于本地校验/视图，权威推导在 capability 服务端。 */
export function deriveOwner(domain: string, { userId = 'user' }: { userId?: string } = {}): DomainOwner {
  if (domain === 'user') return { ownerType: 'user', ownerId: userId };
  if (domain.startsWith('agent:')) {
    return { ownerType: 'agent', ownerId: domain.slice('agent:'.length) };
  }
  return { ownerType: 'other', ownerId: domain };
}

export function agentDomain(agentId: string): string {
  return `agent:${agentId}`;
}

export function taskDomain(threadId: string): string {
  return `task:${threadId}`;
}

export function isAgentDomain(domain: string): boolean {
  return domain.startsWith('agent:');
}

export function agentIdOfDomain(domain: string): string | null {
  return domain.startsWith('agent:') ? domain.slice('agent:'.length) : null;
}

export function isTaskDomain(domain: string): boolean {
  return domain.startsWith('task:');
}

export function threadIdOfDomain(domain: string): string | null {
  return domain.startsWith('task:') ? domain.slice('task:'.length) : null;
}

// ---------------------------------------------------------------------------
// 按 Agent 的本地策略（policy.json）
// ---------------------------------------------------------------------------

export interface AgentDomainPolicy {
  readDomains: string[];
  writeDomains: string[];
  userWriteConfirmation: boolean;
}

export interface SidecarPolicy {
  schema: 1;
  agents: Record<string, AgentDomainPolicy>;
}

export interface LoadedPolicy {
  policy: SidecarPolicy;
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Agent 缺省策略：读 user/default/self/current task；写 user/self/default/task/shared。 */
export function defaultAgentPolicy(agentId: string): AgentDomainPolicy {
  return {
    readDomains: ['user', 'default', agentDomain(agentId), 'task:*'],
    writeDomains: ['user', 'default', agentDomain(agentId), 'task:*', 'shared'],
    userWriteConfirmation: true,
  };
}

export function defaultSidecarPolicy(): SidecarPolicy {
  return { schema: 1, agents: {} };
}

function normalizePattern(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const pattern = value.trim();
  if (pattern === 'task:*') return pattern;
  return normalizeDomain(pattern);
}

function normalizePatternList(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error('domains 必须是字符串数组');
  if (value.length > 32) throw new Error('domains 最多 32 项');
  const out: string[] = [];
  for (const entry of value) {
    const pattern = normalizePattern(entry);
    if (pattern === null) throw new Error('domains 含非法域');
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/**
 * 归一化 policy.json。
 * 非法条目拒绝并保留安全默认：不静默放宽权限。
 */
export function normalizeSidecarPolicy(raw: unknown): { policy: SidecarPolicy; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { policy: defaultSidecarPolicy(), warnings };
  if (!isObject(raw)) return { policy: defaultSidecarPolicy(), warnings: ['policy_invalid'] };
  const agentsRaw = raw.agents;
  const agents: Record<string, AgentDomainPolicy> = {};
  if (agentsRaw !== undefined && !isObject(agentsRaw)) {
    return { policy: { schema: 1, agents }, warnings: ['policy_invalid'] };
  }
  for (const [agentId, value] of Object.entries(isObject(agentsRaw) ? agentsRaw : {})) {
    if (!isValidAgentId(agentId)) {
      warnings.push(`policy_agent_invalid:${agentId}`);
      continue;
    }
    if (!isObject(value)) {
      warnings.push(`policy_agent_invalid:${agentId}`);
      continue;
    }
    try {
      const readDomains = normalizePatternList(value.readDomains)
        ?? defaultAgentPolicy(agentId).readDomains;
      const writeDomains = normalizePatternList(value.writeDomains)
        ?? defaultAgentPolicy(agentId).writeDomains;
      const userWriteConfirmation = value.userWriteConfirmation === undefined
        ? true
        : value.userWriteConfirmation === true;
      agents[agentId] = { readDomains, writeDomains, userWriteConfirmation };
    } catch {
      warnings.push(`policy_agent_invalid:${agentId}`);
    }
  }
  return { policy: { schema: 1, agents }, warnings };
}

export function policyForAgent(policy: SidecarPolicy | null | undefined, agentId: string): AgentDomainPolicy {
  return policy?.agents[agentId] ?? defaultAgentPolicy(agentId);
}

export interface DomainAccessContext {
  agentId: string;
  threadId?: string | null;
}

/** 域是否匹配策略条目；`task:*` 只匹配当前显式 threadId。 */
export function policyAllows(
  patterns: readonly string[],
  domain: string,
  { threadId }: { threadId?: string | null } = {},
): boolean {
  for (const pattern of patterns) {
    if (pattern === domain) return true;
    if (pattern === 'task:*' && isTaskDomain(domain)) {
      if (!threadId) return false;
      return threadIdOfDomain(domain) === threadId;
    }
  }
  return false;
}

/** 是否可读某域；用于 `/namespaces` 视图，不替代 capability 的读过滤。 */
export function canReadDomain(
  policy: SidecarPolicy | null | undefined,
  agentId: string,
  domain: string,
  options: { threadId?: string | null } = {},
): boolean {
  const entry = policyForAgent(policy, agentId);
  return policyAllows(entry.readDomains, domain, options);
}

export interface WriteDomainCheck {
  allowed: boolean;
  code: 'domain_write_forbidden' | 'domain_mismatch' | null;
  reason: string | null;
  /** 建议的降级域；用于 user 域未确认时写回自己的 Agent 域。 */
  allowedDomain?: string;
}

/** 本地写域校验（capability 仍会按 actor/domain 再校验一次）。 */
export function checkWriteDomain(
  policy: SidecarPolicy | null | undefined,
  {
    agentId,
    threadId,
    domain,
    confirmation,
  }: {
    agentId: string;
    threadId?: string | null;
    domain: string;
    confirmation?: 'explicit' | 'policy' | 'none';
  },
): WriteDomainCheck {
  const entry = policyForAgent(policy, agentId);
  const allowed = (reason: string, check: Omit<WriteDomainCheck, 'allowed' | 'code' | 'reason'> = {}): WriteDomainCheck => ({
    ...check,
    allowed: false,
    code: 'domain_write_forbidden',
    reason,
  });

  if (domain === 'system') {
    return allowed('system 域只允许 admin 写入');
  }
  if (domain === 'user') {
    if (!policyAllows(entry.writeDomains, 'user')) {
      return allowed('策略未授权写入 user 域', { allowedDomain: agentDomain(agentId) });
    }
    if (entry.userWriteConfirmation && confirmation !== 'explicit') {
      return allowed('写入 user 域需要用户明确确认', { allowedDomain: agentDomain(agentId) });
    }
    return { allowed: true, code: null, reason: null };
  }
  if (isAgentDomain(domain)) {
    const owner = agentIdOfDomain(domain);
    if (owner !== agentId) {
      return allowed('Agent 不能写入其他 Agent 的记忆域');
    }
    if (!policyAllows(entry.writeDomains, domain)) {
      return allowed('策略未授权写入自己的 Agent 域');
    }
    return { allowed: true, code: null, reason: null };
  }
  if (isTaskDomain(domain)) {
    const domainThread = threadIdOfDomain(domain);
    if (!threadId || domainThread !== threadId) {
      return {
        allowed: false,
        code: 'domain_mismatch',
        reason: '任务域必须与当前显式 threadId 一致',
      };
    }
    if (!policyAllows(entry.writeDomains, domain, { threadId })) {
      return allowed('策略未授权写入当前任务域', { allowedDomain: 'default' });
    }
    return { allowed: true, code: null, reason: null };
  }
  if (domain === 'default' || domain === 'shared') {
    return policyAllows(entry.writeDomains, domain)
      ? { allowed: true, code: null, reason: null }
      : allowed(`策略未授权写入 ${domain} 域`, { allowedDomain: agentDomain(agentId) });
  }
  // 0.2 显式 Other 域：必须由本地策略显式授权。
  return policyAllows(entry.writeDomains, domain)
    ? { allowed: true, code: null, reason: null }
    : allowed('策略未授权写入该显式域', { allowedDomain: 'default' });
}

/** 策略里是否可以写 user 域（还需 confirmation=explicit）。 */
export function policyAllowsUserWrite(policy: SidecarPolicy | null | undefined, agentId: string): boolean {
  const entry = policyForAgent(policy, agentId);
  return policyAllows(entry.writeDomains, 'user');
}
