// 受管标记路径安全：force 清理旧文件时绝不越出 Skill 目录；合法旧文件仍会清理。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installSkillsToDir,
  isSafeManagedRelPath,
} from '../../packages/mcp/src/clients.mjs';

describe('Skill 受管标记路径安全', () => {
  let root;
  let skillRoot;
  let target;

  const memDir = () => join(target, 'mebular-memory');
  const markerPath = () => join(memDir(), '.mebular-skill.json');

  async function makeSkillSource() {
    await mkdir(join(skillRoot, 'mcp'), { recursive: true });
    await mkdir(join(skillRoot, 'tasks'), { recursive: true });
    await writeFile(join(skillRoot, 'SKILL.md'), 'S1', 'utf-8');
    await writeFile(join(skillRoot, 'MEMORY_POLICY.md'), 'M1', 'utf-8');
    await writeFile(join(skillRoot, 'SETUP.md'), 'U1', 'utf-8');
    await writeFile(join(skillRoot, 'tasks', 'SKILL.md'), 'T1', 'utf-8');
    await writeFile(join(skillRoot, 'mcp', 'opencode.json'), '{"mcp":{}}', 'utf-8');
    await writeFile(join(skillRoot, 'package.json'), JSON.stringify({ name: 'fake-skill', version: '9.9.9' }), 'utf-8');
  }

  async function writeMarker(files) {
    await mkdir(memDir(), { recursive: true });
    await writeFile(join(memDir(), 'SKILL.md'), 'OLD', 'utf-8');
    await writeFile(markerPath(), JSON.stringify({
      schema: 1,
      managedBy: 'mebular',
      skill: 'mebular-memory',
      version: '0.0.1',
      installedAt: new Date().toISOString(),
      source: 'mebular',
      files,
    }, null, 2), 'utf-8');
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-marker-security-'));
    skillRoot = join(root, 'source');
    target = join(root, 'target');
    await makeSkillSource();
    await mkdir(target, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('isSafeManagedRelPath：拒绝绝对路径/盘符/反斜杠/空段/./..', () => {
    for (const rel of ['SKILL.md', 'mcp/opencode.json', 'tasks/SKILL.md']) {
      expect(isSafeManagedRelPath(rel)).toBe(true);
    }
    for (const rel of [
      '../outside.txt',
      '..\\outside.txt',
      '/tmp/outside.txt',
      'C:/outside.txt',
      'C:\\outside.txt',
      'a/../../outside.txt',
      './SKILL.md',
      'a//b',
      'a/./b',
      'a/../b',
      '',
      null,
      42,
    ]) {
      expect(isSafeManagedRelPath(rel)).toBe(false);
    }
  });

  it('force 更新：标记里的 ../outside.txt / ..\\outside.txt 不会删除 Skill 目录外文件', async () => {
    const outside = join(target, 'outside.txt');
    await writeFile(outside, 'DO NOT DELETE', 'utf-8');
    await writeMarker({
      '../outside.txt': 'deadbeef',
      '..\\outside.txt': 'deadbeef',
      '../../outside.txt': 'deadbeef',
    });

    const result = await installSkillsToDir(target, { skillRoot, force: true });
    expect(result.ok).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(await readFile(outside, 'utf-8')).toBe('DO NOT DELETE');
    // 受管文件本身仍被 force 覆盖
    expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('S1');
  });

  it('合法旧受管文件仍会按标记清理（避免修过头）', async () => {
    await writeMarker({ 'OLD.md': 'deadbeef' });
    const old = join(memDir(), 'OLD.md');
    await writeFile(old, 'old managed file', 'utf-8');

    const result = await installSkillsToDir(target, { skillRoot, force: true });
    expect(result.ok).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(memDir(), 'SKILL.md'))).toBe(true);
  });
});
