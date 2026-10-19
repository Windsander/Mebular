// S1 · 安全三档 core 机制（R1-1 … R1-12）。
//
// 规格：T/opencode/security-tiers/SECURITY-TIERS-SPEC.md v1.1 §6.1。
// 本套件先红后绿：纯推导用例直接构造 ParsedEntry（不依赖加密），
// 另有一组真实 Ed25519 证书/签名的预检用例（GraphNamespacePolicy）。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import {
  GraphNamespacePolicy,
  derivePolicyState,
  securityActionDigest,
  pairingCodeForDigest,
  canonicalCosignProofData,
  canonicalBreakGlassProofData,
  POLICY_NAMESPACE,
  SECURITY_TIER_EVENT,
  SECURITY_APPROVAL_EVENT,
  SECURITY_RECOVERY_EVENT,
  DEVICE_REVOKE_EVENT,
  NAMESPACE_GRANT_EVENT,
  type CosignProof,
  type BreakGlassProof,
  type SecurityApprovalRecord,
  type SecurityRecoveryRecord,
  type SecurityTierRecord,
  type SecurityRejectionReason,
  type NamespaceGrantRecord,
  type DeviceRevokeRecord,
  type NamespaceMembershipRecord,
} from '../../src/sync/grantPolicy.js';
import { Mebular } from '../../src/mebular.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
  type TestIdentity,
} from '../p2p/helpers.js';

type Entries = Parameters<typeof derivePolicyState>[0];
type Entry = Entries[number];
type EntryInput = Omit<Entry, 'seq' | 'logical'>;

let seq = 0;
function E(partial: EntryInput): Entry {
  seq += 1;
  return { ...partial, seq, logical: seq } as Entry;
}

function resetSeq(): void {
  seq = 0;
}

function withProofFlags(entry: Entry): Entry {
  const record =
    entry.tier ?? entry.device ?? entry.grant ?? entry.membership ?? entry.recovery;
  if (record && 'cosign' in record && record.cosign && entry.cosignWellFormed === undefined) {
    entry.cosignWellFormed = true;
  }
  if (record && 'breakGlass' in record && record.breakGlass && entry.breakGlassWellFormed === undefined) {
    entry.breakGlassWellFormed = true;
  }
  return entry;
}

function grant(author: string, subject: string, namespaces: string[], extra: Partial<NamespaceGrantRecord> = {}): Entry {
  return withProofFlags(
    E({
      kind: 'grant',
      author,
      id: extra.grantId ?? `g-${author}-${subject}-${seq + 1}`,
      grant: { grantId: extra.grantId ?? `G-${author}-${subject}-${seq + 1}`, subject, namespaces, issuedAt: seq + 1, ...extra },
    }),
  );
}

function deviceRevoke(author: string, subject: string, extra: Partial<DeviceRevokeRecord> = {}): Entry {
  return withProofFlags(
    E({
      kind: 'device',
      author,
      id: `d-${author}-${subject}-${seq + 1}`,
      device: { subject, issuedAt: seq + 1, ...extra },
    }),
  );
}

function membership(author: string, member: string, namespace: string, extra: Partial<NamespaceMembershipRecord> = {}): Entry {
  return withProofFlags(
    E({
      kind: 'membership',
      author,
      id: `m-${author}-${member}-${seq + 1}`,
      membership: { member, namespace, active: true, issuedAt: seq + 1, ...extra },
    }),
  );
}

function tier(author: string, level: SecurityTierRecord['level'], extra: Partial<SecurityTierRecord> = {}): Entry {
  return withProofFlags(
    E({
      kind: 'tier',
      author,
      id: `t-${author}-${level}-${seq + 1}`,
      tier: { level, nonce: `tn-${author}-${level}-${seq + 1}`, issuedAt: seq + 1, ...extra },
    }),
  );
}

function recovery(author: string, record: SecurityRecoveryRecord): Entry {
  return withProofFlags(E({ kind: 'recovery', author, id: `rec-${record.keyId}-${seq + 1}`, recovery: record }));
}

function cosign(opts: {
  op: CosignProof['op'];
  approver: string;
  approvalId: string;
  digest: string;
  wellFormed?: boolean;
}): { proof: CosignProof; wellFormed: boolean } {
  return {
    proof: {
      v: 1,
      op: opts.op,
      approver: opts.approver,
      approverCertificateChain: [],
      approvalId: opts.approvalId,
      digest: opts.digest,
      pairingCode: pairingCodeForDigest(opts.digest),
      issuedAt: 1,
      expiresAt: 2,
      signature: 'pure-test',
    },
    wellFormed: opts.wellFormed ?? true,
  };
}

function breakGlass(opts: {
  op: BreakGlassProof['op'];
  keyId: string;
  digest: string;
  nonce: string;
  wellFormed?: boolean;
}): { proof: BreakGlassProof; wellFormed: boolean } {
  return {
    proof: {
      v: 1,
      op: opts.op,
      keyId: opts.keyId,
      digest: opts.digest,
      nonce: opts.nonce,
      issuedAt: 1,
      expiresAt: 2,
      signature: 'pure-test',
    },
    wellFormed: opts.wellFormed ?? true,
  };
}

function approvalEntry(opts: {
  author: string;
  approvalId: string;
  op: SecurityApprovalRecord['op'];
  initiator: string;
  target?: string;
  namespace?: string;
  level?: SecurityApprovalRecord['level'];
  nonce: string;
  digest: string;
  wellFormed?: boolean;
}): Entry {
  const record: SecurityApprovalRecord = {
    approvalId: opts.approvalId,
    op: opts.op,
    decision: 'approve',
    initiator: opts.initiator,
    nonce: opts.nonce,
    digest: opts.digest,
    pairingCode: pairingCodeForDigest(opts.digest),
    expiresAt: 2,
    issuedAt: 1,
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
    ...(opts.level !== undefined ? { level: opts.level } : {}),
    cosign: {
      v: 1,
      op: opts.op,
      approver: opts.author,
      approverCertificateChain: [],
      approvalId: opts.approvalId,
      digest: opts.digest,
      pairingCode: pairingCodeForDigest(opts.digest),
      issuedAt: 1,
      expiresAt: 2,
      signature: 'pure-test',
    },
  };
  return E({
    kind: 'approval',
    author: opts.author,
    id: `ap-${opts.approvalId}`,
    approval: record,
    approvalCosignWellFormed: opts.wellFormed ?? true,
  });
}

function kickProof(opts: {
  approver: string;
  approvalId: string;
  initiator: string;
  subject: string;
  nonce: string;
  wellFormed?: boolean;
}): { proof: CosignProof; digest: string; wellFormed: boolean } {
  const digest = securityActionDigest({
    op: 'kick',
    initiator: opts.initiator,
    subject: opts.subject,
    nonce: opts.nonce,
  });
  const built = cosign({ op: 'kick', approver: opts.approver, approvalId: opts.approvalId, digest, wellFormed: opts.wellFormed });
  return { proof: built.proof, digest, wellFormed: built.wellFormed };
}

/** 低档既成成员：D（bootstrap）授予 E/F/X 授权，随后 D 升到 high。 */
function highBase(options: { includeX?: boolean } = {}): Entries {
  return [
    grant('D', 'E', ['nsA']),
    grant('D', 'F', ['nsA']),
    ...(options.includeX ? [grant('D', 'X', ['nsA'])] : []),
    tier('D', 'high'),
  ];
}

function derive(entries: Entries) {
  return derivePolicyState(entries, { policyIssuers: ['D'] });
}

function json(state: ReturnType<typeof derivePolicyState>) {
  const authorized: Record<string, string[]> = {};
  for (const key of [...state.authorized.keys()].sort()) authorized[key] = [...state.authorized.get(key)!].sort();
  const members: Record<string, string[]> = {};
  for (const key of [...state.members.keys()].sort()) members[key] = [...state.members.get(key)!].sort();
  return {
    authorized,
    revoked: [...state.revoked].sort(),
    issuers: [...state.issuers].sort(),
    members,
    membershipNamespaces: [...state.membershipNamespaces].sort(),
  };
}

function reasonsOf(state: ReturnType<typeof derivePolicyState>): string[] {
  return (state.security?.rejections ?? []).map((r) => r.reason);
}

describe('R1 · 安全等级 core（SPEC §6.1）', () => {
  it('R1-1 无 tier = low；medium 生效；R-c 最新胜出（乱序/幂等）', () => {
    resetSeq();
    const none = derive([]);
    expect(none.security?.level ?? 'low').toBe('low');

    const medium = derive([tier('D', 'medium')]);
    expect(medium.security?.level).toBe('medium');

    const entries = [tier('D', 'medium'), tier('D', 'high')];
    const state = derive(entries);
    expect(state.security?.level).toBe('high');
    expect(derive([...entries].reverse()).security?.level).toBe('high');
    expect(json(derive(entries))).toEqual(json(state));
  });

  it('R1-2 被吊销签发者的 tier 记录不采纳（R-b 含历史）', () => {
    resetSeq();
    const state = derive([tier('E', 'medium'), deviceRevoke('D', 'E')]);
    expect(state.revoked.has('E')).toBe(true);
    expect(state.security?.level).toBe('low');
  });

  it('R1-3 降级逃逸：无证明不采纳；有效 cosign 采纳；各失败原因归因', () => {
    resetSeq();
    // 红：high 下裸降级
    const bare = derive([...highBase(), tier('D', 'medium')]);
    expect(bare.security?.level).toBe('high');
    expect(reasonsOf(bare)).toContain('missing-proof');

    // 绿：有效 cosign
    resetSeq();
    const nonce = 'n-valid';
    const digest = securityActionDigest({ op: 'tier', initiator: 'D', level: 'medium', nonce });
    const okProof = cosign({ op: 'tier', approver: 'E', approvalId: 'ap-ok', digest });
    const ok = derive([
      ...highBase(),
      approvalEntry({
        author: 'E',
        approvalId: 'ap-ok',
        op: 'tier',
        initiator: 'D',
        level: 'medium',
        nonce,
        digest,
      }),
      E({
        kind: 'tier',
        author: 'D',
        id: 'tier-ok',
        tier: { level: 'medium', nonce, issuedAt: 10, cosign: okProof.proof },
        cosignWellFormed: okProof.wellFormed,
      }),
    ]);
    expect(ok.security?.level).toBe('medium');

    // 证明无效
    resetSeq();
    const badProof = cosign({ op: 'tier', approver: 'E', approvalId: 'ap-bad', digest, wellFormed: false });
    const invalid = derive([
      ...highBase(),
      approvalEntry({ author: 'E', approvalId: 'ap-bad', op: 'tier', initiator: 'D', level: 'medium', nonce, digest }),
      E({
        kind: 'tier',
        author: 'D',
        id: 'tier-bad',
        tier: { level: 'medium', nonce, issuedAt: 10, cosign: badProof.proof },
        cosignWellFormed: false,
      }),
    ]);
    expect(invalid.security?.level).toBe('high');
    expect(reasonsOf(invalid)).toContain('invalid-proof');

    // 批准缺失 / 非因果序
    resetSeq();
    const missing = derive([
      ...highBase(),
      E({
        kind: 'tier',
        author: 'D',
        id: 'tier-missing',
        tier: { level: 'medium', nonce, issuedAt: 10, cosign: okProof.proof },
        cosignWellFormed: true,
      }),
    ]);
    expect(missing.security?.level).toBe('high');
    expect(reasonsOf(missing)).toContain('approval-missing-or-not-causal');

    // approver = author
    resetSeq();
    const selfDigest = securityActionDigest({ op: 'tier', initiator: 'D', level: 'medium', nonce: 'n-self' });
    const selfProof = cosign({ op: 'tier', approver: 'D', approvalId: 'ap-self', digest: selfDigest });
    const self = derive([
      ...highBase(),
      approvalEntry({
        author: 'D',
        approvalId: 'ap-self',
        op: 'tier',
        initiator: 'D',
        level: 'medium',
        nonce: 'n-self',
        digest: selfDigest,
      }),
      E({
        kind: 'tier',
        author: 'D',
        id: 'tier-self',
        tier: { level: 'medium', nonce: 'n-self', issuedAt: 10, cosign: selfProof.proof },
        cosignWellFormed: true,
      }),
    ]);
    expect(self.security?.level).toBe('high');
    expect(reasonsOf(self)).toContain('approver-equals-author');

    // approver 位次已被吊销
    resetSeq();
    const revokedDigest = securityActionDigest({ op: 'tier', initiator: 'D', level: 'medium', nonce: 'n-rev' });
    const revokedProof = cosign({ op: 'tier', approver: 'E', approvalId: 'ap-rev', digest: revokedDigest });
    const revokedAtOrder = derive([
      grant('D', 'E', ['nsA']),
      deviceRevoke('D', 'E'),
      tier('D', 'high'),
      approvalEntry({
        author: 'E',
        approvalId: 'ap-rev',
        op: 'tier',
        initiator: 'D',
        level: 'medium',
        nonce: 'n-rev',
        digest: revokedDigest,
      }),
      E({
        kind: 'tier',
        author: 'D',
        id: 'tier-rev',
        tier: { level: 'medium', nonce: 'n-rev', issuedAt: 10, cosign: revokedProof.proof },
        cosignWellFormed: true,
      }),
    ]);
    expect(revokedAtOrder.security?.level).toBe('high');
    expect(reasonsOf(revokedAtOrder)).toContain('approval-approver-revoked-at-its-order');

    // approver 未准入
    resetSeq();
    const notAdmittedDigest = securityActionDigest({ op: 'tier', initiator: 'D', level: 'medium', nonce: 'n-na' });
    const notAdmittedProof = cosign({ op: 'tier', approver: 'Z', approvalId: 'ap-na', digest: notAdmittedDigest });
    const notAdmitted = derive([
      ...highBase(),
      approvalEntry({
        author: 'Z',
        approvalId: 'ap-na',
        op: 'tier',
        initiator: 'D',
        level: 'medium',
        nonce: 'n-na',
        digest: notAdmittedDigest,
      }),
      E({
        kind: 'tier',
        author: 'D',
        id: 'tier-na',
        tier: { level: 'medium', nonce: 'n-na', issuedAt: 10, cosign: notAdmittedProof.proof },
        cosignWellFormed: true,
      }),
    ]);
    expect(notAdmitted.security?.level).toBe('high');
    expect(reasonsOf(notAdmitted)).toContain('approver-not-admitted-at-approval');
  });

  it('R1-4 medium → low：网络侧无证明要求，照常采纳', () => {
    resetSeq();
    const state = derive([tier('D', 'medium'), tier('D', 'low')]);
    expect(state.security?.level).toBe('low');
    expect(reasonsOf(state)).toHaveLength(0);
  });

  it('R1-5 device_revoke @high：无证明不采纳；有效 cosign 采纳；approver=subject / nonce 重放不采纳', () => {
    resetSeq();
    const bare = derive([...highBase({ includeX: true }), deviceRevoke('D', 'X')]);
    expect(bare.revoked.has('X')).toBe(false);
    expect(reasonsOf(bare)).toContain('missing-proof');

    resetSeq();
    const nonce = 'kick-1';
    const built = kickProof({ approver: 'E', approvalId: 'ap-kick', initiator: 'D', subject: 'X', nonce });
    const ok = derive([
      ...highBase({ includeX: true }),
      approvalEntry({
        author: 'E',
        approvalId: 'ap-kick',
        op: 'kick',
        initiator: 'D',
        target: 'X',
        nonce,
        digest: built.digest,
      }),
      deviceRevoke('D', 'X', { nonce, cosign: built.proof }),
    ]);
    expect(ok.revoked.has('X')).toBe(true);

    // approver = subject
    resetSeq();
    const subjNonce = 'kick-subject';
    const subjBuilt = kickProof({ approver: 'X', approvalId: 'ap-subject', initiator: 'D', subject: 'X', nonce: subjNonce });
    const subj = derive([
      ...highBase({ includeX: true }),
      approvalEntry({
        author: 'X',
        approvalId: 'ap-subject',
        op: 'kick',
        initiator: 'D',
        target: 'X',
        nonce: subjNonce,
        digest: subjBuilt.digest,
      }),
      deviceRevoke('D', 'X', { nonce: subjNonce, cosign: subjBuilt.proof }),
    ]);
    expect(subj.revoked.has('X')).toBe(false);
    expect(reasonsOf(subj)).toContain('approver-equals-subject');

    // 同一 nonce 重放（不同动作）
    resetSeq();
    const replayNonce = 'kick-replay';
    const first = kickProof({ approver: 'E', approvalId: 'ap-r1', initiator: 'D', subject: 'X', nonce: replayNonce });
    const second = kickProof({ approver: 'E', approvalId: 'ap-r2', initiator: 'D', subject: 'F', nonce: replayNonce });
    const replay = derive([
      ...highBase({ includeX: true }),
      approvalEntry({ author: 'E', approvalId: 'ap-r1', op: 'kick', initiator: 'D', target: 'X', nonce: replayNonce, digest: first.digest }),
      deviceRevoke('D', 'X', { nonce: replayNonce, cosign: first.proof }),
      approvalEntry({ author: 'E', approvalId: 'ap-r2', op: 'kick', initiator: 'D', target: 'F', nonce: replayNonce, digest: second.digest }),
      deviceRevoke('D', 'F', { nonce: replayNonce, cosign: second.proof }),
    ]);
    expect(replay.revoked.has('X')).toBe(true);
    expect(replay.revoked.has('F')).toBe(false);
    expect(reasonsOf(replay)).toContain('stale-or-replayed-nonce');
  });

  it('R1-6 首现验收：@high 新设备无证明不采纳且不 admitted；带证明采纳；历史成员不回溯', () => {
    resetSeq();
    const bare = derive([...highBase({ includeX: true }), membership('Y', 'Y', 'nsA')]);
    expect(bare.members.get('nsA')?.has('Y') ?? false).toBe(false);
    expect(bare.security?.admitted).not.toContain('Y');
    expect(reasonsOf(bare)).toContain('missing-proof');

    // 带会签的首现：Y 进入 admitted
    resetSeq();
    const joinNonce = 'join-1';
    const digest = securityActionDigest({ op: 'join', initiator: 'D', namespace: 'nsA', nonce: joinNonce });
    const proof = cosign({ op: 'join', approver: 'E', approvalId: 'ap-join', digest });
    const joined = derive([
      ...highBase({ includeX: true }),
      approvalEntry({
        author: 'E',
        approvalId: 'ap-join',
        op: 'join',
        initiator: 'D',
        target: 'Y',
        namespace: 'nsA',
        nonce: joinNonce,
        digest,
      }),
      membership('Y', 'Y', 'nsA', { nonce: joinNonce, cosign: proof.proof }),
    ]);
    expect(joined.members.get('nsA')?.has('Y') ?? false).toBe(true);
    expect(joined.security?.admitted).toContain('Y');

    // 历史成员 X 在 high 之后的新记录不回溯要求会签
    resetSeq();
    const historical = derive([
      ...highBase({ includeX: true }),
      grant('D', 'X', ['nsB']),
    ]);
    expect(historical.authorized.get('X')).toEqual(['nsA', 'nsB']);
    expect(historical.security?.rejections ?? []).toHaveLength(0);

    // grant 首现路径：裸 grant 不采纳且不 admitted；带会签 grant 采纳后
    // Y 可作为 R-a 授权方继续转授（候选集/过滤集不振荡）。
    resetSeq();
    const bareGrant = derive([...highBase(), grant('D', 'Y', ['nsA']), grant('Y', 'Z', ['nsA'])]);
    expect(bareGrant.converged).toBe(true);
    expect(bareGrant.authorized.has('Y')).toBe(false);
    expect(bareGrant.authorized.has('Z')).toBe(false);
    expect(bareGrant.security?.admitted).not.toContain('Y');
    expect(reasonsOf(bareGrant)).toContain('missing-proof');

    resetSeq();
    const grantJoinNonce = 'join-grant';
    const grantJoinDigest = securityActionDigest({
      op: 'join',
      initiator: 'D',
      namespace: 'nsA',
      nonce: grantJoinNonce,
    });
    const grantJoinProof = cosign({
      op: 'join',
      approver: 'E',
      approvalId: 'ap-join-grant',
      digest: grantJoinDigest,
    });
    const granted = derive([
      ...highBase(),
      approvalEntry({
        author: 'E',
        approvalId: 'ap-join-grant',
        op: 'join',
        initiator: 'D',
        target: 'Y',
        namespace: 'nsA',
        nonce: grantJoinNonce,
        digest: grantJoinDigest,
      }),
      grant('D', 'Y', ['nsA'], { nonce: grantJoinNonce, cosign: grantJoinProof.proof }),
    ]);
    expect(granted.converged).toBe(true);
    expect(granted.security?.admitted).toContain('Y');
    expect(granted.authorized.get('Y')).toEqual(['nsA']);
  });

  it('R1-7 恢复码：登记 → 使用（nonce 一次）→ 轮换；旧 key 新签名不采纳', () => {
    resetSeq();
    const k1 = 'K1';
    const k2 = 'K2';
    const key1 = { keyId: k1, publicKey: 'pub-k1', createdAt: 1, mode: 'set' as const };
    const kickNonce = 'bg-kick';
    const kickDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce: kickNonce });
    const bg = breakGlass({ op: 'kick', keyId: k1, digest: kickDigest, nonce: kickNonce });
    const used = derive([
      recovery('D', key1),
      tier('D', 'high'),
      deviceRevoke('D', 'X', { nonce: kickNonce, breakGlass: bg.proof }),
    ]);
    expect(used.revoked.has('X')).toBe(true);
    expect(used.security?.recoveryKeyId).toBe(k1);

    // 同一 nonce 重放（不同动作）→ 拒绝
    const replayDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'F', nonce: kickNonce });
    const replayBg = breakGlass({ op: 'kick', keyId: k1, digest: replayDigest, nonce: kickNonce });
    const replay = derive([
      recovery('D', key1),
      tier('D', 'high'),
      deviceRevoke('D', 'X', { nonce: kickNonce, breakGlass: bg.proof }),
      deviceRevoke('D', 'F', { nonce: kickNonce, breakGlass: replayBg.proof }),
    ]);
    expect(replay.revoked.has('F')).toBe(false);
    expect(reasonsOf(replay)).toContain('stale-or-replayed-nonce');

    // 轮换：旧码签 rotate → 新 key 生效
    const rotateNonce = 'bg-rotate';
    const rotateDigest = securityActionDigest({
      op: 'rotate',
      initiator: 'D',
      oldKeyId: k1,
      newPublicKey: 'pub-k2',
      nonce: rotateNonce,
    });
    const rotateBg = breakGlass({ op: 'rotate', keyId: k1, digest: rotateDigest, nonce: rotateNonce });
    const rotated = derive([
      recovery('D', key1),
      tier('D', 'high'),
      recovery('D', {
        keyId: k2,
        publicKey: 'pub-k2',
        createdAt: 2,
        mode: 'rotate',
        nonce: rotateNonce,
        breakGlass: rotateBg.proof,
      }),
    ]);
    expect(rotated.security?.recoveryKeyId).toBe(k2);

    // 轮换后旧 key 的新签名不采纳
    const oldNonce = 'bg-old';
    const oldDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'Z', nonce: oldNonce });
    const oldBg = breakGlass({ op: 'kick', keyId: k1, digest: oldDigest, nonce: oldNonce });
    const afterRotate = derive([
      recovery('D', key1),
      tier('D', 'high'),
      recovery('D', {
        keyId: k2,
        publicKey: 'pub-k2',
        createdAt: 2,
        mode: 'rotate',
        nonce: rotateNonce,
        breakGlass: rotateBg.proof,
      }),
      deviceRevoke('D', 'Z', { nonce: oldNonce, breakGlass: oldBg.proof }),
    ]);
    expect(afterRotate.revoked.has('Z')).toBe(false);
    expect(afterRotate.security?.recoveryKeyId).toBe(k2);
    expect(reasonsOf(afterRotate)).toContain('invalid-proof');
  });

  it('R1-8 拒绝诊断：§3.4E 枚举的 reason 均出现在 PolicyState.security.rejections', () => {
    const seen = new Set<string>();
    const collect = (state: ReturnType<typeof derivePolicyState>) => {
      for (const reason of reasonsOf(state)) seen.add(reason);
    };

    // missing-proof / approval-missing-or-not-causal
    resetSeq();
    collect(derive([...highBase(), deviceRevoke('D', 'X')]));
    const nonce = 'r8';
    const digest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce });
    const proof = cosign({ op: 'kick', approver: 'E', approvalId: 'ap-r8-missing', digest });
    resetSeq();
    collect(
      derive([
        ...highBase(),
        deviceRevoke('D', 'X', { nonce, cosign: proof.proof }),
      ]),
    );

    // invalid-proof
    resetSeq();
    const badBase = highBase();
    const bad = cosign({ op: 'kick', approver: 'E', approvalId: 'ap-r8-bad', digest, wellFormed: false });
    const badApproval = approvalEntry({
      author: 'E',
      approvalId: 'ap-r8-bad',
      op: 'kick',
      initiator: 'D',
      target: 'X',
      nonce,
      digest,
    });
    const badKick = deviceRevoke('D', 'X', { nonce, cosign: bad.proof });
    badKick.cosignWellFormed = false;
    collect(derive([...badBase, badApproval, badKick]));

    // approver-equals-author
    resetSeq();
    const selfDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce: 'r8-self' });
    const selfProof = cosign({ op: 'kick', approver: 'D', approvalId: 'ap-r8-self', digest: selfDigest });
    collect(
      derive([
        ...highBase(),
        approvalEntry({ author: 'D', approvalId: 'ap-r8-self', op: 'kick', initiator: 'D', target: 'X', nonce: 'r8-self', digest: selfDigest }),
        deviceRevoke('D', 'X', { nonce: 'r8-self', cosign: selfProof.proof }),
      ]),
    );

    // approver-equals-subject
    resetSeq();
    const subjDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce: 'r8-subj' });
    const subjProof = cosign({ op: 'kick', approver: 'X', approvalId: 'ap-r8-subj', digest: subjDigest });
    collect(
      derive([
        ...highBase({ includeX: true }),
        approvalEntry({ author: 'X', approvalId: 'ap-r8-subj', op: 'kick', initiator: 'D', target: 'X', nonce: 'r8-subj', digest: subjDigest }),
        deviceRevoke('D', 'X', { nonce: 'r8-subj', cosign: subjProof.proof }),
      ]),
    );

    // approval-approver-revoked-at-its-order
    resetSeq();
    const revDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce: 'r8-rev' });
    const revProof = cosign({ op: 'kick', approver: 'E', approvalId: 'ap-r8-rev', digest: revDigest });
    collect(
      derive([
        grant('D', 'E', ['nsA']),
        deviceRevoke('D', 'E'),
        tier('D', 'high'),
        approvalEntry({ author: 'E', approvalId: 'ap-r8-rev', op: 'kick', initiator: 'D', target: 'X', nonce: 'r8-rev', digest: revDigest }),
        deviceRevoke('D', 'X', { nonce: 'r8-rev', cosign: revProof.proof }),
      ]),
    );

    // approver-not-admitted-at-approval
    resetSeq();
    const naDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce: 'r8-na' });
    const naProof = cosign({ op: 'kick', approver: 'Z', approvalId: 'ap-r8-na', digest: naDigest });
    collect(
      derive([
        ...highBase(),
        approvalEntry({ author: 'Z', approvalId: 'ap-r8-na', op: 'kick', initiator: 'D', target: 'X', nonce: 'r8-na', digest: naDigest }),
        deviceRevoke('D', 'X', { nonce: 'r8-na', cosign: naProof.proof }),
      ]),
    );

    // stale-or-replayed-nonce
    resetSeq();
    const replayNonce = 'r8-replay';
    const r1 = kickProof({ approver: 'E', approvalId: 'ap-r8-r1', initiator: 'D', subject: 'X', nonce: replayNonce });
    const r2 = kickProof({ approver: 'E', approvalId: 'ap-r8-r2', initiator: 'D', subject: 'F', nonce: replayNonce });
    collect(
      derive([
        ...highBase({ includeX: true }),
        approvalEntry({ author: 'E', approvalId: 'ap-r8-r1', op: 'kick', initiator: 'D', target: 'X', nonce: replayNonce, digest: r1.digest }),
        deviceRevoke('D', 'X', { nonce: replayNonce, cosign: r1.proof }),
        approvalEntry({ author: 'E', approvalId: 'ap-r8-r2', op: 'kick', initiator: 'D', target: 'F', nonce: replayNonce, digest: r2.digest }),
        deviceRevoke('D', 'F', { nonce: replayNonce, cosign: r2.proof }),
      ]),
    );

    const expected: SecurityRejectionReason[] = [
      'missing-proof',
      'invalid-proof',
      'approval-missing-or-not-causal',
      'approval-approver-revoked-at-its-order',
      'approver-not-admitted-at-approval',
      'approver-equals-author',
      'approver-equals-subject',
      'stale-or-replayed-nonce',
    ];
    for (const reason of expected) expect(seen.has(reason)).toBe(true);
  });

  it('R1-9 纯旧记录：推导结果与基线 golden 逐字节一致，且不出现 security 子对象', () => {
    resetSeq();
    const entries: Entries = [
      E({ kind: 'grant', author: 'issuer', id: 'g1', grant: { grantId: 'G1', subject: 'A', namespaces: ['nsA'], issuedAt: 1 } }),
      E({ kind: 'grant', author: 'issuer', id: 'g2', grant: { grantId: 'G2', subject: 'B', namespaces: ['nsB'], issuedAt: 2 } }),
      E({ kind: 'issuer', author: 'issuer', id: 'i1', issuer: { subject: 'A', issuedAt: 3 } }),
      E({ kind: 'revoke', author: 'issuer', id: 'r1', revoke: { grantId: 'G2', subject: 'B', issuedAt: 4 } }),
      E({ kind: 'device', author: 'issuer', id: 'd1', device: { subject: 'B', issuedAt: 5 } }),
      E({ kind: 'grant', author: 'A', id: 'g3', grant: { grantId: 'G3', subject: 'B', namespaces: ['nsA'], issuedAt: 6 } }),
      E({ kind: 'membership', author: 'issuer', id: 'm1', membership: { member: 'B', namespace: 'nsA', active: true, issuedAt: 7 } }),
      E({ kind: 'device', author: 'issuer', id: 'd2', device: { subject: 'A', issuedAt: 8 } }),
      E({ kind: 'grant', author: 'issuer', id: 'g4', grant: { grantId: 'G4', subject: 'C', namespaces: ['nsA'], issuedAt: 9 } }),
    ];
    const state = derivePolicyState(entries, { policyIssuers: ['issuer'] });
    const actual = {
      ...json(state),
      converged: state.converged,
      iterations: state.iterations,
    };
    expect(actual).toEqual({
      authorized: { C: ['nsA'] },
      revoked: ['A', 'B'],
      issuers: ['issuer'],
      members: {},
      membershipNamespaces: [],
      converged: true,
      iterations: 3,
    });
    expect(state.security).toBeUndefined();
  });

  it('R1-10 文档同步：POLICY-INVARIANTS / SEALING / 护栏四件套含安全等级条目', () => {
    const invariants = readFileSync('src/sync/POLICY-INVARIANTS.md', 'utf-8');
    const sealing = readFileSync('SEALING_CN.md', 'utf-8');
    const silent = readFileSync('src/sync/guardrails/SILENT-POINTS.md', 'utf-8');
    const symmetry = readFileSync('src/sync/guardrails/SYMMETRY-CHECKLIST.md', 'utf-8');
    const mixed = readFileSync('src/sync/guardrails/MIXED-VERSION-POLICY.md', 'utf-8');
    const matrix = readFileSync('src/sync/guardrails/TEST-MATRIX.md', 'utf-8');

    for (const text of [invariants, sealing, mixed]) expect(text).toContain('security_tier');
    expect(invariants).toContain('admitted');
    expect(invariants).toContain('approval-missing-or-not-causal');
    expect(sealing).toContain('cosign');
    expect(silent).toContain('security.rejections');
    expect(symmetry).toContain('会签');
    expect(matrix).toContain('R1-');
  });

  it('R1-11 无墙钟：expiresAt 已过去的有效证明仍被采纳；重复推导恒等', () => {
    resetSeq();
    const nonce = 'expired-ok';
    const digest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce });
    const proof = cosign({ op: 'kick', approver: 'E', approvalId: 'ap-exp', digest });
    proof.proof.expiresAt = 1; // 1970 年，早已过期
    const entries = [
      ...highBase({ includeX: true }),
      approvalEntry({
        author: 'E',
        approvalId: 'ap-exp',
        op: 'kick',
        initiator: 'D',
        target: 'X',
        nonce,
        digest,
      }),
      deviceRevoke('D', 'X', { nonce, cosign: proof.proof }),
    ];
    (entries[entries.length - 1] as Entry).cosignWellFormed = true;
    // 批准记录也已过期
    const approval = entries.find((entry) => entry.kind === 'approval');
    if (approval?.approval) approval.approval.expiresAt = 1;

    const first = derive(entries);
    expect(first.revoked.has('X')).toBe(true);
    const second = derive(entries);
    expect(json(second)).toEqual(json(first));
    expect(second.security).toEqual(first.security);
  });

  it('R1-12 批准人事后吊销不回撤；其新批准不再有效', () => {
    resetSeq();
    const kickNonce = 'after-revoke-1';
    const kickDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce: kickNonce });
    const kick = cosign({ op: 'kick', approver: 'E', approvalId: 'ap-after-1', digest: kickDigest });

    const revokeENonce = 'after-revoke-2';
    const revokeEDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'E', nonce: revokeENonce });
    const revokeE = cosign({ op: 'kick', approver: 'F', approvalId: 'ap-after-2', digest: revokeEDigest });

    const newApprovalNonce = 'after-revoke-3';
    const newDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'Y', nonce: newApprovalNonce });
    const newProof = cosign({ op: 'kick', approver: 'E', approvalId: 'ap-after-3', digest: newDigest });

    const state = derive([
      ...highBase({ includeX: true }),
      approvalEntry({ author: 'E', approvalId: 'ap-after-1', op: 'kick', initiator: 'D', target: 'X', nonce: kickNonce, digest: kickDigest }),
      deviceRevoke('D', 'X', { nonce: kickNonce, cosign: kick.proof }),
      approvalEntry({ author: 'F', approvalId: 'ap-after-2', op: 'kick', initiator: 'D', target: 'E', nonce: revokeENonce, digest: revokeEDigest }),
      deviceRevoke('D', 'E', { nonce: revokeENonce, cosign: revokeE.proof }),
      approvalEntry({ author: 'E', approvalId: 'ap-after-3', op: 'kick', initiator: 'D', target: 'Y', nonce: newApprovalNonce, digest: newDigest }),
      deviceRevoke('D', 'Y', { nonce: newApprovalNonce, cosign: newProof.proof }),
    ]);

    expect(state.revoked.has('X')).toBe(true);
    expect(state.revoked.has('E')).toBe(true);
    expect(state.revoked.has('Y')).toBe(false);
    expect(reasonsOf(state)).toContain('approval-approver-revoked-at-its-order');
  });
});

// ---------------------------------------------------------------------------
// 真实密码学预检：cosign / breakGlass 的链锚定、签名、digest；无墙钟。
// ---------------------------------------------------------------------------

interface Device {
  id: string;
  identity: TestIdentity;
  signer: EventSigner;
}

async function makeDevice(master: CryptoKeyPair, id: string): Promise<Device> {
  const identity = await createTestIdentity(id);
  const certificate = await issueCertificate(master.privateKey, identity);
  return {
    id,
    identity,
    signer: {
      deviceId: id,
      privateKey: identity.identity.devicePrivateKey,
      certificate,
    },
  };
}

async function append(
  storage: MemoryStorage,
  device: Device,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const log = await EventLog.restore(storage, device.id, { signer: device.signer });
  await log.append({ type, data, namespace: POLICY_NAMESPACE });
}

async function signCosign(device: Device, input: CosignProof): Promise<CosignProof> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    device.identity.identity.devicePrivateKey,
    new TextEncoder().encode(canonicalCosignProofData(input)),
  );
  return { ...input, signature: Buffer.from(new Uint8Array(signature)).toString('base64') };
}

async function signBreakGlass(privateKey: CryptoKey, input: BreakGlassProof): Promise<BreakGlassProof> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(canonicalBreakGlassProofData(input)),
  );
  return { ...input, signature: Buffer.from(new Uint8Array(signature)).toString('base64') };
}

describe('R1 · cosign / breakGlass 真实预检', () => {
  it('有效 cosign 采纳；篡改签名 → invalid-proof；expiresAt 过去仍采纳（无墙钟）', async () => {
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);
    const storage = new MemoryStorage();
    const D = await makeDevice(master, 'D');
    const E = await makeDevice(master, 'E');

    await append(storage, D, NAMESPACE_GRANT_EVENT, {
      grant: { grantId: 'g-D-E', subject: 'E', namespaces: ['nsA'], issuedAt: 1 },
    });
    await append(storage, D, SECURITY_TIER_EVENT, {
      securityTier: { level: 'high', nonce: 'tier-1', issuedAt: 2 } satisfies SecurityTierRecord,
    });

    const nonce = 'kick-real';
    const digest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce });
    const proof = await signCosign(E, {
      v: 1,
      op: 'kick',
      approver: 'E',
      approverCertificateChain: [E.signer.certificate!],
      approvalId: 'ap-real',
      digest,
      pairingCode: pairingCodeForDigest(digest),
      issuedAt: 1,
      expiresAt: 1, // 早已过期：推导/预检层不得判
      signature: '',
    });
    await append(storage, E, SECURITY_APPROVAL_EVENT, {
      securityApproval: {
        approvalId: 'ap-real',
        op: 'kick',
        decision: 'approve',
        initiator: 'D',
        target: 'X',
        nonce,
        digest,
        pairingCode: pairingCodeForDigest(digest),
        expiresAt: 1,
        issuedAt: 1,
        cosign: proof,
      } satisfies SecurityApprovalRecord,
    });
    await append(storage, D, DEVICE_REVOKE_EVENT, {
      deviceRevoke: { subject: 'X', issuedAt: 3, nonce, cosign: proof } satisfies DeviceRevokeRecord,
    });

    const policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub, policyIssuers: ['D'] });
    const state = await policy.snapshot();
    expect(state.revoked.has('X')).toBe(true);
    expect(state.security?.level).toBe('high');
    expect(state.security?.rejections ?? []).toHaveLength(0);

    // 篡改签名
    const storage2 = new MemoryStorage();
    await append(storage2, D, NAMESPACE_GRANT_EVENT, {
      grant: { grantId: 'g-D-E', subject: 'E', namespaces: ['nsA'], issuedAt: 1 },
    });
    await append(storage2, D, SECURITY_TIER_EVENT, {
      securityTier: { level: 'high', nonce: 'tier-1', issuedAt: 2 } satisfies SecurityTierRecord,
    });
    const tampered = { ...proof, signature: Buffer.from('tampered').toString('base64') };
    await append(storage2, E, SECURITY_APPROVAL_EVENT, {
      securityApproval: {
        approvalId: 'ap-real',
        op: 'kick',
        decision: 'approve',
        initiator: 'D',
        target: 'X',
        nonce,
        digest,
        pairingCode: pairingCodeForDigest(digest),
        expiresAt: 1,
        issuedAt: 1,
        cosign: tampered,
      } satisfies SecurityApprovalRecord,
    });
    await append(storage2, D, DEVICE_REVOKE_EVENT, {
      deviceRevoke: { subject: 'X', issuedAt: 3, nonce, cosign: tampered } satisfies DeviceRevokeRecord,
    });
    const policy2 = new GraphNamespacePolicy({ eventLog: new EventLog(storage2, 'reader'), userMasterPublicKey: masterPub, policyIssuers: ['D'] });
    const state2 = await policy2.snapshot();
    expect(state2.revoked.has('X')).toBe(false);
    expect(state2.security?.rejections.map((r) => r.reason)).toContain('invalid-proof');
  });

  it('breakGlass 真实验签：登记 key → 消费 → 轮换后旧 key 新签名不采纳', async () => {
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);
    const storage = new MemoryStorage();
    const D = await makeDevice(master, 'D');

    const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKeyHex = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))).toString('hex');

    await append(storage, D, SECURITY_RECOVERY_EVENT, {
      securityRecovery: { keyId: 'K1', publicKey: publicKeyHex, createdAt: 1, mode: 'set' } satisfies SecurityRecoveryRecord,
    });
    await append(storage, D, SECURITY_TIER_EVENT, {
      securityTier: { level: 'high', nonce: 'tier-1', issuedAt: 2 } satisfies SecurityTierRecord,
    });

    const nonce = 'bg-real';
    const digest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'X', nonce });
    const proof = await signBreakGlass(keyPair.privateKey, {
      v: 1,
      op: 'kick',
      keyId: 'K1',
      digest,
      nonce,
      issuedAt: 1,
      expiresAt: 1,
      signature: '',
    });
    await append(storage, D, DEVICE_REVOKE_EVENT, {
      deviceRevoke: { subject: 'X', issuedAt: 3, nonce, breakGlass: proof } satisfies DeviceRevokeRecord,
    });

    const policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub, policyIssuers: ['D'] });
    const state = await policy.snapshot();
    expect(state.revoked.has('X')).toBe(true);
    expect(state.security?.recoveryKeyId).toBe('K1');

    // 轮换到 K2，旧 K1 的新签名应被拒
    const keyPair2 = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKeyHex2 = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair2.publicKey))).toString('hex');
    const rotateNonce = 'bg-rotate-real';
    const rotateDigest = securityActionDigest({
      op: 'rotate',
      initiator: 'D',
      oldKeyId: 'K1',
      newPublicKey: publicKeyHex2,
      nonce: rotateNonce,
    });
    const rotateProof = await signBreakGlass(keyPair.privateKey, {
      v: 1,
      op: 'rotate',
      keyId: 'K1',
      digest: rotateDigest,
      nonce: rotateNonce,
      issuedAt: 1,
      expiresAt: 1,
      signature: '',
    });
    await append(storage, D, SECURITY_RECOVERY_EVENT, {
      securityRecovery: {
        keyId: 'K2',
        publicKey: publicKeyHex2,
        createdAt: 2,
        mode: 'rotate',
        nonce: rotateNonce,
        breakGlass: rotateProof,
      } satisfies SecurityRecoveryRecord,
    });

    const oldNonce = 'bg-old-real';
    const oldDigest = securityActionDigest({ op: 'kick', initiator: 'D', subject: 'Z', nonce: oldNonce });
    const oldProof = await signBreakGlass(keyPair.privateKey, {
      v: 1,
      op: 'kick',
      keyId: 'K1',
      digest: oldDigest,
      nonce: oldNonce,
      issuedAt: 1,
      expiresAt: 1,
      signature: '',
    });
    await append(storage, D, DEVICE_REVOKE_EVENT, {
      deviceRevoke: { subject: 'Z', issuedAt: 4, nonce: oldNonce, breakGlass: oldProof } satisfies DeviceRevokeRecord,
    });

    const policy2 = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub, policyIssuers: ['D'] });
    const state2 = await policy2.snapshot();
    expect(state2.security?.recoveryKeyId).toBe('K2');
    expect(state2.revoked.has('Z')).toBe(false);
    expect(state2.security?.rejections.map((r) => r.reason)).toContain('invalid-proof');
  });
});

describe('Mebular.setSecurityTier / getSecurityTier', () => {
  it('写入 tier 记录；get 暴露 level + admitted + rejections（缺省 low）', async () => {
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);
    const home = await mkdtemp(join(tmpdir(), 'mebular-security-'));
    try {
      const app = new Mebular({
        deviceId: 'device-1',
        storagePath: join(home, 'store.json'),
        encryption: {
          userMasterKey: masterPub,
          userMasterPrivateKey: master.privateKey,
        },
      });
      await app.initialize();
      const before = await app.getSecurityTier();
      expect(before.level).toBe('low');
      expect(Array.isArray(before.admitted)).toBe(true);
      expect(before.rejections).toEqual([]);

      await app.setSecurityTier({ level: 'medium', note: 's1' });
      const after = await app.getSecurityTier();
      expect(after.level).toBe('medium');
      expect(after.changedBy).toBe('device-1');
      await app.shutdown();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
