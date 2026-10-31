// 发布后 npm 可见性 gate：确定性 fixture（fake viewPackage + fake clock）。

import { describe, it, expect } from '@jest/globals';
import {
  buildReleasePackages,
  formatVisibilityResult,
  npmViewArgs,
  parseViewOutput,
  verifyVisibility,
} from '../../scripts/verify-release-visibility.mjs';

const VERSION = '0.2.0';

function e404() {
  const error = new Error('npm error code E404');
  error.stderr = 'npm error code E404\nnpm error 404 Not Found';
  return error;
}

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

describe('verify-release-visibility：八包与 latest gate', () => {
  it('逐轮重试直到八包可见且 latest 全部指向发布版本', async () => {
    const attempts = new Map();
    const viewPackage = async (name, version) => {
      const attempt = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attempt);
      if (name === '@mebular/mcp') {
        if (attempt <= 2) throw e404();
        if (attempt === 3) return { version, latest: '0.1.1' };
      }
      return { version, latest: version };
    };
    const clock = fakeClock();
    const result = await verifyVisibility({
      packages: buildReleasePackages({ version: VERSION }),
      timeoutMs: 100_000,
      intervalMs: 1_000,
      viewPackage,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.ok).toBe(true);
    expect(result.packages).toHaveLength(8);
    expect(result.rounds).toBe(4);
    const mcp = result.packages.find((pkg) => pkg.name === '@mebular/mcp');
    expect(mcp).toMatchObject({ ok: true, attempts: 4, versionVisible: true, latest: VERSION });
    expect(clock.now()).toBe(3_000);
  });

  it('超时后失败，并逐包保留最后状态（E404 / latest 落后）', async () => {
    const viewPackage = async (name, version) => {
      if (name === '@mebular/mcp') throw e404();
      if (name === '@mebular/dsh-plugin') return { version, latest: '0.1.1' };
      return { version, latest: version };
    };
    const clock = fakeClock();
    const result = await verifyVisibility({
      packages: buildReleasePackages({ version: VERSION }),
      timeoutMs: 3_000,
      intervalMs: 1_000,
      viewPackage,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.ok).toBe(false);
    expect(result.rounds).toBe(3);
    const mcp = result.packages.find((pkg) => pkg.name === '@mebular/mcp');
    expect(mcp.ok).toBe(false);
    expect(mcp.versionVisible).toBe(false);
    expect(mcp.lastError).toMatch(/E404/);
    const dsh = result.packages.find((pkg) => pkg.name === '@mebular/dsh-plugin');
    expect(dsh.ok).toBe(false);
    expect(dsh.lastError).toContain('dist-tags.latest=0.1.1');

    const text = formatVisibilityResult(result);
    expect(text).toContain('Release visibility FAIL');
    expect(text).toContain('@mebular/mcp@0.2.0');
    expect(text).toContain('@mebular/dsh-plugin@0.2.0');
  });

  it('timeout=0 也至少检查一轮，不会只 sleep', async () => {
    let calls = 0;
    const result = await verifyVisibility({
      packages: [{ name: '@mebular/core', version: VERSION }],
      timeoutMs: 0,
      intervalMs: 1_000,
      viewPackage: async () => {
        calls += 1;
        throw e404();
      },
      sleep: async () => {
        throw new Error('timeout=0 不应 sleep');
      },
      now: () => 0,
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.rounds).toBe(1);
  });
});

describe('verify-release-visibility：参数与输出解析', () => {
  it('buildReleasePackages 为 7 个 lockstep + dsh-plugin 使用独立版本', () => {
    const packages = buildReleasePackages({ version: '0.2.0', dshVersion: '0.2.1' });
    expect(packages).toHaveLength(8);
    expect(packages.filter((pkg) => pkg.version === '0.2.0')).toHaveLength(7);
    expect(packages.find((pkg) => pkg.name === '@mebular/opencode-plugin')).toEqual({
      name: '@mebular/opencode-plugin',
      version: '0.2.0',
    });
    expect(packages.find((pkg) => pkg.name === '@mebular/dsh-plugin')).toEqual({
      name: '@mebular/dsh-plugin',
      version: '0.2.1',
    });
  });

  it('npm view 同时查询 version 与 dist-tags.latest，并强制在线校验', () => {
    const args = npmViewArgs('@mebular/core', '0.2.0');
    expect(args).toEqual([
      'view',
      '@mebular/core@0.2.0',
      'version',
      'dist-tags.latest',
      '--json',
      '--prefer-online',
    ]);
  });

  it('parseViewOutput 兼容对象与单字段输出', () => {
    expect(parseViewOutput('{"version":"0.2.0","dist-tags.latest":"0.2.0"}')).toEqual({
      version: '0.2.0',
      latest: '0.2.0',
    });
    expect(parseViewOutput('"0.2.0"')).toEqual({ version: '0.2.0', latest: null });
  });
});
