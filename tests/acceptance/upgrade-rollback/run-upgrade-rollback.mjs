#!/usr/bin/env node
// v0.3.2 升级/回滚数据安全演练编排器。
//
// 默认行为：
//   1. 从 git 构建旧版（默认 tag v0.3.0）与当前集成线（默认 HEAD）；
//   2. 在同一个临时 home 上依次运行 旧版 seed → 当前版 upgrade → 旧版 rollback；
//   3. 比较图/事件/文件快照，生成 docs/quality/0.3.2-upgrade-rollback.json
//      与中文报告 docs/quality/0.3.2-upgrade-rollback.md；
//   4. 清理临时构建、home 和 sidecar；不安装全局包、不触碰真实用户 home。
//
// 用法：
//   node tests/acceptance/upgrade-rollback/run-upgrade-rollback.mjs
//   node tests/acceptance/upgrade-rollback/run-upgrade-rollback.mjs --keep
//   node tests/acceptance/upgrade-rollback/run-upgrade-rollback.mjs \
//     --old-ref v0.3.0 --new-ref HEAD --json-out docs/quality/0.3.2-upgrade-rollback.json

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem, arch, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const DRIVER = join(HERE, 'runtime-driver.mjs');
const DEFAULT_JSON = join(REPO, 'docs', 'quality', '0.3.2-upgrade-rollback.json');
const DEFAULT_MD = join(REPO, 'docs', 'quality', '0.3.2-upgrade-rollback.md');

function parseArgs(argv) {
  const out = { keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') out.keep = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const oldRef = String(args['old-ref'] ?? 'v0.3.0');
const newRef = String(args['new-ref'] ?? 'HEAD');
const jsonOut = resolve(REPO, String(args['json-out'] ?? DEFAULT_JSON));
const reportOut = resolve(REPO, String(args['report-out'] ?? DEFAULT_MD));
const workDir = args['work-dir']
  ? resolve(REPO, String(args['work-dir']))
  : await mkdtemp(join(tmpdir(), 'mebular-upgrade-rollback-'));
const home = join(workDir, 'home');
const buildOld = join(workDir, 'build-old');
const buildNew = join(workDir, 'build-new');
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const startedAt = new Date().toISOString();
const commands = [];

function gitSha(ref) {
  return execFileSync('git', ['rev-parse', `${ref}^{commit}`], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function run(label, file, argv, { cwd = REPO, env = {} } = {}) {
  const command = [file, ...argv].join(' ');
  commands.push({ label, command, cwd: cwd === REPO ? '<repo>' : '<temp-build>', at: new Date().toISOString() });
  const started = Date.now();
  const result = spawnSync(file, argv, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    label,
    command,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    elapsedMs: Date.now() - started,
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function mustRun(label, file, argv, options = {}) {
  const result = run(label, file, argv, options);
  if (result.status !== 0) {
    throw new Error(`${label} 失败（exit=${result.status} signal=${result.signal}）：${(result.stderr || result.stdout).slice(-1000)}`);
  }
  return result;
}

async function extract(ref, sha, target) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const tar = join(workDir, `${relative(workDir, target)}.tar`);
  mustRun(`git archive ${ref}`, 'git', ['archive', '--format=tar', `--output=${tar}`, sha]);
  mustRun(`extract ${ref}`, 'tar', ['-xf', tar, '-C', target]);
  await rm(tar, { force: true });
}

function safeMessage(error) {
  return String(error?.message ?? error)
    .replaceAll(process.execPath, '<node>')
    .replaceAll(process.env.HOME ?? '/nonexistent-home', '<real-home>')
    .replaceAll(home, '<temp-home>')
    .replaceAll(workDir, '<temp-work>')
    .replaceAll(REPO, '<repo>');
}

function sanitize(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll(process.execPath, '<node>')
      .replaceAll(process.env.HOME ?? '/nonexistent-home', '<real-home>')
      .replaceAll(home, '<temp-home>')
      .replaceAll(workDir, '<temp-work>')
      .replaceAll(REPO, '<repo>');
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  }
  return value;
}

async function readResult(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`结果文件不可读：${safeMessage(error)}`] };
  }
}

function nodeSignature(snapshot) {
  return JSON.stringify((snapshot?.nodes ?? []).map((node) => [
    node.id,
    node.type,
    node.namespace,
    node.createdAt,
    node.updatedAt,
    node.contentHash,
    node.internalKind,
    node.internalRevision,
  ]));
}

function eventSignature(snapshot) {
  return JSON.stringify((snapshot?.events ?? []).map((event) => [
    event.id,
    event.type,
    event.timestamp,
    event.namespace,
    event.author,
    event.dataHash,
  ]));
}

function missingIds(snapshot, ids) {
  const present = new Set((snapshot?.nodes ?? []).map((node) => node.id));
  return Object.entries(ids)
    .filter(([, id]) => typeof id === 'string' && id.length > 0)
    .filter(([, id]) => !present.has(id))
    .map(([name, id]) => ({ name, id }));
}

function check(name, ok, actual = undefined) {
  return { name, ok: Boolean(ok), ...(actual === undefined ? {} : { actual }) };
}

function buildReport({ oldSha, newSha, stages, checks, cleanup, buildResults, stageRuns }) {
  const seed = stages.seed;
  const upgrade = stages.upgrade;
  const rollback = stages.rollback;
  const upgradeObjects = upgrade?.objects ?? {};
  const allIds = Object.fromEntries(Object.entries(upgradeObjects)
    .filter(([key, value]) => typeof value === 'string' && !['checkpointThreadId', 'selfAgentId'].includes(key)));
  const finalMissing = missingIds(rollback?.snapshotAfter, allIds);
  const noRewrite = {
    seedToUpgradeNodes: nodeSignature(seed?.snapshotAfter) === nodeSignature(upgrade?.snapshotBefore),
    upgradeToRollbackNodes: nodeSignature(upgrade?.snapshotAfter) === nodeSignature(rollback?.snapshotBefore),
    rollbackNodesUnchanged: nodeSignature(rollback?.snapshotBefore) === nodeSignature(rollback?.snapshotAfter),
    seedToUpgradeEvents: eventSignature(seed?.snapshotAfter) === eventSignature(upgrade?.snapshotBefore),
    upgradeToRollbackEvents: eventSignature(upgrade?.snapshotAfter) === eventSignature(rollback?.snapshotBefore),
    rollbackEventsUnchanged: eventSignature(rollback?.snapshotBefore) === eventSignature(rollback?.snapshotAfter),
    upgradeToRollbackFile: upgrade?.fileAfterClose?.sha256 === rollback?.fileAfterClose?.sha256,
    rollbackDidNotRewriteFile: rollback?.fileAfterClose?.mtimeMs === upgrade?.fileAfterClose?.mtimeMs
      && rollback?.fileAfterClose?.sha256 === upgrade?.fileAfterClose?.sha256,
  };
  const dataIntegrity = {
    allOriginalAndCurrentIdsPresentAfterRollback: finalMissing.length === 0,
    missingIds: finalMissing,
    oldDetailTextsIntact: rollback?.checks?.['rollback.detailTextsIntact']?.ok === true,
    oldRecordsReadable: ['user', 'tool', 'doc', 'default'].every((name) => rollback?.checks?.[`rollback.oldRecordReadable.${name}`]?.ok === true),
    currentRecordReadable: rollback?.checks?.['rollback.currentRecordReadable']?.ok === true,
    currentDetailsReadable: rollback?.checks?.['rollback.currentDetailsReadable']?.ok === true,
    oldCheckpointRevisionPresent: rollback?.checks?.['rollback.oldCheckpointRevisionPresent']?.ok === true,
    oldSelfRevisionPresent: rollback?.checks?.['rollback.oldSelfRevisionPresent']?.ok === true,
    latestCheckpointReadable: rollback?.checks?.['rollback.latestCheckpointReadable']?.ok === true,
    latestSelfReadable: rollback?.checks?.['rollback.latestSelfReadable']?.ok === true,
  };
  const internalVisibility = {
    upgradeOldInternalHidden: upgrade?.checks?.['upgrade.internalObjectsHiddenFromMcp']?.ok === true,
    upgradeMemoryGraphBlocked: upgrade?.checks?.['upgrade.memoryGraphInternalHidden']?.ok === true,
    rollbackCurrentInternalHidden: rollback?.checks?.['rollback.currentInternalObjectsHiddenFromMcp']?.ok === true,
  };
  const compatibility = {
    upgradeReadsOldCompact: upgrade?.checks?.['upgrade.oldCompactReadable']?.ok === true,
    upgradeReadsOldCheckpoint: upgrade?.checks?.['upgrade.oldCheckpointReadable']?.ok === true,
    upgradeReadsOldSelf: upgrade?.checks?.['upgrade.oldSelfReadable']?.ok === true,
    oldReadsCurrentCompact: rollback?.compatibility?.oldReadsCurrentCompact === true,
    oldReadsCurrentCheckpoint: rollback?.compatibility?.oldReadsCurrentCheckpoint === true,
    oldReadsCurrentSelf: rollback?.compatibility?.oldReadsCurrentSelf === true,
    oldDetailRetentionClasses: upgrade?.observations?.oldDetailRetentionClasses ?? null,
    oldDetailRetentionDays: upgrade?.observations?.oldDetailRetentionDays ?? null,
    upgradeExpandRaw: upgrade?.checks?.['upgrade.expand.raw']?.ok === true,
    upgradeExpandDefault: upgrade?.checks?.['upgrade.expand.default']?.ok === true,
    currentExpandTool: upgrade?.checks?.['upgrade.expand.tool']?.ok === true,
    currentExpandDoc: upgrade?.checks?.['upgrade.expand.doc']?.ok === true,
    oldRollbackExpandRaw: rollback?.checks?.['rollback.expand.raw']?.ok === true,
    oldRollbackExpandTool: rollback?.checks?.['rollback.expand.tool']?.ok === true,
    oldRollbackExpandDoc: rollback?.checks?.['rollback.expand.doc']?.ok === true,
  };
  const blockers = checks.filter((entry) => !entry.ok).map((entry) => entry.name);
  const status = blockers.length === 0 ? 'pass' : 'blocked';
  return sanitize({
    schema: 'mebular.upgrade-rollback.evidence/1',
    status,
    generatedAt: new Date().toISOString(),
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    refs: {
      old: { ref: oldRef, commit: oldSha },
      new: { ref: newRef, commit: newSha },
      harness: {
        path: relative(REPO, DRIVER),
        commit: execFileSync('git', ['log', '-1', '--format=%H', '--', relative(REPO, DRIVER)], {
          cwd: REPO,
          encoding: 'utf8',
        }).trim() || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
      },
    },
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    },
    build: {
      old: {
        dir: buildOld,
        sha: buildResults.old?.sha ?? null,
        packageVersion: buildResults.old?.packageVersion ?? null,
        matchesRef: buildResults.old?.sha === oldSha,
        npmCi: buildResults.old?.npmCi ?? null,
        build: buildResults.old?.build ?? null,
      },
      new: {
        dir: buildNew,
        sha: buildResults.new?.sha ?? null,
        packageVersion: buildResults.new?.packageVersion ?? null,
        matchesRef: buildResults.new?.sha === newSha,
        npmCi: buildResults.new?.npmCi ?? null,
        build: buildResults.new?.build ?? null,
      },
    },
    commands,
    stages: {
      seed: stageSummary(seed),
      upgrade: stageSummary(upgrade),
      rollback: stageSummary(rollback),
    },
    stageRuns,
    checks,
    dataIntegrity,
    noMigrationRewrite: noRewrite,
    internalVisibility,
    compatibility,
    identities: {
      deviceId: upgrade?.identity?.deviceId ?? null,
      userId: upgrade?.identity?.userId ?? null,
      cloudId: upgrade?.identity?.cloudId ?? null,
      profileId: upgrade?.identity?.profileId ?? null,
      hostId: upgrade?.identity?.hostId ?? null,
    },
    objectIds: allIds,
    snapshots: {
      seed: seed?.snapshotAfter ?? null,
      upgradeBefore: upgrade?.snapshotBefore ?? null,
      upgradeAfter: upgrade?.snapshotAfter ?? null,
      rollbackBefore: rollback?.snapshotBefore ?? null,
      rollbackAfter: rollback?.snapshotAfter ?? null,
    },
    realFakeBoundary: {
      real: [
        '真实 v0.3.0 tag 构建（dist + packages/mcp + packages/memory-runtime）',
        '真实当前集成线 SHA 构建',
        '真实 Mebular app / GraphStore / 事件日志',
        '真实 MCP capability HTTP 服务与真实 MCP Streamable HTTP client',
        '真实 managed sidecar 进程（mebular-memory-runtime）',
        '真实临时文件系统与同一 home 跨版本重启',
        '真实公共 MCP 工具（memory_write / memory_query / memory_graph / memory_status）',
        '真实公共 CLI（mebular memory-runtime status）',
      ],
      fake: [],
      stub: [],
      notCovered: [
        '混版并发运行、双向协议兼容或跨版本同时在线承诺',
        '真实 DSH / Hermes / OpenCode / OpenChamber 宿主进程',
        '真实模型或模型包',
        'P2P / 跨设备同步对端',
        'Console UI 或桌面应用',
        '0.2.4 直升/降级路径（本次演练按任务范围只覆盖 v0.3.0 → 当前集成线；公开 0.2 指南的数据保留说明不等于完整升级/回滚验收）',
      ],
    },
    limitations: [
      '旧版 v0.3.0 的 Detail 写入把 tool_output/document_slice 也存为 conversation retentionClass；当前版读取旧数据时保留原值，不回写，因此旧 detail 的权威到期时间仍约 30 天。当前版新写入的 detail 按 detailKind 使用 7/30/90 天。',
      '旧版 v0.3.0 回滚后，recall 展开 tool_output/document_slice 仍失败（detail_pending_sync）；capability 权威读取仍成功。当前版可展开。',
      '两个构建的 CLI 均不支持 `mebular --version`（返回“未知命令”）；本次记录为公开 CLI 行为差异，不影响 `memory-runtime status`。',
      '当前集成线的 package.json 版本仍为 0.3.0（功能线未 bump 版本号）；本报告用 commit SHA 区分 v0.3.0 tag 与当前集成线，不用版本号区分。',
      '公开 0.2 升级指南的“不强制迁移/数据保留”不等于本报告已验证 0.2.4 → 当前版本；若发布说明要保留该直升承诺，需单独补测。',
      '本演练不承诺混版并发、双向兼容或旧版能理解未来新增对象类型；只验证单一 home 的顺序升级/回滚。',
    ],
    cleanup,
  });
}

function stageSummary(stage) {
  if (!stage) return null;
  return {
    ok: stage.ok === true,
    failedChecks: stage.failedChecks ?? [],
    errors: stage.errors ?? [],
    buildSha: stage.build?.serviceVersion?.sha ?? null,
    packageVersion: stage.build?.packageVersion ?? null,
    identity: stage.identity ?? null,
    checks: stage.checks ?? {},
    objects: stage.objects ?? {},
    snapshotBefore: stage.snapshotBefore ? {
      nodeCount: stage.snapshotBefore.nodes?.length ?? null,
      eventCount: stage.snapshotBefore.events?.length ?? null,
      stateHash: stage.snapshotBefore.status?.stateHash ?? null,
      counts: stage.snapshotBefore.counts ?? null,
      file: stage.snapshotBefore.sidecarConfig ?? null,
    } : null,
    snapshotAfter: stage.snapshotAfter ? {
      nodeCount: stage.snapshotAfter.nodes?.length ?? null,
      eventCount: stage.snapshotAfter.events?.length ?? null,
      stateHash: stage.snapshotAfter.status?.stateHash ?? null,
      counts: stage.snapshotAfter.counts ?? null,
    } : null,
    fileAfterClose: stage.fileAfterClose ?? null,
    sidecarAfterClose: stage.sidecarAfterClose ?? null,
  };
}

function markdown(report) {
  const stageLine = (name, stage) => {
    if (!stage) return `| ${name} | 未运行 | — | — | — |`;
    const checks = Object.entries(stage.checks ?? {});
    const passed = checks.filter(([, value]) => value.ok).length;
    const failed = checks.filter(([, value]) => !value.ok && value.informational !== true).length;
    return `| ${name} | ${stage.ok ? '通过' : '失败'} | ${passed}/${checks.length} | ${failed} | ${stage.failedChecks?.join(', ') || '—'} |`;
  };
  const findChecks = (stage, prefix) => Object.entries(report.stages?.[stage]?.checks ?? {})
    .filter(([name]) => name.startsWith(prefix));
  const c = report.compatibility;
  const d = report.dataIntegrity;
  const n = report.noMigrationRewrite;
  return `# Mebular v0.3.2 升级/回滚数据安全演练

> **状态：** ${report.status === 'pass' ? '通过（无 blocker）' : '失败（存在 blocker）'}。
> **旧版：** \`${report.refs.old.ref}\` = \`${report.refs.old.commit}\`。
> **当前版：** \`${report.refs.new.ref}\` = \`${report.refs.new.commit}\`。
> **运行：** ${report.generatedAt}；runId \`${report.runId}\`。
> **关联契约：** C19（0.3.0 → 0.3.2 升级与数据安全回滚）、§8（真实/fake/skip 边界）。

## 1. 结论摘要

1. 在同一个临时 home 上完成 **旧版 v0.3.0 → 当前集成线 → 旧版 v0.3.0** 的顺序升级与回滚；三个阶段均为 ${report.status === 'pass' ? '通过' : '失败'}。
2. 升级后旧 MemoryRecord、Detail、Compact、ContextCheckpoint、SelfRecord 均可读；公共 MCP 查询、详情展开、checkpoint/self 宿主路径均通过。
3. 回滚后旧数据与当前版新增数据都保留；图节点、事件日志和 \`device.jsonl\` 字节级无迁移重写（见 §5）。
4. 内部对象（Compact / SelfRecord / ContextCheckpoint / DetailRecord）默认不进入公共 MCP 查询；\`memory_graph\` 对内部对象返回显式拒绝。
5. **不承诺混版并发或双向兼容。** 本报告只证明单一 home 的顺序升级/回滚；未覆盖真实宿主、真实模型、P2P 和 Console。

## 2. 证据绑定

| 项目 | 值 |
|---|---|
| 旧版 ref / commit | \`${report.refs.old.ref}\` / \`${report.refs.old.commit}\` |
| 当前版 ref / commit | \`${report.refs.new.ref}\` / \`${report.refs.new.commit}\` |
| 旧版构建 SHA | \`${report.build.old.sha}\`（matchesRef=${report.build.old.matchesRef}） |
| 当前版构建 SHA | \`${report.build.new.sha}\`（matchesRef=${report.build.new.matchesRef}） |
| 构建包版本 | old=\`${report.build.old.packageVersion}\` / new=\`${report.build.new.packageVersion}\` |
| 平台 | ${report.environment.platform} ${report.environment.release} / ${report.environment.arch} |
| CPU / 内存 | ${report.environment.cpu} / ${Math.round(report.environment.memoryBytes / 1024 ** 3)} GiB |
| Node / npm | ${report.environment.node} / ${report.environment.npm} |
| 演练工具 | \`${report.refs.harness.path}\`（driver commit \`${report.refs.harness.commit}\`） |
| 临时 home | \`<temp-home>\`（脚本创建；不接触真实用户 home） |
| 机器可读证据 | \`docs/quality/0.3.2-upgrade-rollback.json\` |

## 3. 真实 / fake 边界

**真实组件：**

${report.realFakeBoundary.real.map((entry) => `- ${entry}`).join('\n')}

**fake / stub：** ${report.realFakeBoundary.fake.length === 0 ? '无' : report.realFakeBoundary.fake.join('；')}。

**未覆盖：**

${report.realFakeBoundary.notCovered.map((entry) => `- ${entry}`).join('\n')}

## 4. 阶段与断言

| 阶段 | 结果 | 通过/总检查 | 非信息性失败 | 失败项 |
|---|---|---:|---:|---|
${stageLine('旧版 seed', report.stages.seed)}
${stageLine('当前版 upgrade', report.stages.upgrade)}
${stageLine('旧版 rollback', report.stages.rollback)}

关键升级断言：

${findChecks('upgrade', 'upgrade.').map(([name, value]) => `- ${value.ok ? '✓' : '✗'} \`${name}\`${value.informational ? '（信息性）' : ''}`).join('\n')}

关键回滚断言：

${findChecks('rollback', 'rollback.').map(([name, value]) => `- ${value.ok ? '✓' : '✗'} \`${name}\`${value.informational ? '（信息性）' : ''}`).join('\n')}

## 5. 数据完整性与无迁移重写

| 断言 | 结果 |
|---|---|
| 旧版节点/事件在 upgrade 打开时未变化 | ${n.seedToUpgradeNodes ? '✓' : '✗'} / ${n.seedToUpgradeEvents ? '✓' : '✗'} |
| upgrade 后节点/事件在 rollback 打开时未变化 | ${n.upgradeToRollbackNodes ? '✓' : '✗'} / ${n.upgradeToRollbackEvents ? '✓' : '✗'} |
| rollback 运行前后节点/事件/文件不变 | ${n.rollbackNodesUnchanged ? '✓' : '✗'} / ${n.rollbackEventsUnchanged ? '✓' : '✗'} / ${n.rollbackDidNotRewriteFile ? '✓' : '✗'} |
| 全部原始与当前版新增对象 ID 仍存在 | ${d.allOriginalAndCurrentIdsPresentAfterRollback ? '✓' : '✗'} |
| 旧 Detail 正文逐字一致 | ${d.oldDetailTextsIntact ? '✓' : '✗'} |
| 旧 checkpoint/self revision 仍存在 | ${d.oldCheckpointRevisionPresent ? '✓' : '✗'} / ${d.oldSelfRevisionPresent ? '✓' : '✗'} |

节点/事件计数：

| 快照 | 节点 | 事件 | stateHash |
|---|---:|---:|---|
| seed 后 | ${report.stages.seed?.snapshotAfter?.nodeCount ?? '—'} | ${report.stages.seed?.snapshotAfter?.eventCount ?? '—'} | \`${report.stages.seed?.snapshotAfter?.stateHash ?? '—'}\` |
| upgrade 前 | ${report.stages.upgrade?.snapshotBefore?.nodeCount ?? '—'} | ${report.stages.upgrade?.snapshotBefore?.eventCount ?? '—'} | \`${report.stages.upgrade?.snapshotBefore?.stateHash ?? '—'}\` |
| upgrade 后 | ${report.stages.upgrade?.snapshotAfter?.nodeCount ?? '—'} | ${report.stages.upgrade?.snapshotAfter?.eventCount ?? '—'} | \`${report.stages.upgrade?.snapshotAfter?.stateHash ?? '—'}\` |
| rollback 前 | ${report.stages.rollback?.snapshotBefore?.nodeCount ?? '—'} | ${report.stages.rollback?.snapshotBefore?.eventCount ?? '—'} | \`${report.stages.rollback?.snapshotBefore?.stateHash ?? '—'}\` |
| rollback 后 | ${report.stages.rollback?.snapshotAfter?.nodeCount ?? '—'} | ${report.stages.rollback?.snapshotAfter?.eventCount ?? '—'} | \`${report.stages.rollback?.snapshotAfter?.stateHash ?? '—'}\` |

## 6. 兼容性观察

| 观察 | 结果 |
|---|---|
| 当前版读取旧 Compact / Checkpoint / Self | ${c.upgradeReadsOldCompact ? '✓' : '✗'} / ${c.upgradeReadsOldCheckpoint ? '✓' : '✗'} / ${c.upgradeReadsOldSelf ? '✓' : '✗'} |
| 旧版回滚后读取当前版 Compact / Checkpoint / Self | ${c.oldReadsCurrentCompact ? '✓' : '✗'} / ${c.oldReadsCurrentCheckpoint ? '✓' : '✗'} / ${c.oldReadsCurrentSelf ? '✓' : '✗'} |
| 旧 Detail retentionClass（升/回滚后） | \`${JSON.stringify(c.oldDetailRetentionClasses)}\` |
| 旧 Detail retentionDays | \`${JSON.stringify(c.oldDetailRetentionDays)}\` |
| 当前版展开 raw / tool / document | ${c.upgradeExpandRaw ? '✓' : '✗'} / ${c.currentExpandTool ? '✓' : '✗'} / ${c.currentExpandDoc ? '✓' : '✗'} |
| 旧版回滚后展开 raw / tool / document | ${c.oldRollbackExpandRaw ? '✓' : '✗'} / ${c.oldRollbackExpandTool ? '✓' : '✗'} / ${c.oldRollbackExpandDoc ? '✓' : '✗'} |

## 7. 限制与非目标

${report.limitations.map((entry) => `- ${entry}`).join('\n')}

## 8. 清理与复现

- 临时构建目录：${report.cleanup.buildDirsRemoved ? '已删除' : '保留（--keep）'}
- 临时 home：${report.cleanup.homeRemoved ? '已删除' : '保留（--keep）'}
- 残留 sidecar PID：${report.cleanup.residualPids.length === 0 ? '无' : report.cleanup.residualPids.join(', ')}
- 全局安装：${report.cleanup.globalInstall ? '是' : '否'}
- 临时 home 位于真实 home 之外：${report.cleanup.outsideRealHome ? '是' : '否'}

复现命令：

\`\`\`bash
node tests/acceptance/upgrade-rollback/run-upgrade-rollback.mjs
\`\`\`

## 9. 机器可读证据

完整 JSON 见 \`docs/quality/0.3.2-upgrade-rollback.json\`，包含阶段检查、对象 ID、图/事件快照、环境、命令和清理结果；不包含 token、密钥或真实用户正文。
`;
}

let exitCode = 0;
let report = null;
let cleanup = {
  buildDirsRemoved: false,
  homeRemoved: false,
  residualPids: [],
  globalInstall: false,
  outsideRealHome: !home.startsWith(process.env.HOME ?? '/nonexistent'),
};
const buildResults = {};
const stages = {};
const stageRuns = {};
const checks = [];

try {
  await mkdir(workDir, { recursive: true });
  if (home.startsWith(process.env.HOME ?? '/nonexistent')) {
    throw new Error('临时 home 位于真实 HOME 下，拒绝运行');
  }
  const oldSha = gitSha(oldRef);
  const newSha = gitSha(newRef);
  if (oldSha === newSha) throw new Error('旧版与当前版指向同一 commit，无法演练升级');

  for (const [name, ref, sha, dir] of [['old', oldRef, oldSha, buildOld], ['new', newRef, newSha, buildNew]]) {
    await extract(ref, sha, dir);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmCi = mustRun(`${name} npm ci`, npm, ['ci', '--no-audit', '--no-fund'], {
      cwd: dir,
      env: { MEBULAR_BUILD_SHA: sha },
    });
    const build = mustRun(`${name} build`, npm, ['run', 'build'], {
      cwd: dir,
      env: { MEBULAR_BUILD_SHA: sha },
    });
    const version = JSON.parse(await readFile(join(dir, 'packages', 'service', 'dist', 'version.json'), 'utf8'));
    buildResults[name] = {
      sha: version.sha,
      packageVersion: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version,
      npmCi: { status: npmCi.status, elapsedMs: npmCi.elapsedMs },
      build: { status: build.status, elapsedMs: build.elapsedMs },
    };
  }

  const stageSpecs = [
    ['seed', buildOld, null, join(workDir, 'seed.json')],
    ['upgrade', buildNew, join(workDir, 'seed.json'), join(workDir, 'upgrade.json')],
    ['rollback', buildOld, join(workDir, 'upgrade.json'), join(workDir, 'rollback.json')],
  ];
  for (const [stage, buildDir, previous, resultFile] of stageSpecs) {
    const result = run(`driver ${stage}`, process.execPath, [DRIVER], {
      cwd: REPO,
      env: {
        BUILD_DIR: buildDir,
        MEBULAR_HOME: home,
        STAGE: stage,
        ...(previous ? { PREVIOUS_FILE: previous } : {}),
        RESULT_FILE: resultFile,
        UPGRADE_RUN_ID: runId,
      },
    });
    stageRuns[stage] = {
      status: result.status,
      signal: result.signal,
      elapsedMs: result.elapsedMs,
      stderr: result.stderr.trim().split('\n').slice(-5),
      error: result.error,
    };
    stages[stage] = await readResult(resultFile);
    if (!stages[stage].ok) {
      checks.push(check(`${stage}.driver`, false, {
        status: result.status,
        errors: stages[stage].errors ?? [],
        failedChecks: stages[stage].failedChecks ?? [],
      }));
      break;
    }
    checks.push(check(`${stage}.driver`, true, { elapsedMs: result.elapsedMs }));
  }

  if (stages.seed?.ok && stages.upgrade?.ok && stages.rollback?.ok) {
    checks.push(check('build.old.matchesRef', buildResults.old.sha === oldSha, {
      expected: oldSha,
      actual: buildResults.old.sha,
    }));
    checks.push(check('build.new.matchesRef', buildResults.new.sha === newSha, {
      expected: newSha,
      actual: buildResults.new.sha,
    }));
    checks.push(check('upgrade.oldDataReadable',
      ['user', 'tool', 'doc', 'default'].every((name) => stages.upgrade.checks[`upgrade.oldRecordReadable.${name}`]?.ok === true)
      && stages.upgrade.checks['upgrade.detailKindsPreserved']?.ok === true
      && stages.upgrade.checks['upgrade.oldDetailRetentionPreserved']?.ok === true));
    checks.push(check('upgrade.publicMcpAndCli',
      stages.upgrade.checks['cli.memoryRuntime']?.ok === true
      && stages.upgrade.mcp?.toolCount === 29));
    checks.push(check('upgrade.internalHidden',
      stages.upgrade.checks['upgrade.internalObjectsHiddenFromMcp']?.ok === true
      && stages.upgrade.checks['upgrade.memoryGraphInternalHidden']?.ok === true));
    checks.push(check('upgrade.checkpointSelfDetail',
      stages.upgrade.checks['upgrade.sidecar.checkpoint']?.ok === true
      && stages.upgrade.checks['upgrade.sidecar.self']?.ok === true
      && stages.upgrade.checks['upgrade.expand.raw']?.ok === true
      && stages.upgrade.checks['upgrade.currentDetailRetentionClasses']?.ok === true));
    checks.push(check('rollback.oldAndCurrentDataReadable',
      stages.rollback.checks['rollback.currentRecordReadable']?.ok === true
      && stages.rollback.checks['rollback.currentDetailsReadable']?.ok === true
      && stages.rollback.checks['rollback.detailTextsIntact']?.ok === true));
    checks.push(check('rollback.latestInternalReadable',
      stages.rollback.checks['rollback.latestCheckpointReadable']?.ok === true
      && stages.rollback.checks['rollback.latestSelfReadable']?.ok === true
      && stages.rollback.checks['rollback.oldCheckpointRevisionPresent']?.ok === true
      && stages.rollback.checks['rollback.oldSelfRevisionPresent']?.ok === true));
    checks.push(check('rollback.currentInternalHidden',
      stages.rollback.checks['rollback.currentInternalObjectsHiddenFromMcp']?.ok === true));
    const n = {
      seedToUpgradeNodes: nodeSignature(stages.seed.snapshotAfter) === nodeSignature(stages.upgrade.snapshotBefore),
      seedToUpgradeEvents: eventSignature(stages.seed.snapshotAfter) === eventSignature(stages.upgrade.snapshotBefore),
      upgradeToRollbackNodes: nodeSignature(stages.upgrade.snapshotAfter) === nodeSignature(stages.rollback.snapshotBefore),
      upgradeToRollbackEvents: eventSignature(stages.upgrade.snapshotAfter) === eventSignature(stages.rollback.snapshotBefore),
      rollbackNodesUnchanged: nodeSignature(stages.rollback.snapshotBefore) === nodeSignature(stages.rollback.snapshotAfter),
      rollbackEventsUnchanged: eventSignature(stages.rollback.snapshotBefore) === eventSignature(stages.rollback.snapshotAfter),
      upgradeToRollbackFile: stages.upgrade.fileAfterClose?.sha256 === stages.rollback.fileAfterClose?.sha256,
      rollbackDidNotRewriteFile: stages.rollback.fileAfterClose?.sha256 === stages.upgrade.fileAfterClose?.sha256
        && stages.rollback.fileAfterClose?.mtimeMs === stages.upgrade.fileAfterClose?.mtimeMs,
    };
    checks.push(check('noMigrationRewrite', Object.values(n).every(Boolean), n));
    const allIds = Object.fromEntries(Object.entries(stages.upgrade.objects ?? {})
      .filter(([key, value]) => typeof value === 'string' && !['checkpointThreadId', 'selfAgentId'].includes(key)));
    const missing = missingIds(stages.rollback.snapshotAfter, allIds);
    checks.push(check('dataIntegrity.noMissingIds', missing.length === 0, { missing }));
    checks.push(check('compatibility.oldReadsCurrentInternal',
      stages.rollback.compatibility?.oldReadsCurrentCompact === true
      && stages.rollback.compatibility?.oldReadsCurrentCheckpoint === true
      && stages.rollback.compatibility?.oldReadsCurrentSelf === true,
      stages.rollback.compatibility));
  }
} catch (error) {
  checks.push(check('harness', false, { error: safeMessage(error) }));
  exitCode = 1;
}

cleanup.residualPids = [...new Set(Object.values(stages)
  .map((stage) => stage?.sidecarAfterClose)
  .filter((entry) => entry?.pidAlive === true)
  .map((entry) => entry.pid))];

try {
  if (!args.keep) {
    await rm(home, { recursive: true, force: true });
    cleanup.homeRemoved = true;
    await rm(buildOld, { recursive: true, force: true });
    await rm(buildNew, { recursive: true, force: true });
    cleanup.buildDirsRemoved = true;
    await rm(workDir, { recursive: true, force: true });
  }
} catch (error) {
  cleanup.error = safeMessage(error);
  checks.push(check('cleanup', false, { error: safeMessage(error) }));
}

report = buildReport({
  oldSha: gitSha(oldRef),
  newSha: gitSha(newRef),
  stages,
  checks,
  cleanup,
  buildResults,
  stageRuns,
});
if (report.status !== 'pass') exitCode = 1;

await mkdir(dirname(jsonOut), { recursive: true });
await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(reportOut, markdown(report), 'utf8');

process.stdout.write(`status=${report.status}\njson=${relative(REPO, jsonOut)}\nreport=${relative(REPO, reportOut)}\n`);
process.exitCode = exitCode;
