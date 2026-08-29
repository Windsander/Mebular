// 导入幂等键规范（Phase 6.1 收口，phase-6-plan 开门决策点 1：双写过渡）
//
// 新格式：import:<source>:<digest>
//   - source：来源端标识（hermes / 适配器名），层级结构使命名空间可见、可按段查询；
//   - digest：sha256 十六进制，输入由各轨道自定（hermes=路径+内容；适配器=名+origin+指纹）。
// 兼容：既有图上的旧格式 import:<digest> 不迁移——写入侧只写新键，
//   读取侧新旧都认（旧键随图同步继续有效，自然老化）。

/** 新格式幂等键：import:<source>:<digest> */
export function importLabel(source: string, digest: string): string {
  return `import:${source}:${digest}`;
}

/** 旧格式幂等键（仅用于读取既有图，不再写入）：import:<digest> */
export function legacyImportLabel(digest: string): string {
  return `import:${digest}`;
}

/** 由新格式键派生旧格式键（读取回退用）；非新格式返回 null */
export function toLegacyImportLabel(label: string): string | null {
  const match = /^import:[^:]+:([0-9a-f]{64})$/.exec(label);
  return match ? `import:${match[1]}` : null;
}
