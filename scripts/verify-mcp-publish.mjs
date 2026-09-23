#!/usr/bin/env node
// G6.5 發布驗證（E1）
//
// 1) 對三個套件 npm pack；檢驗 tarball 內容與 @mebular/mcp 內 @mebular/core 已由
//    prepack 由 `file:../..` 改寫為 `^0.1.0`（D41），且 pack 後本地依賴已還原。
// 2) 用產出的 tarball 在乾淨目錄安裝；以安裝後的 `mebular status`、`mebular mcp`
//    （真實 MCP client）與 `@mebular/skill/scripts/install.mjs` 做冒煙。
// 乾淨環境退出碼 0。前置：npm run build。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const mcpDir = join(rootDir, 'packages', 'mcp');
const skillDir = join(rootDir, 'packages', 'skill');
// F-UNI：统一 MCP 入口让 mcp 依赖 fleet → 发布面 = core + service + fleet + mcp + skill
const serviceDir = join(rootDir, 'packages', 'service');
const fleetDir = join(rootDir, 'packages', 'fleet');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let passed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) passed = false;
};

const pack = (cwd, dest) => {
  const out = execFileSync(npm, ['pack', '--json', '--pack-destination', dest], {
    cwd,
    encoding: 'utf-8',
    env: process.env,
  });
  const meta = JSON.parse(out)[0];
  return { file: join(dest, meta.filename), meta };
};
const listTarball = (tgz) => execFileSync('tar', ['-tzf', tgz], { encoding: 'utf-8' }).split('\n').filter(Boolean);
const readTarballFile = (tgz, inner) => execFileSync('tar', ['-xzf', tgz, '-O', inner], { encoding: 'utf-8' });

console.log('Mebular G6.5 發布驗證（npm pack + tarball 冒煙）');
console.log('===============================================');

if (!existsSync(join(rootDir, 'dist', 'index.js'))) {
  console.log('  · dist 不存在，先 build');
  execFileSync(npm, ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
}

const work = await mkdtemp(join(tmpdir(), 'mebular-publish-'));
const app = join(work, 'app');
const home = join(app, 'home');
let client = null;

try {
  // ---------- npm pack ----------
  const core = pack(rootDir, work);
  const service = pack(serviceDir, work);
  const fleet = pack(fleetDir, work);
  const mcp = pack(mcpDir, work);
  const skill = pack(skillDir, work);
  check('五包 npm pack（core/service/fleet/mcp/skill）', true,
    [core.meta.name, service.meta.name, fleet.meta.name, mcp.meta.name, skill.meta.name].join(' / '));

  // D41：mcp tarball 內為 ^0.1.0，pack 後本地 manifest 已還原
  const mcpManifest = JSON.parse(readTarballFile(mcp.file, 'package/package.json'));
  check('mcp tarball 依賴 @mebular/core=^0.1.0', mcpManifest.dependencies?.['@mebular/core'] === '^0.1.0', mcpManifest.dependencies?.['@mebular/core']);
  check('mcp tarball 依賴 @mebular/fleet=^0.1.0（统一入口复用任务 handler）', mcpManifest.dependencies?.['@mebular/fleet'] === '^0.1.0', mcpManifest.dependencies?.['@mebular/fleet']);
  const fleetManifest = JSON.parse(readTarballFile(fleet.file, 'package/package.json'));
  check('fleet tarball 依賴已改寫（core/service=^0.1.0）',
    fleetManifest.dependencies?.['@mebular/core'] === '^0.1.0' && fleetManifest.dependencies?.['@mebular/service'] === '^0.1.0',
    JSON.stringify(fleetManifest.dependencies));
  const fleetLocal = JSON.parse(await readFile(join(fleetDir, 'package.json'), 'utf-8'));
  check('fleet pack 後本地依賴還原為 file:（core/service）',
    fleetLocal.dependencies?.['@mebular/core'] === 'file:../..' && fleetLocal.dependencies?.['@mebular/service'] === 'file:../service');
  const localManifest = JSON.parse(await readFile(join(mcpDir, 'package.json'), 'utf-8'));
  check('pack 後本地依賴還原為 file:../..', localManifest.dependencies?.['@mebular/core'] === 'file:../..', localManifest.dependencies?.['@mebular/core']);
  check('pack 備份已清除', !existsSync(join(mcpDir, 'package.json.packbak')));

  // tarball 內容
  const coreFiles = listTarball(core.file);
  const mcpFiles = listTarball(mcp.file);
  const skillFiles = listTarball(skill.file);
  check('core tarball 含 dist/index.js', coreFiles.includes('package/dist/index.js'));
  check('core tarball 含 package.json', coreFiles.includes('package/package.json'));
  check('mcp tarball 含 bin/src', mcpFiles.includes('package/bin/mebular.mjs') && mcpFiles.includes('package/src/server.mjs'));
  check(
    'skill tarball 含 SKILL/MEMORY_POLICY/install/mcp',
    ['package/SKILL.md', 'package/MEMORY_POLICY.md', 'package/scripts/install.mjs', 'package/mcp/opencode.json'].every((f) => skillFiles.includes(f)),
  );

  // ---------- tarball 安裝冒煙 ----------
  await writeFile(join(work, 'package.json'), '{"name":"mebular-publish-smoke","private":true,"version":"0.0.0"}\n', 'utf-8');
  execFileSync(npm, ['install', core.file, service.file, fleet.file, mcp.file, skill.file, '--omit=optional', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: work,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: process.env,
  });
  const installedCore = JSON.parse(await readFile(join(work, 'node_modules', '@mebular', 'core', 'package.json'), 'utf-8'));
  check('tarball 安裝：@mebular/core@0.1.0', installedCore.version === '0.1.0', installedCore.version);
  check('tarball 安裝：@mebular/{service,fleet,mcp,skill}',
    ['service', 'fleet', 'mcp', 'skill'].every((n) => existsSync(join(work, 'node_modules', '@mebular', n))));

  const bin = join(work, 'node_modules', '.bin', 'mebular');
  const env = { ...process.env, MEBULAR_HOME: home, MEBULAR_STORAGE_PATH: join(home, 'store.jsonl'), MEBULAR_DEVICE_ID: 'device-publish-smoke' };

  const statusOut = JSON.parse(execFileSync(process.execPath, [bin, 'status'], { cwd: work, encoding: 'utf-8', env }));
  check('安裝後 mebular status', /^[0-9a-f]{64}$/.test(statusOut.stateHash ?? ''), `deviceId=${statusOut.deviceId}`);

  // 安裝後的 stdio MCP 冒煙（真實 MCP client）
  client = new Client({ name: 'mebular-publish-smoke', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], env, stderr: 'pipe' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  check('安裝後 mebular mcp：tools/list=27（记忆 11 + 任务 16）', tools.length === 27, `count=${tools.length}`);
  const written = await client.callTool({ name: 'memory_write', arguments: { items: [{ type: 'fact', content: 'publish-smoke' }] } });
  const parsed = written.structuredContent ?? JSON.parse(written.content?.find((c) => c.type === 'text')?.text ?? '{}');
  check('安裝後 memory_write 落圖', Array.isArray(parsed?.stored) && parsed.stored.length === 1);
  const queried = await client.callTool({ name: 'memory_query', arguments: { query: 'publish-smoke' } });
  const q = queried.structuredContent ?? JSON.parse(queried.content?.find((c) => c.type === 'text')?.text ?? '{}');
  check('安裝後 memory_query 命中', (q?.totalMatches ?? 0) >= 1, `totalMatches=${q?.totalMatches}`);
  // 任务工具随统一入口发布（该 home 无守护配置 → 结构化失败信封，证明 handler 真的在呼叫链上）
  const taskCall = await client.callTool({ name: 'task_status', arguments: { taskId: 'nope' } });
  check('安裝後任务工具可用（结构化错误信封）',
    taskCall?.isError === true && typeof taskCall?.structuredContent?.error?.code === 'string',
    `code=${taskCall?.structuredContent?.error?.code}`);
  await client.close();
  client = null;

  // 安裝後的 skill 安裝器
  const skillTarget = join(work, 'skills');
  execFileSync(process.execPath, [join(work, 'node_modules', '@mebular', 'skill', 'scripts', 'install.mjs'), '--target', skillTarget], { cwd: work, encoding: 'utf-8', env });
  check('安裝後 skill install.mjs', existsSync(join(skillTarget, 'mebular-memory', 'SKILL.md')));
} catch (error) {
  check('G6.5 發布驗證', false, String(error?.stderr ?? error?.message ?? error).substring(0, 500));
} finally {
  if (client) await client.close().catch(() => undefined);
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

console.log('===============================================');
if (passed) {
  console.log('✓ G6.5 發布驗證通過（E1）');
  process.exit(0);
} else {
  console.log('✗ G6.5 發布驗證失敗');
  process.exit(1);
}
