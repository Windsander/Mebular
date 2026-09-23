// 共用 `service` 子命令（fleet / mebular 两个 CLI 复用同一 UX 与语义）。
//
//   install <name> [--no-autostart] [--label L] [--sha S]
//   uninstall <name>
//   status [name]
//   logs <name> [--tail N]

import type { RunCommand, ServiceDescriptor, ServiceOptions } from './manager.js';
import { installService, resolveBuildSha, restartService, serviceLogs, serviceStatus, uninstallService } from './manager.js';
import type { ServiceKind, ServicePlatform } from './units.js';

export interface ServiceCliOptions {
  descriptors: readonly ServiceDescriptor[];
  argv: readonly string[];
  home?: string;
  platform?: ServicePlatform;
  run?: RunCommand;
  out?: (line: string) => void;
}

function parseFlags(list: readonly string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < list.length; i++) {
    const token = list[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = list[i + 1];
      // `--extra` 的值本身以 `--` 开头（透传给服务的 CLI 参数），必须按值消费。
      if (key === 'extra' && next !== undefined) {
        flags[key] = next;
        i++;
      } else if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

const findDescriptor = (descriptors: readonly ServiceDescriptor[], name: string): ServiceDescriptor | undefined =>
  descriptors.find((d) => d.kind === name);

export const SERVICE_USAGE =
  '用法：<cli> service install <name> [--no-autostart] [--label L] [--sha S] | uninstall <name> | restart <name> | status [name] | logs <name> [--tail N]';

/** 返回退出码；输出为单行 JSON。 */
export function runServiceCli(opts: ServiceCliOptions): number {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const [sub, ...rest] = [...opts.argv];
  const { positional, flags } = parseFlags(rest);
  const base: ServiceOptions = {
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.run !== undefined ? { run: opts.run } : {}),
  };
  const emit = (value: unknown, code = 0): number => {
    out(JSON.stringify(value, null, 2));
    return code;
  };

  if (sub === 'status') {
    const names = positional.length > 0 ? positional : opts.descriptors.map((d) => d.kind);
    const services = names.map((name) => {
      const descriptor = findDescriptor(opts.descriptors, name);
      if (!descriptor) throw new Error(`未知服务：${name}`);
      return serviceStatus(descriptor, base);
    });
    return emit({ ok: true, action: 'status', services });
  }

  const name = positional[0] ?? (opts.descriptors.length === 1 ? opts.descriptors[0]!.kind : undefined);
  if (name === undefined) {
    out(SERVICE_USAGE);
    return 2;
  }
  const found = findDescriptor(opts.descriptors, name);
  if (!found) {
    out(SERVICE_USAGE);
    return 2;
  }
  // `--extra "a b c"`：把宿主透传的额外 CLI 参数追加到服务启动命令（如 `--submit 3`）。
  const extra = typeof flags.extra === 'string' ? flags.extra.split(/\s+/).filter((s) => s.length > 0) : [];
  const descriptor: ServiceDescriptor = extra.length > 0 ? { ...found, args: [...found.args, ...extra] } : found;

  if (sub === 'install') {
    const autostart = flags['no-autostart'] !== true;
    const sha = typeof flags.sha === 'string' ? flags.sha : resolveBuildSha();
    const result = installService(descriptor, {
      ...base,
      autostart,
      sha,
      ...(typeof flags.label === 'string' ? { label: flags.label } : {}),
    });
    return emit(result);
  }
  if (sub === 'uninstall') {
    return emit(uninstallService(descriptor, base));
  }
  if (sub === 'restart') {
    const result = restartService(descriptor, base);
    return emit(result, result.ok ? 0 : 1);
  }
  if (sub === 'logs') {
    const tail = typeof flags.tail === 'string' ? Number(flags.tail) : undefined;
    return emit(serviceLogs(descriptor, { ...base, ...(tail !== undefined && Number.isFinite(tail) ? { tail } : {}) }));
  }
  out(SERVICE_USAGE);
  return 2;
}

export type { ServiceKind };
