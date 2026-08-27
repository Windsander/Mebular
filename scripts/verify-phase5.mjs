#!/usr/bin/env node
// Phase 5 验证脚本（跨端互通）
//
// 对照 docs.design/phase-5-plan.md 的毕业条件：
//   1. libp2p 适配器落地（可选依赖 + 动态导入 + 门面真实装配）
//   2. 信任模型 v1（证书链验签 + 私钥口令加密存放）
//   3. CMF 版本化交换格式（双向转换 + 兼容规则）
//   4. 适配器框架（MemoryAdapter + Registry + 跨端幂等键）
//   5. 参考互通（Hermes/json-memo 适配器 + 三端收敛）
//   6. M5 故障注入与拓扑收敛（分区/丢包/抖动/环形/星形/千级冒烟）
//   7. 本脚本通过；单元 + 集成测试覆盖核心路径

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('Mebular Phase 5 验证脚本（跨端互通）');
console.log('=====================================');

let allPassed = true;

// 1. Phase 5 核心文件
console.log('\n[1/5] 检查 Phase 5 核心文件...');
const phase5Files = [
  'src/p2p/transport/Libp2pProvider.ts',
  'src/crypto/KeyProtector.ts',
  'src/exchange/cmf.ts',
  'src/exchange/adapter.ts',
  'src/exchange/builtin-adapters.ts',
  'src/exchange/hermes-adapter.ts',
  'src/exchange/json-memo-adapter.ts',
  'src/exchange/index.ts',
  'examples/json-memo/data/memos.json',
  'tests/p2p/Libp2pProvider.test.ts',
  'tests/crypto/KeyProtector.test.ts',
  'tests/sync/TrustChain.test.ts',
  'tests/mebular/IdentityFileEncryption.test.ts',
  'tests/exchange/cmf.test.ts',
  'tests/exchange/adapter.test.ts',
  'tests/exchange/hermes-json-memo.test.ts',
  'tests/exchange/three-end-interop.test.ts',
  'tests/sync/fault-injection.test.ts',
  'tests/helpers/faulty-transport.ts',
  'docs.design/phase-5-plan.md',
];
for (const file of phase5Files) {
  if (!existsSync(join(rootDir, file))) {
    console.log(`  ✗ 缺失: ${file}`);
    allPassed = false;
  } else {
    console.log(`  ✓ ${file}`);
  }
}

// 2. TypeScript 编译
console.log('\n[2/5] 运行 TypeScript 编译...');
try {
  execSync('npm run build', { cwd: rootDir, encoding: 'utf-8', timeout: 120000 });
  console.log('  ✓ 编译成功');
} catch (error) {
  console.log('  ✗ 编译失败');
  console.log('  错误:', String(error.message).substring(0, 500));
  allPassed = false;
}

// 3. 全量测试（Phase 5 收口牵动全部组件，跑全量防回归）
console.log('\n[3/5] 运行全量测试套件...');
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

// 4. 毕业条件关键实现点抽查（静态）
console.log('\n[4/5] 抽查毕业条件关键实现点...');
const checkpoints = [
  ['src/p2p/transport/Libp2pProvider.ts', 'NETWORK_LIBP2P_NOT_AVAILABLE', 'libp2p 缺包诚实报错'],
  ['src/p2p/transport/Libp2pProvider.ts', 'FrameDecoder', '长度前缀帧（TCP 写边界）'],
  ['src/p2p/transport/Libp2pProvider.ts', 'peerIdFromDevicePublicKey', 'PeerId 同源派生映射'],
  ['src/mebular.ts', 'Libp2pProvider.create', '门面 libp2p 真实装配'],
  ['src/crypto/KeyProtector.ts', 'PBKDF2', '私钥口令封套（PBKDF2+AES-GCM）'],
  ['src/mebular.ts', 'IDENTITY_LOCKED', '缺口令诚实失败'],
  ['src/types/event.ts', 'authorCertificate', '事件证书链字段（可选）'],
  ['src/sync/syncmgr/SyncManager.ts', 'verifyEventTrust', '信任链双路径验签（收口 D9）'],
  ['src/exchange/cmf.ts', 'CMF_VERSION_UNSUPPORTED', 'CMF 版本协商诚实报错'],
  ['src/exchange/cmf.ts', 'extensions', '未知字段保留袋'],
  ['src/exchange/adapter.ts', 'adapterDedupKey', '跨端幂等键（含来源端标识）'],
  ['src/exchange/adapter.ts', 'ADAPTER_NOT_FOUND', '无认领路由诚实报错'],
  ['src/exchange/hermes-adapter.ts', 'source_of', 'Hermes 出处链边'],
  ['package.json', 'optionalDependencies', 'libp2p 可选依赖声明'],
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

// 5. 功能冒烟（构建产物）：libp2p 回环 + CMF 往返 + 三端互通 + 私钥封套
console.log('\n[5/5] 功能冒烟：构建产物上的跨端互通...');
const smokeDir = await mkdtemp(join(tmpdir(), 'mebular-verify-phase5-'));
try {
  const mebular = await import(join(rootDir, 'dist', 'index.js'));
  const {
    Mebular, IdentityManager, MemoryStore, GraphStore, MemoryStorage,
    Libp2pProvider, HermesAdapter, JsonMemoAdapter, KvJsonAdapter,
    AdapterRegistry, exportGraphToCmf, parseCmfDocument, importCmfToMemory,
  } = mebular;

  // (a) libp2p 真实 TCP 回环：两 provider 互发带帧边界的报文
  const keyOf = async () => {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return {
      publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)),
      privateKey: kp.privateKey,
    };
  };
  const providerA = await Libp2pProvider.create({ deviceKey: await keyOf(), listen: ['/ip4/127.0.0.1/tcp/0'] });
  const providerB = await Libp2pProvider.create({ deviceKey: await keyOf(), listen: ['/ip4/127.0.0.1/tcp/0'] });
  await providerA.start();
  await providerB.start();
  const echoed = new Promise((resolve) => {
    providerB.onIncomingConnection((conn) => {
      void (async () => {
        for await (const message of conn.receive()) {
          await conn.send(message); // 回显
          resolve(message);
        }
      })();
    });
  });
  const conn = await providerA.dial(providerB.getLocalPeerId(), providerB.getMultiaddrs()[0]);
  const payload = new TextEncoder().encode('libp2p-loopback-smoke');
  await conn.send(payload);
  const replyIter = conn.receive()[Symbol.asyncIterator]();
  const reply = await replyIter.next();
  await echoed;
  if (new TextDecoder().decode(reply.value) !== 'libp2p-loopback-smoke') {
    throw new Error('libp2p 回环报文不一致');
  }
  await conn.close();
  await providerA.stop();
  await providerB.stop();
  console.log('  ✓ libp2p 真实 TCP 回环（帧边界完整）');

  // (b) 门面身份文件口令封套
  const master = await new IdentityManager().generateUserMasterKey();
  const app = new Mebular({
    storagePath: join(smokeDir, 'sealed.jsonl'),
    deviceId: 'device-sealed',
    encryption: {
      userMasterKey: master.publicKey,
      userMasterPrivateKey: master.privateKey,
      passphrase: 'verify-phase5',
    },
    sync: { autoSync: false },
  });
  await app.initialize();
  await app.shutdown();
  const identityRecord = JSON.parse(
    await readFile(join(smokeDir, 'sealed.jsonl.identity.json'), 'utf-8'),
  );
  if (!identityRecord.privateKeyEncrypted || identityRecord.privateKeyPkcs8 !== undefined) {
    throw new Error('身份文件未按口令加密存放');
  }
  console.log('  ✓ 身份文件私钥口令封套（无明文字段）');

  // (c) CMF 往返 + 适配器幂等 + 异构映射
  const memory = new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author: 'smoke' }));
  const registry = new AdapterRegistry();
  registry.register(new KvJsonAdapter());
  registry.register(new JsonMemoAdapter());
  const memoData = JSON.parse(
    await readFile(join(rootDir, 'examples/json-memo/data/memos.json'), 'utf-8'),
  );
  const r1 = await registry.import({ kind: 'json-memo', data: memoData, origin: 'memo-phone' }, memory);
  const r2 = await registry.import({ kind: 'json-memo', data: memoData, origin: 'memo-phone' }, memory);
  if (r1.nodesCreated !== 3 || r2.skipped !== 3) {
    throw new Error(`适配器幂等异常: first=${r1.nodesCreated} second.skipped=${r2.skipped}`);
  }
  const cmf = await exportGraphToCmf(memory.getGraph(), { source: { app: 'verify-phase5' } });
  const parsed = parseCmfDocument(JSON.stringify(cmf));
  if (parsed.nodes.length !== 3) {
    throw new Error('CMF 回读节点数不符');
  }
  const memory2 = new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author: 'smoke-2' }));
  const back = await importCmfToMemory(memory2, parsed);
  if (back.errors.length !== 0 || back.nodesCreated !== 3) {
    throw new Error(`CMF 往返导入异常: ${JSON.stringify(back.errors)}`);
  }
  // Hermes 适配器目录形态识别
  const hermes = new HermesAdapter();
  if (hermes.detect({ data: join(rootDir, 'tests/exchange/fixtures/hermes') }) <= 0) {
    throw new Error('Hermes 目录形态识别失败');
  }
  console.log('  ✓ CMF 往返 + 适配器幂等 + Hermes 目录识别');

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
  console.log('✓ Phase 5 验证通过');
  process.exit(0);
} else {
  console.log('✗ Phase 5 验证失败，请修复上述问题');
  process.exit(1);
}
