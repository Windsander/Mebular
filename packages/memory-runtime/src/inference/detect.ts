// 硬件探测与精选模型推荐（0.3.0）
//
// 只读取系统信息，不执行模型、不联网。`platform` / `os` / `exec` / `statfs`
// 均可注入，测试不需要真实机器或真实命令。

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { CURATED_MODEL_PACKS } from './catalog.js';
import type {
  GpuProfile,
  GpuVendor,
  HardwarePlatform,
  HardwareProfile,
  ModelPack,
  ModelRecommendation,
} from './types.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export interface HardwareOsApi {
  totalmem(): number;
  freemem(): number;
  cpus(): Array<{ model?: string }>;
  release(): string;
}

export interface ExecResult {
  stdout: string;
  stderr?: string;
}

export type ExecLike = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<ExecResult>;

export interface StatfsLike {
  bsize: number;
  blocks: number;
  bavail: number;
}

export type StatfsLikeFn = (path: string) => Promise<StatfsLike>;

export interface DetectHardwareOptions {
  platform?: string;
  arch?: string;
  os?: HardwareOsApi;
  exec?: ExecLike;
  statfs?: StatfsLikeFn;
  /** 磁盘探测路径；默认当前工作目录。 */
  diskPath?: string;
  now?: () => number;
}

const defaultExec: ExecLike = async (file, args, options = {}) => {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: options.timeout ?? 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
  return result;
};

function normalizePlatform(value: string): HardwarePlatform {
  if (value === 'darwin' || value === 'win32' || value === 'linux') return value;
  return 'unknown';
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function readDiskWithStatfs(
  statfs: StatfsLikeFn,
  path: string,
): Promise<{ availableBytes?: number; totalBytes?: number }> {
  const result = await statfs(path);
  const available = safeNumber(result.bavail) !== undefined
    && safeNumber(result.bsize) !== undefined
    ? (result.bavail as number) * (result.bsize as number)
    : undefined;
  const total = safeNumber(result.blocks) !== undefined && safeNumber(result.bsize) !== undefined
    ? (result.blocks as number) * (result.bsize as number)
    : undefined;
  return { availableBytes: available, totalBytes: total };
}

function parseDf(output: string): { availableBytes?: number; totalBytes?: number } {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parts = lines[index]!.split(/\s+/);
    if (parts.length < 4) continue;
    const totalKb = Number(parts[1]);
    const availableKb = Number(parts[3]);
    if (Number.isFinite(totalKb) && Number.isFinite(availableKb)) {
      return { totalBytes: totalKb * 1024, availableBytes: availableKb * 1024 };
    }
  }
  return {};
}

function parseWindowsDiskJson(output: string): { availableBytes?: number; totalBytes?: number } {
  try {
    const parsed: unknown = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const record = row as Record<string, unknown>;
      const free = safeNumber(record.FreeSpace);
      const size = safeNumber(record.Size);
      if (free !== undefined || size !== undefined) {
        return { availableBytes: free, totalBytes: size };
      }
    }
  } catch {
    // 命令输出不是 JSON 时退化为无磁盘信息，不阻塞推荐。
  }
  return {};
}

async function detectDisk(
  platform: HardwarePlatform,
  path: string,
  statfs: StatfsLikeFn,
  exec: ExecLike,
  warnings: string[],
): Promise<{ availableBytes?: number; totalBytes?: number }> {
  try {
    const result = await readDiskWithStatfs(statfs, path);
    if (result.availableBytes !== undefined) return result;
  } catch {
    // fall through to platform command
  }

  try {
    if (platform === 'win32') {
      const driveMatch = /^([A-Za-z]:)/.exec(path);
      const drive = driveMatch?.[1] ?? 'C:';
      const script = `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress`;
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 5000,
      });
      const parsed = parseWindowsDiskJson(stdout);
      if (parsed.availableBytes !== undefined || parsed.totalBytes !== undefined) return parsed;
    } else {
      const { stdout } = await exec('df', ['-kP', path], { timeout: 5000 });
      const parsed = parseDf(stdout);
      if (parsed.availableBytes !== undefined || parsed.totalBytes !== undefined) return parsed;
    }
  } catch {
    warnings.push('disk_probe_failed');
  }
  return {};
}

function parseByteSize(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB|KB|KiB)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = (match[2] ?? 'MB').toLowerCase();
  if (unit === 'gb' || unit === 'gib') return Math.round(amount * GIB);
  if (unit === 'mb' || unit === 'mib') return Math.round(amount * MIB);
  if (unit === 'kb' || unit === 'kib') return Math.round(amount * 1024);
  return undefined;
}

function vendorFromName(name: string): GpuVendor {
  const lower = name.toLowerCase();
  if (lower.includes('apple')) return 'apple';
  if (lower.includes('nvidia') || lower.includes('geforce') || lower.includes('quadro') || lower.includes('tesla')) {
    return 'nvidia';
  }
  if (lower.includes('amd') || lower.includes('radeon') || lower.includes('advanced micro devices')) return 'amd';
  if (lower.includes('intel') || lower.includes('arc')) return 'intel';
  return 'unknown';
}

function unknownGpu(warnings: string[], warning: string): GpuProfile {
  warnings.push(warning);
  return { vendor: 'unknown', unifiedMemory: false };
}

async function detectMacGpu(
  arch: string,
  exec: ExecLike,
  warnings: string[],
): Promise<GpuProfile> {
  const appleSilicon = arch === 'arm64';
  try {
    const { stdout } = await exec('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 8000 });
    if (stdout.trim()) {
      const parsed: unknown = JSON.parse(stdout);
      const entries = typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).SPDisplaysDataType
        : undefined;
      const first = Array.isArray(entries)
        ? entries.find((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        : undefined;
      if (first) {
        const name = [first._name, first.sppci_model, first.spdisplays_chipset_model]
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
          ?.trim();
        const vendor = name ? vendorFromName(name) : (appleSilicon ? 'apple' : 'unknown');
        const vram = parseByteSize(first.spdisplays_vram ?? first.spdisplays_vram_shared);
        return {
          vendor,
          ...(name ? { name } : {}),
          ...(vram !== undefined ? { vramBytes: vram } : {}),
          unifiedMemory: vendor === 'apple' || appleSilicon,
        };
      }
    }
  } catch {
    if (!appleSilicon) {
      return unknownGpu(warnings, 'gpu_probe_failed');
    }
  }
  if (appleSilicon) {
    return { vendor: 'apple', name: 'Apple Silicon', unifiedMemory: true };
  }
  return { vendor: 'none', unifiedMemory: false };
}

function valueFromJsonRow(row: Record<string, unknown>, key: string): unknown {
  return row[key] ?? row[key.toLowerCase()];
}

async function detectWindowsGpu(exec: ExecLike, warnings: string[]): Promise<GpuProfile> {
  try {
    const script = 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress';
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 8000,
    });
    if (!stdout.trim()) return { vendor: 'none', unifiedMemory: false };
    const parsed: unknown = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    let best: { name: string; vram?: number } | undefined;
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const nameValue = valueFromJsonRow(row as Record<string, unknown>, 'Name');
      const name = typeof nameValue === 'string' ? nameValue.trim() : '';
      if (!name) continue;
      const rawVram = valueFromJsonRow(row as Record<string, unknown>, 'AdapterRAM');
      const vram = typeof rawVram === 'number' && rawVram > 0 ? rawVram : undefined;
      if (!best || (vram ?? 0) > (best.vram ?? 0)) best = { name, ...(vram ? { vram } : {}) };
    }
    if (!best) return { vendor: 'none', unifiedMemory: false };
    return {
      vendor: vendorFromName(best.name),
      name: best.name,
      ...(best.vram !== undefined ? { vramBytes: best.vram } : {}),
      unifiedMemory: false,
    };
  } catch {
    return unknownGpu(warnings, 'gpu_probe_failed');
  }
}

async function detectLinuxGpu(exec: ExecLike, warnings: string[]): Promise<GpuProfile> {
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    );
    const rows = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (rows.length > 0) {
      let vramTotal = 0;
      const names: string[] = [];
      for (const row of rows) {
        const [namePart, memoryPart] = row.split(',').map((part) => part.trim());
        if (namePart) names.push(namePart);
        const memoryMb = Number(memoryPart);
        if (Number.isFinite(memoryMb) && memoryMb > 0) vramTotal += memoryMb * MIB;
      }
      return {
        vendor: 'nvidia',
        ...(names.length > 0 ? { name: names.join(' / ') } : {}),
        ...(vramTotal > 0 ? { vramBytes: vramTotal } : {}),
        unifiedMemory: false,
      };
    }
  } catch {
    // nvidia-smi 不存在是常见情况；继续尝试 lspci。
  }

  try {
    const { stdout } = await exec('lspci', [], { timeout: 5000 });
    const line = stdout
      .split(/\r?\n/)
      .find((item) => /VGA compatible controller|3D controller|Display controller/i.test(item));
    if (line) {
      const name = line.includes(': ') ? line.slice(line.indexOf(': ') + 2).trim() : line.trim();
      return {
        vendor: vendorFromName(name),
        name,
        unifiedMemory: false,
      };
    }
    return { vendor: 'none', unifiedMemory: false };
  } catch {
    return unknownGpu(warnings, 'gpu_probe_failed');
  }
}

async function detectGpu(
  platform: HardwarePlatform,
  arch: string,
  exec: ExecLike,
  warnings: string[],
): Promise<GpuProfile> {
  if (platform === 'darwin') return detectMacGpu(arch, exec, warnings);
  if (platform === 'win32') return detectWindowsGpu(exec, warnings);
  if (platform === 'linux') return detectLinuxGpu(exec, warnings);
  warnings.push('gpu_probe_unsupported_platform');
  return { vendor: 'unknown', unifiedMemory: false };
}

/** 读取当前机器的内存/GPU/磁盘/架构；任何子探测失败只记 warning。 */
export async function detectHardware(options: DetectHardwareOptions = {}): Promise<HardwareProfile> {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const arch = options.arch ?? process.arch;
  const osApi = options.os ?? os;
  const exec = options.exec ?? defaultExec;
  const statfs = options.statfs ?? (async (path: string) => fs.statfs(path));
  const now = options.now ?? Date.now;
  const warnings: string[] = [];

  const cpus = osApi.cpus();
  const totalMemoryBytes = Math.max(0, osApi.totalmem());
  const freeMemoryBytes = Math.max(0, osApi.freemem());
  const cpuModel = cpus[0]?.model?.trim();

  const diskPath = options.diskPath ?? process.cwd();
  const disk = await detectDisk(platform, diskPath, statfs, exec, warnings);
  const gpu = await detectGpu(platform, arch, exec, warnings);

  return {
    platform,
    arch,
    osVersion: osApi.release(),
    ...(cpuModel ? { cpuModel } : {}),
    cpuCores: cpus.length,
    totalMemoryBytes,
    freeMemoryBytes,
    disk: {
      path: diskPath,
      ...(disk.availableBytes !== undefined ? { availableBytes: disk.availableBytes } : {}),
      ...(disk.totalBytes !== undefined ? { totalBytes: disk.totalBytes } : {}),
    },
    gpu,
    detectedAt: now(),
    warnings,
  };
}

const TIER_RANK: Record<ModelPack['tier'], number> = {
  quality: 3,
  default: 2,
  light: 1,
  custom: 0,
};

interface EligiblePack {
  pack: ModelPack;
  meetsRecommendedMemory: boolean;
  warning?: string;
}

function supportsPlatform(pack: ModelPack, profile: HardwareProfile): boolean {
  if (!pack.requirements.platforms.includes(profile.platform)) return false;
  const archs = pack.requirements.architectures;
  if (archs && archs.length > 0 && !archs.includes(profile.arch)) return false;
  return true;
}

function gpuAllows(pack: ModelPack, profile: HardwareProfile): boolean {
  if (pack.requirements.gpu !== 'required') return true;
  if (profile.gpu.vendor === 'none' || profile.gpu.vendor === 'unknown') return false;
  if (pack.requirements.minVramBytes === undefined) return true;
  if (profile.gpu.unifiedMemory) return profile.totalMemoryBytes >= pack.requirements.minVramBytes;
  if (profile.gpu.vramBytes === undefined) return false;
  return profile.gpu.vramBytes >= pack.requirements.minVramBytes;
}

/**
 * 推荐 27B/9B/4B 或 heuristic。
 * - 先按 minMemory/minDisk/platform 过滤；
 * - 优先选择达到 recommendedMemory 的最高质量包；
 * - 没有达到建议内存的包时，仍选择可运行的最高质量包；
 * - 任何本地包都不满足 -> heuristic（永不自动联网）。
 */
export function recommendModel(
  profile: HardwareProfile,
  packs: readonly ModelPack[] = CURATED_MODEL_PACKS,
): ModelRecommendation {
  const warnings: string[] = [];
  const eligible: EligiblePack[] = [];

  for (const pack of packs) {
    if (!supportsPlatform(pack, profile)) {
      warnings.push(`${pack.packId}: platform ${profile.platform}/${profile.arch} is not supported`);
      continue;
    }
    if (profile.totalMemoryBytes < pack.requirements.minMemoryBytes) {
      warnings.push(
        `${pack.packId}: requires at least ${Math.ceil(pack.requirements.minMemoryBytes / GIB)} GiB memory`,
      );
      continue;
    }
    if (gpuAllows(pack, profile) === false) {
      warnings.push(`${pack.packId}: GPU requirements are not met`);
      continue;
    }
    const availableDisk = profile.disk.availableBytes;
    if (availableDisk !== undefined && availableDisk < pack.requirements.minDiskBytes) {
      warnings.push(
        `${pack.packId}: requires at least ${Math.ceil(pack.requirements.minDiskBytes / GIB)} GiB free disk`,
      );
      continue;
    }

    const meetsRecommendedMemory = profile.totalMemoryBytes >= pack.requirements.recommendedMemoryBytes;
    let warning: string | undefined;
    if (!meetsRecommendedMemory) {
      warning = `${pack.packId}: below recommended ${Math.ceil(pack.requirements.recommendedMemoryBytes / GIB)} GiB memory; may be slower`;
      warnings.push(warning);
    }
    if (availableDisk !== undefined && availableDisk < pack.estimatedDownloadBytes * 1.2) {
      warnings.push(`${pack.packId}: free disk is close to the estimated download size`);
    }
    eligible.push({
      pack,
      meetsRecommendedMemory,
      ...(warning ? { warning } : {}),
    });
  }

  if (eligible.length === 0) {
    return {
      kind: 'heuristic',
      packId: null,
      modelId: null,
      tier: null,
      reason: 'no curated local model fits the detected memory/disk/platform',
      warnings,
      alternatives: [],
    };
  }

  eligible.sort((left, right) => TIER_RANK[right.pack.tier] - TIER_RANK[left.pack.tier]);
  const highest = eligible[0]!;
  let preferred = highest;
  if (!highest.meetsRecommendedMemory) {
    // 不因为低一档“达到建议内存”就跳过仍可运行的更高档：
    // 例如 16 GiB 上 9B 未达 24 GiB 建议值，但 4B 达到建议值；仍应默认 9B。
    // 只有更高档是 quality、而 default 档达到建议内存时才降档（如 40 GiB 的 27B → 9B）。
    const recommendedDefault = eligible
      .slice(1)
      .find((entry) => entry.pack.tier === 'default' && entry.meetsRecommendedMemory);
    if (recommendedDefault && highest.pack.tier === 'quality') preferred = recommendedDefault;
  }
  const alternatives = eligible
    .filter((entry) => entry.pack.packId !== preferred.pack.packId)
    .map((entry) => entry.pack.packId);

  return {
    kind: 'local',
    packId: preferred.pack.packId,
    modelId: preferred.pack.modelId,
    tier: preferred.pack.tier,
    reason: preferred.meetsRecommendedMemory
      ? `selected ${preferred.pack.tier} pack for ${Math.round(profile.totalMemoryBytes / GIB)} GiB memory`
      : `selected the best runnable pack; ${Math.round(profile.totalMemoryBytes / GIB)} GiB memory is below the recommended target`,
    warnings,
    alternatives,
  };
}
