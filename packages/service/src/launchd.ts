// macOS launchd 作业的**纯解析与归属判定**（无 IO、无平台副作用），供 `service status/install`
// 校验「加载中的作业是否属于本 home」——这是 F-SVC-1 的核心不变量：
// **跨 home 的作业绝不算 running，也绝不 bootout 他人**。
//
// 背景（真机事故）：旧方案 label 无 home 维度（`com.mebular.<kind>`），任意 home 的 install 都会
// 顶掉同 label 的既有作业；`launchctl print gui/<uid>/<label>` 只要 label 存在就返回 0 → 别的 home
// 的作业被本 home 误报 running（假阳性）。故 running 判定必须回到「作业内容」：
// ProgramArguments / MEBULAR_HOME / WorkingDirectory / plist 路径与本 home 是否一致。

import { resolve, sep } from 'node:path';

/** `launchctl print gui/<uid>/<label>` 里我们关心的事实。 */
export interface LaunchdJob {
  label: string | null;
  /** 作业来源 plist 路径（`path = …`） */
  path: string | null;
  /** `program = …` */
  program: string | null;
  /** `arguments = { … }`（去掉可执行文件名之外的逐项） */
  arguments: string[];
  /** `environment = { K => V }`（`=>` 与 `=` 两种写法都接受） */
  environment: Record<string, string>;
  /** `working directory = …` */
  workingDirectory: string | null;
}

const strip = (value: string): string => value.trim().replace(/^["']|["']$/g, '').trim();

/** 归属比较用的路径规范化（绝对化 + 去尾部分隔符）。纯字符串运算，不做 realpath（免 IO）。 */
export function normalizeServicePath(value: string): string {
  const absolute = resolve(value);
  return absolute.length > 1 ? absolute.replace(/[/\\]+$/, '') : absolute;
}

function readScalar(lines: readonly string[], key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
  for (const line of lines) {
    const match = re.exec(line);
    if (match) return strip(match[1]!);
  }
  return null;
}

/** 读 `key = { … }` 或 `key = ( … )` 块内容（去缩进、去行尾逗号）。 */
function readBlock(lines: readonly string[], key: string): string[] {
  const open = new RegExp(`^\\s*${key}\\s*=\\s*[({]\\s*$`);
  const start = lines.findIndex((line) => open.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*[)}]\s*$/.test(line)) break;
    const trimmed = line.replace(/^\s+/, '').replace(/,\s*$/, '');
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/**
 * 解析 `launchctl print gui/<uid>/<label>` 输出。**容错**：缺块/空输出返回全 null，
 * 调用方据此判定「不归属」（保守 → 绝不当成 running）。
 */
export function parseLaunchdPrint(output: string): LaunchdJob {
  const lines = String(output ?? '').split('\n');
  const argumentsList = readBlock(lines, 'arguments').map(strip).filter((s) => s.length > 0);
  const environment: Record<string, string> = {};
  for (const entry of readBlock(lines, 'environment')) {
    const match = /^(.+?)\s*(?:=>|=)\s*(.*)$/.exec(entry);
    if (match && match[1] !== undefined) environment[strip(match[1])] = strip(match[2] ?? '');
  }
  return {
    label: readScalar(lines, 'label'),
    path: readScalar(lines, 'path'),
    program: readScalar(lines, 'program'),
    arguments: argumentsList,
    environment,
    workingDirectory: readScalar(lines, 'working directory'),
  };
}

/**
 * 加载中的作业是否属于本 home。**任一**事实匹配即视为本 home：
 *   - 环境 `MEBULAR_HOME` / `MEBULAR_SERVICE_HOME` == home；
 *   - `working directory` == home；
 *   - plist 路径位于 `<home>/` 之下。
 * 无法判定（解析不到任何事实）→ **false**（保守：宁可说不是本 home，也不误报 running）。
 */
export function jobBelongsToHome(job: LaunchdJob | null, home: string): boolean {
  if (!job) return false;
  const target = normalizeServicePath(home);
  for (const key of ['MEBULAR_HOME', 'MEBULAR_SERVICE_HOME'] as const) {
    const value = job.environment[key];
    if (typeof value === 'string' && value.length > 0 && normalizeServicePath(value) === target) return true;
  }
  if (job.workingDirectory && normalizeServicePath(job.workingDirectory) === target) return true;
  if (job.path) {
    const p = normalizeServicePath(job.path);
    if (p === target || p.startsWith(target + sep)) return true;
  }
  return false;
}

/** 人类可读的「占用者」描述（用于警告文案；无法识别时给 null）。 */
export function describeJobOwner(job: LaunchdJob | null): string | null {
  if (!job) return null;
  const fromEnv = job.environment.MEBULAR_HOME ?? job.environment.MEBULAR_SERVICE_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  if (job.workingDirectory) return job.workingDirectory;
  if (job.path) return job.path;
  return null;
}
