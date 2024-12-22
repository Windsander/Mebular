#!/usr/bin/env node
// Phase 2 验证脚本（P2P 网络）
//
// 对照 docs.design/spec-005-p2p-network.md 的毕业条件：
//   节点启停正常、设备发现可运行、连接管理可处理并发、
//   认证握手与 spec-002 兼容（证书 + 挑战-应答）、
//   NAT 穿透策略落地、加密信道可用、单元测试覆盖核心路径。

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('Mebular Phase 2 验证脚本（P2P 网络）');
console.log('====================================');

let allPassed = true;

// 1. 检查 Phase 2 核心文件
console.log('\n[1/4] 检查 Phase 2 核心文件...');
const phase2Files = [
  'src/p2p/index.ts',
  'src/p2p/P2PNetwork.ts',
  'src/p2p/DeviceDiscovery.ts',
  'src/p2p/connection/ConnectionManager.ts',
  'src/p2p/handshake/AuthenticationHandshake.ts',
  'src/p2p/nat/NATTraversal.ts',
  'src/p2p/secure/SecureChannelImpl.ts',
  'src/p2p/transport/InMemoryTransport.ts',
  'tests/p2p/DeviceDiscovery.test.ts',
  'tests/p2p/ConnectionManager.test.ts',
  'tests/p2p/AuthenticationHandshake.test.ts',
  'tests/p2p/SecureChannel.test.ts',
  'tests/p2p/NATTraversal.test.ts',
  'tests/integration/P2PNetwork.integration.test.ts',
  'docs.design/spec-005-p2p-network.md',
];

for (const file of phase2Files) {
  if (!existsSync(join(rootDir, file))) {
    console.log(`  ✗ 缺失: ${file}`);
    allPassed = false;
  } else {
    console.log(`  ✓ ${file}`);
  }
}

// 2. TypeScript 编译
console.log('\n[2/4] 运行 TypeScript 编译...');
try {
  execSync('npm run build', { cwd: rootDir, encoding: 'utf-8', timeout: 120000 });
  console.log('  ✓ 编译成功');
} catch (error) {
  console.log('  ✗ 编译失败');
  console.log('  错误:', error.message.substring(0, 500));
  allPassed = false;
}

// 3. p2p 单元测试 + 集成测试
console.log('\n[3/4] 运行 P2P 测试套件...');
try {
  const output = execSync(
    'node --experimental-vm-modules node_modules/jest/bin/jest.js tests/p2p tests/integration --silent',
    { cwd: rootDir, encoding: 'utf-8', timeout: 180000 },
  );
  const summary = output.split('\n').filter((line) => line.startsWith('Tests:'));
  console.log('  ✓ 测试通过', summary.length ? `(${summary[0].trim()})` : '');
} catch (error) {
  console.log('  ✗ 测试失败');
  console.log('  错误:', error.message.substring(0, 500));
  allPassed = false;
}

// 4. 毕业条件关键实现点抽查（静态）
console.log('\n[4/4] 抽查毕业条件关键实现点...');
const checkpoints = [
  ['src/p2p/handshake/AuthenticationHandshake.ts', 'auth-ok', '挑战-应答四次消息（auth-ok 确认）'],
  ['src/p2p/handshake/AuthenticationHandshake.ts', 'verifyDeviceSignature', '设备私钥签名验证（防证书重放）'],
  ['src/p2p/secure/SecureChannelImpl.ts', 'Possible replay attack', '加密信道重放保护'],
  ['src/p2p/secure/SecureChannelImpl.ts', 'rotateSessionKey', '会话密钥轮换'],
  ['src/p2p/nat/NATTraversal.ts', 'HolePunchChannel', '打洞信令抽象'],
  ['src/p2p/connection/ConnectionManager.ts', 'setConnectionProvider', '连接管理拨号注入'],
  ['src/p2p/transport/InMemoryTransport.ts', 'ConnectionProvider', '传输抽象（libp2p 接缝）'],
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

console.log('\n' + '='.repeat(60));
if (allPassed) {
  console.log('✓ Phase 2 验证通过');
  process.exit(0);
} else {
  console.log('✗ Phase 2 验证失败，请修复上述问题');
  process.exit(1);
}
