// H-1 · 「连接我的 AI 助手」：客户端侦测 / 合并写入 / 备份 / 回滚 / diff / skill 安装
//
// 硬性写入规则（本模块唯一实现，供 admin 读写端点复用）：
//   1. 只**合并** `mebular` 条目（opencode: `mcp.mebular`；其余 JSON: `mcpServers.mebular`）；
//   2. 写前**先备份** `<path>.bak-<ts>`；
//   3. **原子写**（临时文件 + rename）；
//   4. 解析失败 / 结构未知 → **不写**，返回 `needsManual` + 片段；
//   5. 重复接入**幂等**（条目已等价 → changed:false，不写不备份）。
//
// 纯函数式：home/cwd/platform/env 可注入，便于单元测试（不触碰真实用户目录）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

// ---------- 片段与条目 ----------

/** 各客户端 MCP 片段（与 `mebular print-config` 同源）。 */
export function snippetFor(format) {
  if (format === 'opencode') {
    return JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { mebular: { type: 'local', command: ['mebular', 'mcp'] } } }, null, 2);
  }
  if (format === 'dsh') {
    return "plugins:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: mebular\n      transport: stdio\n      command: mebular\n      args: ['mcp']";
  }
  if (format === 'opencode-remote') {
    return JSON.stringify({ mcp: { mebular: { type: 'remote', url: 'http://127.0.0.1:7331/mcp' } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { mebular: { command: 'mebular', args: ['mcp'] } } }, null, 2);
}

/** 本机 MCP 条目（供合并）。 */
export function mebularEntry(format) {
  if (format === 'opencode') return { type: 'local', command: ['mebular', 'mcp'] };
  return { command: 'mebular', args: ['mcp'] };
}

/** 客户端描述（所有可写路径都在这里；纯数据，便于测试与文档）。 */
export function clientDescriptors(options = {}) {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const appData = platform === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : platform === 'win32'
      ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  const dshConfig = join(cwd, '.dsh', 'cordis.yml');
  return [
    {
      id: 'opencode', name: 'OpenCode', format: 'opencode', kind: 'file',
      configPath: join(home, '.config', 'opencode', 'opencode.json'),
      skillsDirs: [join(home, '.config', 'opencode', 'skills'), join(home, '.agents', 'skills'), join(cwd, '.agents', 'skills'), join(cwd, '.opencode', 'skills')],
      requiresRestart: true,
    },
    {
      // OpenChamber 复用 opencode 的配置（同一文件）；单独呈现以便用户找到它。
      id: 'openchamber', name: 'OpenChamber', format: 'opencode', kind: 'file',
      configPath: join(home, '.config', 'opencode', 'opencode.json'),
      skillsDirs: [join(home, '.config', 'opencode', 'skills')],
      requiresRestart: true, reuseOf: 'opencode',
      note: 'OpenChamber 复用 OpenCode 的 MCP 配置（同一文件，接一次即可）',
    },
    {
      id: 'claude-code', name: 'Claude Code', format: 'mcpServers', kind: 'file',
      configPath: join(home, '.claude.json'),
      skillsDirs: [join(home, '.agents', 'skills'), join(cwd, '.agents', 'skills')],
      requiresRestart: true,
    },
    {
      id: 'claude-desktop', name: 'Claude Desktop', format: 'mcpServers', kind: 'file',
      configPath: join(appData, 'Claude', 'claude_desktop_config.json'),
      skillsDirs: [],
      requiresRestart: true,
    },
    {
      id: 'cursor', name: 'Cursor', format: 'mcpServers', kind: 'file',
      configPath: join(home, '.cursor', 'mcp.json'),
      skillsDirs: [],
      requiresRestart: true,
    },
    {
      id: 'dsh', name: 'DeepSeek Harness (DSH)', format: 'dsh', kind: 'file',
      configPath: dshConfig,
      skillsDirs: [join(cwd, '.dsh', 'skills'), join(home, '.agents', 'skills')],
      requiresRestart: true,
    },
    {
      id: 'generic', name: '其他 AI 助手（复制片段）', format: 'generic', kind: 'snippet',
      configPath: null, skillsDirs: [], requiresRestart: true,
      note: '不支持自动写入：复制片段粘贴到你的 MCP 配置',
    },
  ];
}

export function descriptorFor(id, options = {}) {
  return clientDescriptors(options).find((d) => d.id === id) ?? null;
}

// ---------- 合并（只并 mebular 键；结构未知 → 不写） ----------

/** JSON 合并：设置或删除 `root[key].mebular`，保留其余键。 */
export function mergeJsonEntry(existingText, { format, entry }) {
  let parsed;
  if (existingText === null || existingText.trim() === '') {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(existingText);
    } catch (error) {
      return { error: `配置不是合法 JSON（${error instanceof Error ? error.message : String(error)}）` };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '配置顶层不是对象（结构未知，不自动改写）' };
  }
  const key = format === 'opencode' ? 'mcp' : 'mcpServers';
  const current = parsed[key];
  if (current !== undefined && (current === null || typeof current !== 'object' || Array.isArray(current))) {
    return { error: `字段 ${key} 结构未知（非对象，不自动改写）` };
  }
  const section = { ...(current ?? {}) };
  const changed = JSON.stringify(section.mebular ?? null) !== JSON.stringify(entry ?? null);
  if (entry === undefined) delete section.mebular;
  else section.mebular = entry;
  const next = { ...parsed, [key]: section };
  return { changed, next, text: `${JSON.stringify(next, null, 2)}\n` };
}

/** DSH(YAML) 合并：空文件 → 写片段；已含 serverName: mebular → 幂等；结构未知 → 不写。 */
export function mergeDsh(existingText) {
  const snippet = snippetFor('dsh');
  if (existingText === null || existingText.trim() === '') return { changed: true, text: `${snippet}\n` };
  if (/serverName:\s*['"]?mebular['"]?/.test(existingText)) return { changed: false, text: existingText };
  return { error: 'DSH 配置已存在但未接入：YAML 结构未知，未自动改写（请按片段人工合并）' };
}

/** 行级 diff（信任增强：写入前后预览）。 */
export function lineDiff(before, after) {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
  }
  return out.join('\n');
}

function computeMerged(desc, existing) {
  return desc.format === 'dsh'
    ? mergeDsh(existing)
    : mergeJsonEntry(existing, { format: desc.format, entry: mebularEntry(desc.format) });
}

// ---------- 侦测 ----------

function isConnected(desc, text) {
  if (text === null) return false;
  if (desc.format === 'dsh') return /serverName:\s*['"]?mebular['"]?/.test(text);
  try {
    const parsed = JSON.parse(text);
    const key = desc.format === 'opencode' ? 'mcp' : 'mcpServers';
    const entry = parsed?.[key]?.mebular;
    return entry !== undefined && JSON.stringify(entry) === JSON.stringify(mebularEntry(desc.format));
  } catch {
    return false;
  }
}

function safeReadText(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

export function detectClients(options = {}) {
  return clientDescriptors(options).map((desc) => {
    const text = desc.configPath ? safeReadText(desc.configPath) : null;
    const skillsInstalled = (desc.skillsDirs ?? []).some((d) => existsSync(join(d, 'mebular-memory', 'SKILL.md')));
    let parseError = null;
    if (text !== null && desc.kind === 'file' && desc.format !== 'dsh') {
      const merged = computeMerged(desc, text);
      if (merged.error) parseError = merged.error;
    }
    return {
      id: desc.id,
      name: desc.name,
      format: desc.format,
      configPath: desc.configPath ?? null,
      installed: desc.kind === 'file' ? text !== null : false,
      connected: isConnected(desc, text),
      skillsInstalled,
      requiresRestart: desc.requiresRestart === true,
      needsManual: Boolean(parseError),
      parseError,
      snippet: snippetFor(desc.format),
      reuseOf: desc.reuseOf ?? null,
      note: desc.note ?? null,
      skillsDirs: desc.skillsDirs ?? [],
    };
  });
}

// ---------- 接入 / 预览 / 回滚 ----------

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf-8');
  await rename(tmp, path);
}

export function previewClient(id, options = {}) {
  const desc = descriptorFor(id, options);
  if (!desc) return { ok: false, reason: `未知客户端：${id}` };
  if (!desc.configPath) return { ok: true, needsManual: true, snippet: snippetFor(desc.format), preview: '' };
  const existing = safeReadText(desc.configPath);
  const merged = computeMerged(desc, existing);
  if (merged.error) return { ok: true, needsManual: true, reason: merged.error, snippet: snippetFor(desc.format), preview: '' };
  return { ok: true, changed: merged.changed, preview: lineDiff(existing ?? '', merged.text), configPath: desc.configPath };
}

/**
 * 接入：合并写入（备份 → 原子写 → 幂等）。重复接入等价条目 → changed:false（不写不备份）。
 */
export async function connectClient(id, options = {}) {
  const desc = descriptorFor(id, options);
  if (!desc) return { ok: false, reason: `未知客户端：${id}` };
  if (!desc.configPath) {
    return { ok: false, needsManual: true, snippet: snippetFor(desc.format), reason: '该客户端不支持自动写入：请复制片段' };
  }
  const existing = safeReadText(desc.configPath);
  const merged = computeMerged(desc, existing);
  if (merged.error) {
    return { ok: false, needsManual: true, snippet: snippetFor(desc.format), reason: merged.error, configPath: desc.configPath };
  }
  const preview = lineDiff(existing ?? '', merged.text);
  if (!merged.changed) {
    return { ok: true, changed: false, configPath: desc.configPath, backupPath: null, preview, note: '已接入（幂等：无需改动）' };
  }
  let backupPath = null;
  if (existing !== null) {
    backupPath = `${desc.configPath}.bak-${tsStamp()}`;
    await copyFile(desc.configPath, backupPath);
  }
  await atomicWrite(desc.configPath, merged.text);
  return { ok: true, changed: true, configPath: desc.configPath, backupPath, preview };
}

/** 回滚：显式备份优先；否则取最近一次备份还原；无备份则删除 mebular 条目（DSH 除外）。 */
export async function rollbackClient(id, options = {}) {
  const desc = descriptorFor(id, options);
  if (!desc || !desc.configPath) return { ok: false, reason: `未知客户端：${id}` };
  const existing = safeReadText(desc.configPath);
  if (existing === null) return { ok: false, reason: '配置文件不存在，无需回滚' };
  const dir = dirname(desc.configPath);
  const base = `${desc.configPath.slice(desc.configPath.lastIndexOf(sep) + 1)}.bak-`;
  const candidates = readdirSync(dir).filter((f) => f.startsWith(base)).sort();
  const target = options.backupPath ?? (candidates.length > 0 ? join(dir, candidates[candidates.length - 1]) : null);
  const safety = `${desc.configPath}.bak-${tsStamp()}`;
  await copyFile(desc.configPath, safety);
  if (target) {
    await atomicWrite(desc.configPath, await readFile(target, 'utf-8'));
    return { ok: true, restoredFrom: target, backupPath: safety, removed: false };
  }
  if (desc.format === 'dsh') return { ok: false, reason: 'DSH 无备份可回滚：请按片段人工移除' };
  const merged = mergeJsonEntry(existing, { format: desc.format, entry: undefined });
  if (merged.error) return { ok: false, reason: merged.error };
  await atomicWrite(desc.configPath, merged.text);
  return { ok: true, restoredFrom: null, backupPath: safety, removed: true };
}

// ---------- Skill 安装 ----------

/**
 * 安装 mebular-memory + mebular-tasks 到该客户端首个已知 Skill 目录（复用 skill 包文件语义）。
 * 源目录取 `skillRoot`（缺省 = <repo>/packages/skill）。
 */
export async function installSkills(id, options = {}) {
  const desc = descriptorFor(id, options);
  if (!desc) return { ok: false, reason: `未知客户端：${id}` };
  const dirs = (desc.skillsDirs ?? []).filter(Boolean);
  if (dirs.length === 0) return { ok: false, reason: '该客户端没有已知的 Skill 目录' };
  const root = options.skillRoot ?? join(options.repoRoot ?? process.cwd(), 'packages', 'skill');
  if (!existsSync(join(root, 'SKILL.md'))) {
    return { ok: false, reason: `未找到 Skill 源（${root}）`, snippet: '请在仓库内运行，或手动复制 Skill 目录' };
  }
  const target = dirs[0];
  const mem = join(target, 'mebular-memory');
  const tasks = join(target, 'mebular-tasks');
  await mkdir(mem, { recursive: true });
  await mkdir(tasks, { recursive: true });
  await copyFile(join(root, 'SKILL.md'), join(mem, 'SKILL.md'));
  await copyFile(join(root, 'MEMORY_POLICY.md'), join(mem, 'MEMORY_POLICY.md'));
  await copyFile(join(root, 'SETUP.md'), join(mem, 'SETUP.md'));
  await copyFile(join(root, 'tasks', 'SKILL.md'), join(tasks, 'SKILL.md'));
  await copyFile(join(root, 'SETUP.md'), join(tasks, 'SETUP.md'));
  return { ok: true, installed: [mem, tasks] };
}
