// 展示名（忆云名 / 设备名）的统一校验：core 与应用层共用同一口径。
//
// 规则（产品已确认）：
//   - 先去掉控制字符，再 trim；
//   - 1–24 个 Unicode 字符（按码点计数，不按 UTF-16 长度）；
//   - 拒绝 `/`、`\`、`..`（避免被当成路径片段）；
//   - 其它字符（含中文、emoji）允许。
//
// 名称只是展示元数据：不参与订阅/移出/安全推导，也不进入任何路径解析。

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** 规范化展示名；无效返回 null（调用方决定拒绝写入还是忽略事件）。 */
export function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(CONTROL_CHARS, '').trim();
  if (name.length === 0) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if ([...name].length > 24) return null;
  return name;
}

/** 展示名是否合法（不改变输入）。 */
export function isValidDisplayName(raw: unknown): boolean {
  return normalizeDisplayName(raw) !== null;
}
