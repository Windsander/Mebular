// 硬件探测与推荐：注入 platform/os/exec/statfs，不执行真实命令。

import { describe, it, expect, jest } from '@jest/globals';
import {
  CURATED_MODEL_PACKS,
  DEFAULT_MODEL_PACK_ID,
  detectHardware,
  recommendModel,
  type ExecLike,
  type HardwareOsApi,
} from '../../src/index.js';
import { makeHardware } from './helpers.js';

const GIB = 1024 ** 3;

function fakeOs(total: number, cpus = 8): HardwareOsApi {
  return {
    totalmem: () => total,
    freemem: () => Math.floor(total / 2),
    cpus: () => Array.from({ length: cpus }, () => ({ model: 'Test CPU' })),
    release: () => 'test-release',
  };
}

const statfs = async () => ({ bsize: 4096, blocks: 30_000_000, bavail: 25_000_000 });

describe('detectHardware', () => {
  it('macOS / Apple Silicon：统一内存、磁盘、架构', async () => {
    const exec = jest.fn<ExecLike>(async (file) => {
      expect(file).toBe('system_profiler');
      return {
        stdout: JSON.stringify({
          SPDisplaysDataType: [{
            _name: 'Apple M3 Pro',
            spdisplays_vram: '36 GB',
          }],
        }),
      };
    });

    const profile = await detectHardware({
      platform: 'darwin',
      arch: 'arm64',
      os: fakeOs(36 * GIB),
      exec,
      statfs,
      diskPath: '/Users/test',
      now: () => 123,
    });

    expect(profile).toMatchObject({
      platform: 'darwin',
      arch: 'arm64',
      totalMemoryBytes: 36 * GIB,
      cpuCores: 8,
      detectedAt: 123,
      disk: { path: '/Users/test', availableBytes: 25_000_000 * 4096 },
      gpu: { vendor: 'apple', name: 'Apple M3 Pro', unifiedMemory: true, vramBytes: 36 * GIB },
    });
    expect(profile.warnings).toEqual([]);
  });

  it('Linux：nvidia-smi 显存与名称', async () => {
    const exec = jest.fn<ExecLike>(async (file) => {
      expect(file).toBe('nvidia-smi');
      return { stdout: 'NVIDIA GeForce RTX 4090, 24564\n' };
    });
    const profile = await detectHardware({
      platform: 'linux',
      arch: 'x64',
      os: fakeOs(64 * GIB),
      exec,
      statfs,
    });
    expect(profile.gpu).toMatchObject({
      vendor: 'nvidia',
      name: 'NVIDIA GeForce RTX 4090',
      unifiedMemory: false,
    });
    expect(profile.gpu.vramBytes).toBe(24564 * 1024 ** 2);
  });

  it('Windows：PowerShell 显卡 JSON', async () => {
    const exec = jest.fn<ExecLike>(async (file) => {
      expect(file).toBe('powershell.exe');
      return {
        stdout: JSON.stringify([
          { Name: 'NVIDIA GeForce RTX 4070', AdapterRAM: 8 * GIB },
        ]),
      };
    });
    const profile = await detectHardware({
      platform: 'win32',
      arch: 'x64',
      os: fakeOs(32 * GIB),
      exec,
      statfs,
      diskPath: 'C:\\Users\\test',
    });
    expect(profile.gpu).toMatchObject({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070' });
    expect(profile.gpu.vramBytes).toBe(8 * GIB);
  });

  it('探测失败不阻塞：GPU/磁盘未知时只记 warning', async () => {
    const exec = jest.fn<ExecLike>(async () => {
      throw new Error('command not found');
    });
    const profile = await detectHardware({
      platform: 'linux',
      arch: 'x64',
      os: fakeOs(16 * GIB),
      exec,
      statfs: async () => {
        throw new Error('statfs failed');
      },
    });
    expect(profile.gpu.vendor).toBe('unknown');
    expect(profile.disk.availableBytes).toBeUndefined();
    expect(profile.warnings).toEqual(expect.arrayContaining(['gpu_probe_failed', 'disk_probe_failed']));
  });
});

describe('recommendModel', () => {
  it('16 GiB 推荐默认 9B', () => {
    const result = recommendModel(makeHardware({ totalMemoryBytes: 16 * GIB }));
    expect(result).toMatchObject({
      kind: 'local',
      packId: DEFAULT_MODEL_PACK_ID,
      tier: 'default',
    });
    expect(result.warnings.some((warning) => warning.includes('recommended'))).toBe(true);
  });

  it('32 GiB 仍推荐 9B（27B 需要 40 GiB 才能启动）', () => {
    const result = recommendModel(makeHardware({ totalMemoryBytes: 32 * GIB }));
    expect(result.packId).toBe(DEFAULT_MODEL_PACK_ID);
  });

  it('40 GiB 上 27B 可启动但未达 64 GiB 建议值，降回 9B', () => {
    const result = recommendModel(makeHardware({ totalMemoryBytes: 40 * GIB }));
    expect(result.packId).toBe(DEFAULT_MODEL_PACK_ID);
    expect(result.alternatives).toContain('qwen3.5-27b-instruct-q4_k_m');
    expect(result.warnings.some((warning) => warning.includes('27b'))).toBe(true);
  });

  it('64 GiB 推荐 27B 高质量', () => {
    const result = recommendModel(makeHardware({ totalMemoryBytes: 64 * GIB }));
    expect(result).toMatchObject({
      kind: 'local',
      packId: 'qwen3.5-27b-instruct-q4_k_m',
      tier: 'quality',
    });
    expect(result.alternatives).toContain(DEFAULT_MODEL_PACK_ID);
  });

  it('8 GiB 推荐 4B 轻量', () => {
    const result = recommendModel(makeHardware({ totalMemoryBytes: 8 * GIB }));
    expect(result).toMatchObject({
      packId: 'qwen3.5-4b-instruct-q4_k_m',
      tier: 'light',
    });
  });

  it('内存/磁盘不足时回退 heuristic，不做网络调用', () => {
    expect(recommendModel(makeHardware({ totalMemoryBytes: 4 * GIB }))).toMatchObject({
      kind: 'heuristic',
      packId: null,
    });
    expect(recommendModel(makeHardware({
      totalMemoryBytes: 16 * GIB,
      disk: { path: '/tmp', availableBytes: 1 * GIB },
    }))).toMatchObject({ kind: 'heuristic', packId: null });
  });

  it('目录顺序不影响推荐质量排序', () => {
    const reversed = [...CURATED_MODEL_PACKS].reverse();
    const result = recommendModel(makeHardware({ totalMemoryBytes: 64 * GIB }), reversed);
    expect(result.packId).toBe('qwen3.5-27b-instruct-q4_k_m');
  });
});
