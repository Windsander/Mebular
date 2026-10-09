#!/usr/bin/env node
// G6.4 行为层 + CLI 验证（E1；agent 实机为 E2，见文末标注）
//
// 覆盖：@mebular/skill 包内容（SKILL.md frontmatter / MEMORY_POLICY.md / mcp 片段 /
// install.mjs）+ CLI init/keygen/print-config/status。
// 干净环境退出码 0。前置：npm run build。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

  // ---------- R3：任务面 skill（mebular-tasks，与记忆面并列） ----------
  {
    const tasksSkillPath = join(skillDir, 'tasks', 'SKILL.md');
    check('任务面 skill 存在（tasks/SKILL.md）', existsSync(tasksSkillPath));
    const tasks = existsSync(tasksSkillPath) ? readFileSync(tasksSkillPath, 'utf-8') : '';
    check('mebular-tasks frontmatter name + whenToUse（派活/跨设备协作/协商/进度）',
      /^---[\s\S]*?name:\s*mebular-tasks[\s\S]*?---/.test(tasks) && /whenToUse:/.test(tasks)
        && /派给别的设备上的 Agent/.test(tasks) && /协商/.test(tasks) && /看任务进度/.test(tasks));
    const anchors = ['task_submit', 'intent', 'payloadRef', 'causedBy', 'chain', 'budget', 'dispatch',
      'task_status', 'task_children', 'task_summarize', 'task_subscribe', 'task_quota', 'task_targets', 'board_create',
      'task_negotiate', 'chatter_send', 'task_retry', 'task_cancel',
      '非幂等', '不是记忆', 'L1 授权', '预算', '链长上限', '公平准入'];
    const missing = anchors.filter((a) => !tasks.includes(a));
    check(`mebular-tasks 覆盖派活/字段/跟踪/协作/失败/边界/发现/红线锚点（${anchors.length} 个）`, missing.length === 0, missing.join(', ') || '全部命中');
    const installedTasks = join(installTarget, 'mebular-tasks', 'SKILL.md');
    check('install.mjs 一并安装 mebular-tasks', existsSync(installedTasks));
  }
  check('install.mjs 安装 MEMORY_POLICY.md', existsSync(join(installTarget, 'mebular-memory', 'MEMORY_POLICY.md')));
  const installedSetup = join(installTarget, 'mebular-memory', 'SETUP.md');
  check('install.mjs 安装 SETUP.md（部署手册随 Skill 落地）', existsSync(installedSetup));
  check('安装后的 SETUP.md 含关键命令（fleet quickstart / fleet join --qr）',
    existsSync(installedSetup) && (await readFile(installedSetup, 'utf-8')).includes('fleet quickstart')
      && (await readFile(installedSetup, 'utf-8')).includes('fleet join --qr'));

  // ---------- G1：会话内接入（SETUP §0）+ 接入片段随 Skill 安装 ----------
  {
    // §0 必须**在最前**（在 §1 之前），且 §1–§7 编号不被改动
    const setupIdx = setup.indexOf('## 0. 会话内接入');
    const c1Idx = setup.indexOf('## 1. 前置检查');
    check('SETUP.md §0「会话内接入」位于最前（在 §1 之前；§1–§7 编号保留）',
      setupIdx >= 0 && c1Idx > setupIdx
        && ['## 1. 前置检查', '## 2. 安装 CLI', '## 3. 建一个新的 Mebular', '## 4. 出一个邀请', '## 5. 加入一个已有的 Mebular', '## 6. 自检与失败恢复', '## 7. 回报给用户']
          .every((h) => setup.includes(h)),
      `§0@${setupIdx} §1@${c1Idx}`);
    const sessionAnchors = ['会话内接入', 'print-config', 'mebular service install', 'memory_status'];
    const missingSession = sessionAnchors.filter((token) => !setup.includes(token));
    check(`SETUP §0 会话内接入锚点（${sessionAnchors.length} 个）`, missingSession.length === 0, missingSession.join(', ') || '全部命中');
    check('SETUP §0 幂等判定用 storeLock（并说明 running 是 P2P 节点状态，非守护进程）',
      setup.includes('storeLock') && /running`?\s*是 \*\*P2P/.test(setup), 'storeLock + 口径说明');
    check('SETUP §0.2 明示「无 home 不自建身份」（status 会自举身份材料）',
      /无 `config\.json`[^\n]*不要[^\n]*`status`/.test(setup) && setup.includes('自举身份材料'));
    check('SETUP §0.3 拉起含常驻（service install）+ 前台 serve + 确认判据（storeLock / healthz）',
      setup.includes('mebular service install') && setup.includes('mebular serve --port 7331')
        && /storeLock 非 null/.test(setup) && setup.includes('/healthz'));
    check('SETUP §2 判定行修正为 mebular --help（+ fleet --version），不再用不存在的 --version',
      /mebular --help/.test(setup) && setup.includes('fleet --version') && /`mebular --version` 不存在/.test(setup));
    check('SETUP §3 status 不再用不存在的 --home 参数（改注 MEBULAR_HOME）',
      !/mebular status --home/.test(setup) && setup.includes('MEBULAR_HOME=<dir> mebular status'));

    // ---------- 修复轮 A/B/C（评审 3 处必改）----------
    // A（高）：§0.1 的 `mebular status` 必须在「home 存在」守卫内（无 home 照抄不得自举身份）
    const s01 = setup.slice(setup.indexOf('**0.1 幂等'), setup.indexOf('**0.2 无 home'));
    const s01Block = (s01.match(/```bash\n([\s\S]*?)```/) ?? [])[1] ?? '';
    check('A §0.1 的 `mebular status` 处于「home 存在」守卫内（if [ -f …config.json ] … then … else … fi）',
      /if \[ -f "\$HOME_DIR\/config\.json" \]; then/.test(s01Block)
        && /then[\s\S]*?mebular status[\s\S]*?else[\s\S]*?fi/.test(s01Block)
        && (s01Block.match(/mebular status/g) ?? []).length === 1,
      s01Block.includes('mebular status') ? '守卫内唯一一处 status' : '缺少 status');
    check('A §0.1 守卫的 else 分支明确「无 home → §3/§5」且**不跑** status',
      /else[\s\S]*?无 home → §3 建新 \/ §5 加入/.test(s01Block) && /不要在这里跑 status/.test(s01Block));

    // B（中）：§0.4 判据不得把 storeLock 列为 memory_status 的返回项，且须注明它来自 CLI status
    const s04 = setup.slice(setup.indexOf('**0.4 接入当前客户端'), setup.indexOf('**0.5 红线'));
    check('B §0.4 不把 `storeLock` 列为 `memory_status` 返回项，并注明见 CLI `mebular status`',
      /memory_status`.{0,40}`deviceId`.{0,20}`running`/.test(s04)
        && /`storeLock` \*\*不在\*\* `memory_status` 的返回里/.test(s04)
        && /CLI `mebular status`/.test(s04)
        && !/memory_status` —— 期望返回 `deviceId` \/ `storeLock`/.test(s04),
      '措辞已更正');

    // C（中）：§0.3 的 service 命令必须带 MEBULAR_HOME 前缀（否则单元退化到 <cwd>/.mebular）
    const s03 = setup.slice(setup.indexOf('**0.3 有 home 但未在跑'), setup.indexOf('若所在环境不支持常驻'));
    check('C §0.3 `mebular service install`/`status` 均带 `MEBULAR_HOME=~/.mebular` 前缀',
      /MEBULAR_HOME=~\/\.mebular mebular service install/.test(s03)
        && (s03.match(/MEBULAR_HOME=~\/\.mebular mebular service status/g) ?? []).length === 2
        && !/\n +mebular service (install|status)/.test(s03),
      '三条命令均带前缀');
    check('C §0.3 说明「未设 MEBULAR_HOME 时退化到 <cwd>/.mebular」的依据',
      /`homeDir\(\)` 退化为 \*\*`<cwd>\/\.mebular`\*\*/.test(s03) && /workingDir/.test(s03) && /storeLock=null/.test(s03));

    // D（随行）：SKILL.md 接入第 1 步同样防滥用
    check('D SKILL.md 接入第 1 步注明「home 不存在时先按 SETUP §3/§5，不要跑 status」',
      /home 不存在时\*\*先按 SETUP §3\/§5/.test(skill) && /不要跑 `status`/.test(skill));

    // §0 与 SKILL 的互相引用
    check('SKILL.md 接入节含 print-config 与「会话里没有 Mebular 工具时的第一步」',
      skill.includes('print-config') && /没有 Mebular 工具时的第一步/.test(skill));
    check('SKILL.md 定位补共存（叠加/不接管，指向 MEMORY_POLICY §8）',
      skill.includes('共存') && /不接管/.test(skill) && /MEMORY_POLICY\.md`? §8/.test(skill));

    // MEMORY_POLICY §8 共存口径
    const coexistence = ['与其他记忆提供者共存', '叠加', '不接管', '不双写', '默认单向', 'memory_import', 'namespace', 'origin', '幂等', '只读'];
    const missingCo = coexistence.filter((token) => !policy.includes(token));
    check(`MEMORY_POLICY §8 共存在径锚点（${coexistence.length} 个）`, missingCo.length === 0, missingCo.join(', ') || '全部命中');
    check('MEMORY_POLICY §8 覆盖「不外溢 / 不传播 / 停用无残留」',
      /不外溢/.test(policy) && /不自动传播/.test(policy) && /停用/.test(policy) && /隐私/.test(policy));

    // ---------- G-ML-1：记忆生命周期（删除 / 归档）与工具计数 ----------
    const tasksSkill = await readFile(join(skillDir, 'tasks', 'SKILL.md'), 'utf-8');
    check('E SKILL.md 工具表计数为 13（G-ML-1：+memory_delete/memory_archive）',
      /^## 工具（13 个）$/m.test(skill), 'SKILL.md 头部计数锚点');
    check('E SKILL.md 含 memory_delete 并注明「何时用」（不可逆 / 墓碑）',
      /\|\s*`memory_delete`\s*\|/.test(skill) && /何时用/.test(skill) && /不可逆/.test(skill));
    check('E SKILL.md 含 memory_archive 并注明可逆 / 解除归档',
      /\|\s*`memory_archive`\s*\|/.test(skill) && /可逆/.test(skill) && /解除归档/.test(skill));
    check('E SKILL.md 查询面注明「默认不返回已归档」且给出 includeArchived',
      /includeArchived/.test(skill) && /默认\*{0,2}不返回已归档/.test(skill));
    check('E tasks/SKILL.md 统一入口计数为 29（记忆 13 ∪ 任务 16）',
      /29 工具中的 16 个/.test(tasksSkill));
    check('E MEMORY_POLICY §8 生命周期锚点（墓碑传播 / 归档=标记 / includeArchived / 零新增配置项）',
      /墓碑传播/.test(policy) && /归档\s*=\s*标记/.test(policy)
        && /includeArchived/.test(policy) && /零新增配置项/.test(policy));
    check('E MEMORY_POLICY §8 三问判据（跨设备稳定事实 / 会话过程产物 / 外源历史只在导入时判）',
      /稳定事实/.test(policy) && /过程产物/.test(policy) && /只在导入那一刻判/.test(policy));
    check('E MEMORY_POLICY §8 外源写权限（默认只读 / 回写仅追加 / 禁止对等双向）',
      /默认只读/.test(policy) && /回写仅追加/.test(policy) && /禁止对等双向/.test(policy));

    // install.mjs 复制 mcp/（SKILL.md 承诺成立）
    check('install.mjs 一并安装 mcp/ 片段（mebular-memory/mcp/opencode.json）',
      existsSync(join(installTarget, 'mebular-memory', 'mcp', 'opencode.json'))
        && existsSync(join(installTarget, 'mebular-memory', 'mcp', 'claude.json')));
  }
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
