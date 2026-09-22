#!/usr/bin/env node
// G6.4 行为层 + CLI 验证（E1；agent 实机为 E2，见文末标注）
//
// 覆盖：@mebular/skill 包内容（SKILL.md frontmatter / MEMORY_POLICY.md / mcp 片段 /
// install.mjs）+ CLI init/keygen/print-config/status。
// 干净环境退出码 0。前置：npm run build。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bin = join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs');
const skillDir = join(rootDir, 'packages', 'skill');

let passed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) passed = false;
};

function run(args, env = {}) {
  return execFileSync(process.execPath, args, {
    cwd: rootDir,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

console.log('Mebular G6.4 行为层 + CLI 验证');
console.log('==============================');

const dir = await mkdtemp(join(tmpdir(), 'mebular-skill-'));
const home = join(dir, 'home');
const installTarget = join(dir, 'skills');

try {
  // ---------- Skill 包内容 ----------
  check('SKILL.md 存在', existsSync(join(skillDir, 'SKILL.md')));
  check('MEMORY_POLICY.md 存在', existsSync(join(skillDir, 'MEMORY_POLICY.md')));
  const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
  check('SKILL.md frontmatter name=mebular-memory', /^---[\s\S]*?name:\s*mebular-memory[\s\S]*?---/.test(skill));
  check('SKILL.md 含 whenToUse', /whenToUse:/.test(skill));
  for (const f of ['opencode.json', 'claude.json', 'cursor.json', 'dsh.cordis.yml', 'generic.json']) {
    check(`mcp 片段 ${f}`, existsSync(join(skillDir, 'mcp', f)));
  }
  const policy = await readFile(join(skillDir, 'MEMORY_POLICY.md'), 'utf-8');
  check('MEMORY_POLICY 含「先查后写」「无结果别编」', policy.includes('先查后写') && policy.includes('无结果别编'));

  // ---------- CLI keygen ----------
  const keyOut = join(dir, 'k.json');
  const keygenOut = JSON.parse(run([bin, 'keygen', '--out', keyOut]));
  check('keygen 生成主密钥文件', existsSync(keyOut) && typeof keygenOut.publicKey === 'string', keyOut);

  // ---------- CLI init ----------
  const initOut = run([bin, 'init'], { MEBULAR_HOME: home });
  const configPath = join(home, 'config.json');
  check('init 写入 config.json', existsSync(configPath));
  check('init 生成 user-master-key.json', existsSync(join(home, 'user-master-key.json')));
  const config = JSON.parse(await readFile(configPath, 'utf-8'));
  check('config 含 mcp.http + storagePath', config.mcp?.http?.host === '127.0.0.1' && typeof config.storagePath === 'string');
  check('init 打印下一步', initOut.includes('install.mjs'));

  // ---------- CLI print-config ----------
  for (const client of ['opencode', 'claude', 'cursor', 'generic']) {
    const out = run([bin, 'print-config', '--client', client]);
    let ok = false;
    try {
      const parsed = JSON.parse(out);
      ok = JSON.stringify(parsed).includes('mebular');
    } catch {
      ok = false;
    }
    check(`print-config ${client}（JSON 含 mebular）`, ok);
  }
  const dsh = run([bin, 'print-config', '--client', 'dsh']);
  check('print-config dsh（只桥接 Tools）', dsh.includes('@deepseek-ai/dsh-mcp-client') && dsh.includes('transport: stdio'));
  const remote = run([bin, 'print-config', '--client', 'claude', '--url', 'https://example/mcp']);
  check('print-config 远程 url 形态', JSON.parse(remote).mcpServers.mebular.url === 'https://example/mcp');

  // ---------- CLI status ----------
  const status = JSON.parse(run([bin, 'status'], { MEBULAR_HOME: home }));
  check('status 出 deviceId/stateHash', typeof status.deviceId === 'string' && /^[0-9a-f]{64}$/.test(status.stateHash));
  check('status 含 home/storagePath', typeof status.home === 'string' && typeof status.storagePath === 'string');

  // ---------- 部署手册（A：Agent 可自动部署）----------
  const setupPath = join(skillDir, 'SETUP.md');
  check('SETUP.md 存在（部署手册）', existsSync(setupPath));
  const setup = existsSync(setupPath) ? await readFile(setupPath, 'utf-8') : '';
  const setupAnchors = ['fleet quickstart', 'fleet invite', 'fleet join --qr', 'mebular doctor --net', 'git ls-remote', '--dir', 'MCP_STORAGE_LOCKED', '主密钥'];
  const missingAnchors = setupAnchors.filter((token) => !setup.includes(token));
  check(`SETUP.md 含部署/加入/自检/恢复锚点（${setupAnchors.length} 个）`, missingAnchors.length === 0, missingAnchors.join(', '));
  check('SKILL.md 指向 SETUP.md（接入节可发现）', /SETUP\.md/.test(skill));

  // ---------- install.mjs ----------
  const installOut = run([join(skillDir, 'scripts', 'install.mjs'), '--target', installTarget]);
  const installedSkill = join(installTarget, 'mebular-memory', 'SKILL.md');
  check('install.mjs 安装 SKILL.md', existsSync(installedSkill), installOut.trim().split('\n')[0]);
  check('install.mjs 安装 MEMORY_POLICY.md', existsSync(join(installTarget, 'mebular-memory', 'MEMORY_POLICY.md')));
  const installedSetup = join(installTarget, 'mebular-memory', 'SETUP.md');
  check('install.mjs 安装 SETUP.md（部署手册随 Skill 落地）', existsSync(installedSetup));
  check('安装后的 SETUP.md 含关键命令（fleet quickstart / fleet join --qr）',
    existsSync(installedSetup) && (await readFile(installedSetup, 'utf-8')).includes('fleet quickstart')
      && (await readFile(installedSetup, 'utf-8')).includes('fleet join --qr'));
} catch (error) {
  check('G6.4 验证', false, String(error?.message ?? error).substring(0, 400));
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log('==============================');
console.log('E2（人工，不影响上述 E1）：opencode / Claude Code+Desktop / Cursor / DeepSeek Harness');
console.log('  按 packages/skill/mcp/* 片段接入后，走通「提问→召回→写入」。');
if (passed) {
  console.log('✓ G6.4 行为层 + CLI 验证通过（E1）');
  process.exit(0);
} else {
  console.log('✗ G6.4 行为层 + CLI 验证失败');
  process.exit(1);
}
