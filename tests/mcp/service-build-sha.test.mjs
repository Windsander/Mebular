// F-INSTALL-1：service install 的 sha 与 cwd 解耦（packages/mcp/src/build-sha.mjs）。
//
// 真机实证（2026-10-15）：同一全局安装的 `mebular service install`，cwd=仓库 → sha=c61aac3…；
// cwd=$HOME → sha=unknown（旧 resolveBuildSha 默认 git rev-parse 于 process.cwd()）。
// 修复后：env → 模块邻接 version.json → 模块所在仓库 git，三者均与调用者 cwd 无关。

import { describe, it, expect } from '@jest/globals';
import { tmpdir } from 'node:os';
import { serviceBuildSha } from '../../packages/mcp/src/build-sha.mjs';

describe('F-INSTALL-1 serviceBuildSha：sha 解析与 cwd 解耦', () => {
  it('env 覆盖优先（MEBULAR_BUILD_SHA / MEBULAR_SERVICE_SHA）', () => {
    expect(serviceBuildSha({ MEBULAR_BUILD_SHA: 'deadbeef' })).toBe('deadbeef');
    expect(serviceBuildSha({ MEBULAR_SERVICE_SHA: 'cafe' })).toBe('cafe');
  });

  it('两 cwd 用例：仓库内与非仓库目录解析出同一 sha（且可解析）', () => {
    const env = { PATH: process.env.PATH }; // 清空 MEBULAR_* 覆盖，只留 PATH 供 git
    const inRepo = serviceBuildSha(env);
    const before = process.cwd();
    process.chdir(tmpdir());
    let outside;
    try {
      outside = serviceBuildSha(env);
    } finally {
      process.chdir(before);
    }
    // 测试在仓库检出且已构建的环境运行：version.json（构建期）或模块所在仓库 git 必居其一
    expect(inRepo).not.toBe('unknown');
    expect(outside).toBe(inRepo); // 与 cwd 无关
  });

  it('sha 值为 40 位十六进制（构建元数据或 git HEAD）', () => {
    const sha = serviceBuildSha({ PATH: process.env.PATH });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
