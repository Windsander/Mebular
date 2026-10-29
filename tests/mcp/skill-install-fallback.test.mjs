// 独立 @mebular/skill 回落安装：默认保留用户 Skill，--force 才覆盖，受管旧版可更新。
//
// 用 MEBULAR_SKILL_INSTALL_FALLBACK=1 强制走 install.mjs 的独立包回落路径（不依赖 mcp 包）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'packages', 'skill', 'scripts', 'install.mjs');

function runInstall(target, args = []) {
  return spawnSync(process.execPath, [SCRIPT, '--target', target, ...args], {
    cwd: dirname(target),
    encoding: 'utf-8',
    env: { ...process.env, MEBULAR_SKILL_INSTALL_FALLBACK: '1', NODE_NO_WARNINGS: '1' },
  });
}

describe('@mebular/skill 独立包回落安装', () => {
  let root;
  let target;
  const mem = () => join(target, 'mebular-memory');
  const tasks = () => join(target, 'mebular-tasks');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-fallback-'));
    target = join(root, 'skills');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('缺失 → 安装（含 mcp/ 与受管标记）；受管未改 → unchanged', async () => {
    const first = runInstall(target);
    expect(first.status).toBe(0);
    expect(existsSync(join(mem(), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(mem(), 'mcp', 'opencode.json'))).toBe(true);
    expect(existsSync(join(tasks(), 'SKILL.md'))).toBe(true);
    const marker = JSON.parse(await readFile(join(mem(), '.mebular-skill.json'), 'utf-8'));
    expect(marker).toMatchObject({ schema: 1, managedBy: 'mebular', skill: 'mebular-memory' });
    expect(marker.files['mcp/opencode.json']).toMatch(/^[0-9a-f]{64}$/);

    const second = runInstall(target);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/所有目标均已是最新|kept|installed/);
  });

  it('用户自定义（无标记）→ 默认保留，--force 才覆盖', async () => {
    await mkdir(mem(), { recursive: true });
    await writeFile(join(mem(), 'SKILL.md'), 'CUSTOM USER SKILL', 'utf-8');

    const kept = runInstall(target);
    expect(kept.status).toBe(0);
    expect(await readFile(join(mem(), 'SKILL.md'), 'utf-8')).toBe('CUSTOM USER SKILL');
    expect(kept.stdout).toMatch(/kept .*mebular-memory/);

    const forced = runInstall(target, ['--force']);
    expect(forced.status).toBe(0);
    const after = await readFile(join(mem(), 'SKILL.md'), 'utf-8');
    expect(after).not.toBe('CUSTOM USER SKILL');
    expect(after).toMatch(/name:\s*mebular-memory/);
  });

  it('受管且用户改过 → 默认保留；受管旧版未改 → 更新', async () => {
    expect(runInstall(target).status).toBe(0);
    await writeFile(join(mem(), 'SKILL.md'), 'USER EDITED', 'utf-8');
    const kept = runInstall(target);
    expect(kept.status).toBe(0);
    expect(await readFile(join(mem(), 'SKILL.md'), 'utf-8')).toBe('USER EDITED');

    // 恢复受管文件并伪造旧版本 → 无 force 也应更新
    expect(runInstall(target, ['--force']).status).toBe(0);
    const markerPath = join(mem(), '.mebular-skill.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf-8'));
    await writeFile(markerPath, JSON.stringify({ ...marker, version: '0.0.1' }, null, 2), 'utf-8');
    const updated = runInstall(target);
    expect(updated.status).toBe(0);
    expect(JSON.parse(await readFile(markerPath, 'utf-8')).version).not.toBe('0.0.1');
  });

  it('fallback force：标记里的 ../outside.txt 不会删除目标目录外文件', async () => {
    expect(runInstall(target).status).toBe(0);
    const outside = join(target, 'outside.txt');
    await writeFile(outside, 'DO NOT DELETE', 'utf-8');
    const markerPath = join(mem(), '.mebular-skill.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf-8'));
    marker.files['../outside.txt'] = 'deadbeef';
    marker.files['..\\outside.txt'] = 'deadbeef';
    await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');

    const forced = runInstall(target, ['--force']);
    expect(forced.status).toBe(0);
    expect(existsSync(outside)).toBe(true);
    expect(await readFile(outside, 'utf-8')).toBe('DO NOT DELETE');
  });
});
