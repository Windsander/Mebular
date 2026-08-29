#!/usr/bin/env node
// Phase 6 验证脚本（质量收口 · 生态扩展 · 广域网桥接）
//
// 对照 docs.design/phase-6-plan.md 的毕业条件：
//   1. 6.0 质量债：死代码移除（src/crypto/signature|encryption|index.ts 不存在）、
//      ErrorCodes 注册、src 内裸 throw new Error 清零
//   2. 6.1 一致性：幂等键统一（import:<source>:<digest> 新格式 + 双读兼容）
//   3. 6.2 测试补强：覆盖率门槛落地并通过（global 85/65 + 关键文件底线）
//   4. 6.3 生态适配器：Obsidian vault + 日志型（统一幂等键、四端互通）
//   5. 6.4 广域网：multiaddr 发现桥接（D19 解除）+ syncedByPeer 持久化
//   6. 本脚本通过；全量测试全绿

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('Mebular Phase 6 验证脚本（质量收口 · 生态扩展 · 广域网桥接）');
console.log('=======================================================');

let allPassed = true;

// 1. Phase 6 核心文件（含死代码反向检查）
console.log('\n[1/6] 检查 Phase 6 核心文件...');
const phase6Files = [
  'src/exchange/import-keys.ts',
  'src/exchange/obsidian-adapter.ts',
  'src/exchange/log-journal-adapter.ts',
  'examples/obsidian-vault/README.md',
  'examples/obsidian-vault/vault/.obsidian/app.json',
  'examples/obsidian-vault/vault/Projects/Mebular.md',
  'examples/log-journal/README.md',
  'examples/log-journal/data/journal.jsonl',
  'examples/log-journal/data/plain.txt',
  'tests/export-surface.test.ts',
  'tests/p2p/connection-heartbeat.test.ts',
  'tests/p2p/handshake-branches.test.ts',
  'tests/sync/apply-edges.test.ts',
  'tests/exchange/obsidian-adapter.test.ts',
  'tests/exchange/log-journal-adapter.test.ts',
  'tests/exchange/four-end-interop.test.ts',
  'tests/p2p/discovery-multiaddr.test.ts',
  'tests/sync/sync-state-persistence.test.ts',
  'docs.design/phase-6-plan.md',
];
for (const file of phase6Files) {
  if (!existsSync(join(rootDir, file))) {
    console.log(`  ✗ 缺失: ${file}`);
    allPassed = false;
  } else {
    console.log(`  ✓ ${file}`);
  }
}
// 6.0 死代码反向检查：这些文件必须不存在
for (const dead of ['src/crypto/signature.ts', 'src/crypto/encryption.ts', 'src/crypto/index.ts']) {
  if (existsSync(join(rootDir, dead))) {
    console.log(`  ✗ 死代码复活: ${dead}`);
    allPassed = false;
  } else {
    console.log(`  ✓ 死代码已移除: ${dead}`);
  }
}

// 2. TypeScript 编译
console.log('\n[2/6] 运行 TypeScript 编译...');
try {
  execSync('npm run build', { cwd: rootDir, encoding: 'utf-8', timeout: 120000 });
  console.log('  ✓ 编译成功');
} catch (error) {
  console.log('  ✗ 编译失败');
  console.log('  错误:', String(error.message).substring(0, 500));
  allPassed = false;
}

// 3. 全量测试
console.log('\n[3/6] 运行全量测试套件...');
try {
  const output = execSync(
    'node --experimental-vm-modules node_modules/jest/bin/jest.js --silent',
    { cwd: rootDir, encoding: 'utf-8', timeout: 300000 },
  );
  const summary = output.split('\n').filter((line) => line.startsWith('Tests:'));
  console.log('  ✓ 测试通过', summary.length ? `(${summary[0].trim()})` : '');
} catch (error) {
  console.log('  ✗ 测试失败');
  console.log('  错误:', String(error.message).substring(0, 500));
  allPassed = false;
}

// 4. 覆盖率门槛（jest coverageThreshold 非零退出即不达标）+ 裸 Error 清零
console.log('\n[4/6] 覆盖率门槛 + 裸 Error 清零检查...');
try {
  const output = execSync(
    'node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage --silent 2>&1',
    { cwd: rootDir, encoding: 'utf-8', timeout: 300000 },
  );
  const allLine = output.split('\n').find((line) => line.startsWith('All files'));
  console.log('  ✓ 覆盖率门槛通过', allLine ? `(${allLine.trim().split('|').slice(0, 3).join('|').trim()})` : '');
} catch (error) {
  console.log('  ✗ 覆盖率门槛未达标');
  console.log('  错误:', String(error.message).substring(0, 500));
  allPassed = false;
}
// src 内裸 throw new Error 清零（6.0 纪律）
const bareThrows = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts') && readFileSync(full, 'utf-8').includes('throw new Error(')) {
      bareThrows.push(full.slice(rootDir.length + 1));
    }
  }
})(join(rootDir, 'src'));
if (bareThrows.length === 0) {
  console.log('  ✓ src 内裸 throw new Error 清零');
} else {
  console.log(`  ✗ 裸 Error 残留: ${bareThrows.join(', ')}`);
  allPassed = false;
}

// 5. 毕业条件关键实现点抽查（静态）
console.log('\n[5/6] 抽查毕业条件关键实现点...');
const checkpoints = [
  ['src/exchange/import-keys.ts', 'importLabel', '6.1 幂等键统一模块'],
  ['src/exchange/import-keys.ts', 'legacyImportLabel', '旧格式键双读兼容'],
  ['src/exchange/adapter.ts', 'existingIdMap', '幂等命中节点参与边端点映射'],
  ['src/exchange/obsidian-adapter.ts', 'related_to', 'wiki-link → 关系边'],
  ['src/exchange/obsidian-adapter.ts', 'mentions', 'wiki-link 未解析降级成文'],
  ['src/exchange/obsidian-adapter.ts', 'renderMarkdown', 'CMF → markdown 投影'],
  ['src/exchange/log-journal-adapter.ts', 'follows', 'append-only 序 follows 边'],
  ['src/p2p/DeviceDiscovery.ts', 'addrs', 'multiaddr TXT 发布（D19 解除）'],
  ['src/p2p/P2PNetwork.ts', 'getProviderMultiaddrs', 'provider multiaddr 自动桥接'],
  ['src/sync/syncmgr/SyncManager.ts', 'syncStatePath', '已确认集合持久化'],
  ['src/sync/syncmgr/SyncManager.ts', 'STORAGE_READ_FAILED', '状态文件损坏诚实报错'],
  ['src/errors.ts', 'NetworkError', '6.0 错误类注册'],
  ['package.json', 'coverageThreshold', '覆盖率门槛配置'],
];
for (const [file, marker, label] of checkpoints) {
  const fullPath = join(rootDir, file);
  const hit = existsSync(fullPath) && readFileSync(fullPath, 'utf-8').includes(marker);
  if (hit) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}（${file} 缺少 ${marker}）`);
    allPassed = false;
  }
}

// 6. 功能冒烟（构建产物）：双新适配器 + 幂等 + 同步状态持久化 + multiaddr 桥接
console.log('\n[6/6] 功能冒烟：构建产物上的生态适配与持久化...');
const smokeDir = await mkdtemp(join(tmpdir(), 'mebular-verify-phase6-'));
try {
  const mebular = await import(join(rootDir, 'dist', 'index.js'));
  const {
    MemoryStore, GraphStore, MemoryStorage, EventLog, SyncManager,
    ObsidianVaultAdapter, LogJournalAdapter, DeviceDiscovery,
    importWithAdapter,
  } = mebular;

  // (a) Obsidian vault 适配：样例库 → 10 节点 / 3 条 related_to，重复导入全量幂等
  const memoryA = new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author: 'smoke' }));
  const obsidian = new ObsidianVaultAdapter();
  const vaultDir = join(rootDir, 'examples/obsidian-vault/vault');
  const or1 = await importWithAdapter(obsidian, { kind: 'obsidian-vault', data: vaultDir, origin: 'v' }, memoryA);
  const or2 = await importWithAdapter(obsidian, { kind: 'obsidian-vault', data: vaultDir, origin: 'v' }, memoryA);
  const related = (await memoryA.getGraph().listEdges()).filter((e) => e.relation === 'related_to');
  if (or1.nodesCreated !== 10 || or2.skipped !== 10 || related.length !== 3) {
    throw new Error(`Obsidian 投影异常: created=${or1.nodesCreated} skipped=${or2.skipped} related=${related.length}`);
  }
  console.log('  ✓ Obsidian vault → 图（wiki-link 边 + 幂等键）');

  // (b) 日志型端：JSONL → 容器 + Episode 序列 + follows 链
  const memoryB = new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author: 'smoke' }));
  const logData = await readFile(join(rootDir, 'examples/log-journal/data/journal.jsonl'), 'utf-8');
  const lr = await importWithAdapter(
    new LogJournalAdapter(),
    { kind: 'jsonl', data: logData, origin: 'gw' },
    memoryB,
  );
  const follows = (await memoryB.getGraph().listEdges()).filter((e) => e.relation === 'follows');
  if (lr.nodesCreated !== 4 || follows.length !== 2) {
    throw new Error(`日志投影异常: created=${lr.nodesCreated} follows=${follows.length}`);
  }
  console.log('  ✓ 日志型端 → Episode 序列（append-only follows 链）');

  // (c) syncedByPeer 持久化：落盘 → 新实例懒加载恢复
  const statePath = join(smokeDir, 'sync-state.json');
  const storageC = new MemoryStorage();
  const eventLogC = new EventLog(storageC, 'dev-smoke');
  const mkSync = () => new SyncManager({
    eventLog: eventLogC,
    storage: storageC,
    deviceId: 'dev-smoke',
    syncStatePath: statePath,
  });
  await mkSync().markEventsSynced('peer-x', ['evt-1']);
  if (!existsSync(statePath)) throw new Error('同步状态文件未落盘');
  const pending = await mkSync().getPendingEvents('peer-x');
  if (pending.length !== 0) throw new Error('重启后已确认事件仍算待同步');
  console.log('  ✓ syncedByPeer 持久化（落盘 → 重启恢复）');

  // (d) multiaddr 桥接：发布侧 TXT addrs + 解析侧优先 multiaddr
  let publishedTxt = null;
  let discoveredCallback = null;
  const mockBonjour = {
    publish: (options) => { publishedTxt = options.txt; },
    find: (_query, cb) => { discoveredCallback = cb; return { stop: () => undefined }; },
    destroy: () => undefined,
  };
  const discovery = new DeviceDiscovery({ createBonjourService: () => mockBonjour });
  const peerIdOf = (id) => ({ id, multihash: new TextEncoder().encode(id), pubKey: new TextEncoder().encode(id) });
  discovery.setLocalInfo(peerIdOf('local-x'), 40000, ['/ip4/1.2.3.4/tcp/4001/p2p/local-x']);
  await discovery.start();
  if (publishedTxt?.addrs !== '/ip4/1.2.3.4/tcp/4001/p2p/local-x') {
    throw new Error('multiaddr 未随 TXT 发布');
  }
  discoveredCallback({ name: 'peer-y', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-y', addrs: '/ip4/9.9.9.9/tcp/4001/p2p/peer-y' }, addresses: ['9.9.9.9'] });
  const peerY = discovery.getPeer(peerIdOf('peer-y'));
  if (peerY?.addresses[0] !== '/ip4/9.9.9.9/tcp/4001/p2p/peer-y') {
    throw new Error('multiaddr 解析未优先于裸 IP');
  }
  await discovery.stop();
  console.log('  ✓ multiaddr 发现桥接（发布 + 解析两侧）');

  console.log('  ✓ 构建产物功能冒烟全部通过');
} catch (error) {
  console.log('  ✗ 功能冒烟失败');
  console.log('  错误:', String(error.message ?? error).substring(0, 500));
  allPassed = false;
} finally {
  await rm(smokeDir, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(60));
if (allPassed) {
  console.log('✓ Phase 6 验证通过');
  process.exit(0);
} else {
  console.log('✗ Phase 6 验证失败，请修复上述问题');
  process.exit(1);
}
