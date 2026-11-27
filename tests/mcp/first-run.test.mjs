// 0.4.0 W1b：全新空 home 首启初始化（unit）。
//
// 覆盖：
// - 空 home → enabled=true + sidecar source=auto（sourcePresent=true）+ effective=model；
// - 已有配置（enabled/source/legacy mode 各种组合）逐字保留、不写 marker；
// - 已有用户缺 source → 仍 off/baseline（继承 W1a）；
// - 写失败/目录异常 → 保持 off、不抛异常；
// - 重复首次运行幂等。

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  FIRST_RUN_DISCLOSURE_VERSION,
  detectFreshHome,
  firstRunPublicView,
  initializeFirstRunHome,
  markFirstRunAcked,
  markFirstRunPending,
  readFirstRunMarker,
} from '../../packages/mcp/src/first-run.mjs';
import { readMemoryRuntimeModelSource } from '../../packages/mcp/src/memory-runtime-config.mjs';
import { resolveMemoryRuntimeEffectiveMode } from '../../packages/mcp/src/memory-runtime-effective.mjs';

const makeHome = () => mkdtemp(join(tmpdir(), 'mebular-first-run-'));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf-8'));
const readText = async (path) => readFile(path, 'utf-8');
const HOME_ENV = Object.freeze({});

async function freshHomeWithAck({ config = null } = {}) {
  const home = await makeHome();
  expect(await detectFreshHome({ home, env: HOME_ENV })).toBe(true);
  expect(await markFirstRunPending({ home, env: HOME_ENV })).toMatchObject({
    state: 'pending',
    disclosureVersion: FIRST_RUN_DISCLOSURE_VERSION,
  });
  expect(await markFirstRunAcked({ home, disclosureVersion: FIRST_RUN_DISCLOSURE_VERSION }))
    .toMatchObject({ state: 'acked' });
  if (config !== null) {
    await writeFile(join(home, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2), 'utf-8');
  }
  return home;
}

describe('first-run 空 home 初始化', () => {
  it('空 home → enabled=true + source=auto + sourcePresent=true + effective=model', async () => {
    const home = await freshHomeWithAck({
      config: {
        storagePath: join(await makeHome(), 'store.jsonl'),
        encryption: { level: 'none' },
        network: { enabled: true },
        mcp: { http: { host: '127.0.0.1', port: 7331 } },
      },
    });
    const before = await readJson(join(home, 'config.json'));

    const init = await initializeFirstRunHome({ home, env: HOME_ENV });
    expect(init).toMatchObject({
      ok: true,
      initialized: true,
      enabled: true,
      source: 'auto',
      sidecarSeed: 'created',
    });

    const config = await readJson(join(home, 'config.json'));
    expect(config.memoryRuntime).toEqual({ enabled: true });
    // provision 已写字段逐字保留；不引入第二个 mode。
    expect(config.storagePath).toBe(before.storagePath);
    expect(config.encryption).toEqual({ level: 'none' });
    expect(config.network).toEqual({ enabled: true });
    expect(config.mcp).toEqual(before.mcp);
    expect('intervention' in config).toBe(false);

    // sidecar seed 显式写 source=auto，而不是依赖默认 heuristic。
    const sidecar = await readJson(join(home, 'memory-runtime', 'config.json'));
    expect(sidecar).toEqual({ schema: 1, model: { source: 'auto' } });

    const source = await readMemoryRuntimeModelSource({ home, env: HOME_ENV });
    expect(source).toMatchObject({ source: 'auto', sourcePresent: true, exists: true });

    const effective = resolveMemoryRuntimeEffectiveMode({
      config,
      modelSource: source.source,
      sourcePresent: source.sourcePresent,
    });
    expect(effective).toMatchObject({
      mode: 'immersive',
      enabled: true,
      effective: 'model',
      planner: 'model',
      source: 'auto',
      sourcePresent: true,
    });

    const marker = await readFirstRunMarker({ home });
    expect(marker?.state).toBe('done');
    expect(marker?.initializedAt).toBeTruthy();
    expect(firstRunPublicView(marker)).toMatchObject({ pending: false, state: 'done' });
  });

  it('重复首次运行幂等：第二次不重写配置', async () => {
    const home = await freshHomeWithAck({ config: { storagePath: '/tmp/store.jsonl' } });
    expect((await initializeFirstRunHome({ home, env: HOME_ENV })).ok).toBe(true);
    const firstConfig = await readText(join(home, 'config.json'));
    const firstSidecar = await readText(join(home, 'memory-runtime', 'config.json'));

    const again = await initializeFirstRunHome({ home, env: HOME_ENV });
    expect(again).toMatchObject({ ok: true, skipped: 'done' });
    expect(await readText(join(home, 'config.json'))).toBe(firstConfig);
    expect(await readText(join(home, 'memory-runtime', 'config.json'))).toBe(firstSidecar);
  });

  it('已有 sidecar source 不被覆盖（只补 enabled）', async () => {
    const home = await freshHomeWithAck({ config: { storagePath: '/tmp/store.jsonl' } });
    await mkdir(join(home, 'memory-runtime'), { recursive: true });
    await writeFile(
      join(home, 'memory-runtime', 'config.json'),
      JSON.stringify({ schema: 1, model: { source: 'local' } }),
      'utf-8',
    );
    const init = await initializeFirstRunHome({ home, env: HOME_ENV });
    expect(init).toMatchObject({ ok: true, sidecarSeed: 'existing' });
    expect(await readJson(join(home, 'memory-runtime', 'config.json')))
      .toEqual({ schema: 1, model: { source: 'local' } });
    expect((await readJson(join(home, 'config.json'))).memoryRuntime).toEqual({ enabled: true });
  });
});

describe('已有用户配置逐字保留', () => {
  const cases = [
    {
      name: '显式 enabled=false',
      config: { memoryRuntime: { enabled: false }, storagePath: '/tmp/store.jsonl' },
    },
    {
      name: '缺少 memoryRuntime 字段',
      config: { storagePath: '/tmp/store.jsonl', mcp: { http: { port: 7331 } } },
    },
    {
      name: 'enabled=true 但 sidecar 缺 source',
      config: { memoryRuntime: { enabled: true } },
      sidecar: { schema: 1 },
    },
    {
      name: 'enabled=true + source=local',
      config: { memoryRuntime: { enabled: true } },
      sidecar: { schema: 1, model: { source: 'local' } },
    },
    {
      name: '旧 intervention.mode 组合',
      config: {
        memoryRuntime: { enabled: true },
        intervention: { mode: 'heuristic' },
        storagePath: '/tmp/store.jsonl',
      },
      sidecar: { schema: 1, model: { source: 'api' } },
    },
    {
      name: '显式 enabled=false + 旧 mode=model',
      config: { memoryRuntime: { enabled: false }, intervention: { mode: 'model' } },
      sidecar: { schema: 1, model: { source: 'host' } },
    },
  ];

  for (const entry of cases) {
    it(`${entry.name}：不命中 first-run、不写 marker、文件逐字不变`, async () => {
      const home = await makeHome();
      const raw = `${JSON.stringify(entry.config, null, 4)}\n`;
      await writeFile(join(home, 'config.json'), raw, 'utf-8');
      let sidecarRaw = null;
      if (entry.sidecar) {
        await mkdir(join(home, 'memory-runtime'), { recursive: true });
        sidecarRaw = `${JSON.stringify(entry.sidecar, null, 4)}\n`;
        await writeFile(join(home, 'memory-runtime', 'config.json'), sidecarRaw, 'utf-8');
      }

      expect(await detectFreshHome({ home, env: HOME_ENV })).toBe(false);
      expect(await markFirstRunPending({ home, env: HOME_ENV })).toBeNull();
      expect(existsSync(join(home, 'first-run.json'))).toBe(false);
      expect(await initializeFirstRunHome({ home, env: HOME_ENV }))
        .toMatchObject({ ok: false, reason: 'no_marker' });

      expect(await readText(join(home, 'config.json'))).toBe(raw);
      if (sidecarRaw !== null) {
        expect(await readText(join(home, 'memory-runtime', 'config.json'))).toBe(sidecarRaw);
      }
    });
  }

  it('已有 enabled=true 但缺 source → off/baseline，不补 auto', async () => {
    const home = await makeHome();
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ memoryRuntime: { enabled: true } }),
      'utf-8',
    );
    expect(await detectFreshHome({ home, env: HOME_ENV })).toBe(false);
    const source = await readMemoryRuntimeModelSource({ home, env: HOME_ENV });
    expect(source).toMatchObject({ source: 'heuristic', sourcePresent: false, exists: false });
    const effective = resolveMemoryRuntimeEffectiveMode({
      config: await readJson(join(home, 'config.json')),
      modelSource: source.source,
      sourcePresent: source.sourcePresent,
    });
    expect(effective).toMatchObject({
      mode: 'immersive',
      effective: 'off',
      planner: 'off',
      sourcePresent: false,
    });
    expect(existsSync(join(home, 'memory-runtime', 'config.json'))).toBe(false);
  });

  it('非空但只有无关文件 → 不命中 first-run', async () => {
    const home = await makeHome();
    await writeFile(join(home, 'notes.txt'), 'keep me', 'utf-8');
    expect(await detectFreshHome({ home, env: HOME_ENV })).toBe(false);
    expect(await markFirstRunPending({ home, env: HOME_ENV })).toBeNull();
    expect(existsSync(join(home, 'first-run.json'))).toBe(false);
  });

  it('显式 MEBULAR_CONFIG / MEBULAR_MEMORY_RUNTIME_HOME → 一律跳过', async () => {
    for (const env of [
      { MEBULAR_CONFIG: '/tmp/elsewhere/config.json' },
      { MEBULAR_MEMORY_RUNTIME_HOME: '/tmp/elsewhere/runtime' },
    ]) {
      const home = await makeHome();
      expect(await detectFreshHome({ home, env })).toBe(false);
      expect(await markFirstRunPending({ home, env })).toBeNull();
      expect(existsSync(join(home, 'first-run.json'))).toBe(false);
    }
  });

  it('外部 MEBULAR_STORAGE_PATH（已有 store）→ 不写 marker、不披露、不启用', async () => {
    const home = await makeHome();
    const external = await makeHome();
    const store = join(external, 'store.jsonl');
    await writeFile(store, '{"id":"existing"}\n', 'utf-8');
    const env = { MEBULAR_STORAGE_PATH: store };
    expect(await detectFreshHome({ home, env })).toBe(false);
    expect(await markFirstRunPending({ home, env })).toBeNull();
    expect(existsSync(join(home, 'first-run.json'))).toBe(false);
    expect(await initializeFirstRunHome({ home, env }))
      .toMatchObject({ ok: false, reason: 'no_marker' });
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });
});

describe('失败闭合', () => {
  it('sidecar 目录异常 → 不写 enabled，marker 保持 acked', async () => {
    const home = await freshHomeWithAck({ config: { storagePath: '/tmp/store.jsonl' } });
    // 把 sidecar dataDir 占成普通文件，mkdir 必失败。
    await writeFile(join(home, 'memory-runtime'), 'not a directory', 'utf-8');
    const init = await initializeFirstRunHome({ home, env: HOME_ENV });
    expect(init).toMatchObject({ ok: false, reason: 'sidecar_seed_failed' });
    const config = await readJson(join(home, 'config.json'));
    expect(config.memoryRuntime).toBeUndefined();
    expect((await readFirstRunMarker({ home }))?.state).toBe('acked');
  });

  it('config 路径异常 → 不崩溃、保持 off', async () => {
    const home = await freshHomeWithAck();
    // config.json 是目录：读取/写入都失败。
    await mkdir(join(home, 'config.json'));
    const init = await initializeFirstRunHome({ home, env: HOME_ENV });
    expect(init.ok).toBe(false);
    expect(['config_invalid', 'first_run_init_failed']).toContain(init.reason);
    expect((await readFirstRunMarker({ home }))?.state).toBe('acked');
    // 未写入 sidecar enabled 以外的任何东西。
    expect(existsSync(join(home, 'memory-runtime', 'config.json'))).toBe(false);
  });

  it('披露版本不匹配 → 不 ack、不启用', async () => {
    const home = await makeHome();
    await markFirstRunPending({ home, env: HOME_ENV });
    expect(await markFirstRunAcked({ home, disclosureVersion: 2 })).toBeNull();
    expect((await readFirstRunMarker({ home }))?.state).toBe('pending');
    expect(await initializeFirstRunHome({ home, env: HOME_ENV }))
      .toMatchObject({ ok: false, reason: 'not_acked' });
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('acked marker + 显式 enabled=false → 不覆盖用户选择，停止重试', async () => {
    const home = await freshHomeWithAck({
      config: { memoryRuntime: { enabled: false }, storagePath: '/tmp/store.jsonl' },
    });
    const init = await initializeFirstRunHome({ home, env: HOME_ENV });
    expect(init).toMatchObject({ ok: true, skipped: 'explicit_disabled', initialized: false, enabled: false });
    expect((await readJson(join(home, 'config.json'))).memoryRuntime).toEqual({ enabled: false });
    expect((await readFirstRunMarker({ home }))?.state).toBe('done');
    expect(existsSync(join(home, 'memory-runtime', 'config.json'))).toBe(false);
  });

  it('非对象 memoryRuntime → fail closed，不覆盖成 {enabled:true}；修正后可重试', async () => {
    const home = await freshHomeWithAck({
      config: { memoryRuntime: 'legacy-string', storagePath: '/tmp/store.jsonl' },
    });
    const raw = await readText(join(home, 'config.json'));
    const failed = await initializeFirstRunHome({ home, env: HOME_ENV });
    expect(failed).toMatchObject({ ok: false, reason: 'config_invalid', enabled: false });
    expect(await readText(join(home, 'config.json'))).toBe(raw);
    expect((await readFirstRunMarker({ home }))?.state).toBe('acked');
    expect(existsSync(join(home, 'memory-runtime', 'config.json'))).toBe(false);

    // 用户/修复流程把字段改回合法形态后，acked marker 允许幂等重试。
    await writeFile(join(home, 'config.json'), JSON.stringify({ storagePath: '/tmp/store.jsonl' }), 'utf-8');
    const retried = await initializeFirstRunHome({ home, env: HOME_ENV });
    expect(retried).toMatchObject({ ok: true, initialized: true, enabled: true });
    expect((await readFirstRunMarker({ home }))?.state).toBe('done');
  });

  it('没有 marker（已有用户）→ 绝不初始化', async () => {
    const home = await makeHome();
    await writeFile(join(home, 'config.json'), JSON.stringify({ storagePath: 'x' }), 'utf-8');
    expect(await initializeFirstRunHome({ home, env: HOME_ENV }))
      .toMatchObject({ ok: false, reason: 'no_marker' });
    expect((await readJson(join(home, 'config.json'))).memoryRuntime).toBeUndefined();
  });
});
