// 应用仓库 rulesets（分支保护）：.github/rulesets/*.json → GitHub API
//
// 用法：
//   node scripts/apply-rulesets.mjs            # dry-run：只打印计划
//   node scripts/apply-rulesets.mjs --apply    # 创建/更新（需要 GH_TOKEN / GITHUB_TOKEN，权限：repo admin）
//
// 设计：ruleset 以仓库内 JSON 为准（可评审、可回放），脚本按 name 幂等创建或更新；
// 管理员的 bypass 在 JSON 中声明，避免误锁维护者。

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rulesetDir = join(__dirname, '..', '.github', 'rulesets');
const repo = process.env.GITHUB_REPOSITORY ?? 'Windsander/Mebular';
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
const apply = process.argv.includes('--apply');

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'mebular-rulesets',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}：${json?.message ?? text.slice(0, 200)}`);
  }
  return json;
};

const loadRulesets = async () => {
  const files = (await readdir(rulesetDir)).filter((name) => name.endsWith('.json')).sort();
  const rulesets = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(rulesetDir, file), 'utf-8'));
    if (typeof parsed?.name !== 'string' || !Array.isArray(parsed.rules)) {
      throw new Error(`ruleset 定义非法：${file}`);
    }
    rulesets.push({ file, data: parsed });
  }
  return rulesets;
};

const main = async () => {
  const rulesets = await loadRulesets();
  console.log(`rulesets 定义：${rulesets.map((r) => r.data.name).join('、')}`);
  if (!apply) {
    console.log('（dry-run）使用 --apply 实际创建/更新');
    return;
  }
  if (!token) {
    throw new Error('缺少 GH_TOKEN / GITHUB_TOKEN（需 repo admin 权限）');
  }
  const existing = await api('GET', '/rulesets');
  for (const { file, data } of rulesets) {
    const found = existing.find((item) => item.name === data.name);
    if (found) {
      await api('PUT', `/rulesets/${found.id}`, data);
      console.log(`✓ 更新 ruleset：${data.name}（id=${found.id}，${file}）`);
    } else {
      const created = await api('POST', '/rulesets', data);
      console.log(`✓ 创建 ruleset：${data.name}（id=${created.id}，${file}）`);
    }
  }
  const after = await api('GET', '/rulesets');
  for (const item of after) {
    console.log(`  - ${item.name}：${item.enforcement}（${item.target}）`);
  }
};

main().catch((error) => {
  console.error(`✗ apply-rulesets：${error?.message ?? error}`);
  process.exit(1);
});
