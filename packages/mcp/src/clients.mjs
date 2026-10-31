// UX-2 · 「连接 AI 助手」注册表（助手 = 数据，不是代码）
//
// 契约：`.opencode/skills/mebular-assistant-integration/SKILL.md`
// 规格：`docs/design/config-journey-v1.md`（§3 模型 / §5.3 / §5.4 / §9 A-1..A-19）
//
// 硬性写入规则（本模块唯一实现，供 admin 读写端点复用）：
//   1. 只**合并**助手自己的一条键（opencode: `mcp.servers.mebular`；json-mcpServers: `mcpServers.mebular`；
//      hermes: `mcp_servers.mebular`）；**A-17**：opencode 正确键位是 `mcp.servers.<name>`（非 `mcp.<name>`）。
//   2. 写前**字节级备份** `<path>.bak-<ts>`（merge-key 与 cli-set 都必须）。
//   3. **原子写**（临时文件 + rename）；cli-set 走助手官方 CLI（Hermes: `hermes config set --force`）。
//   4. 解析失败 / 结构未知 → **不写**，返回 `needsManual` + 片段（原文件不动）。
//   5. 重复接入**幂等**（条目已等价 → changed:false，不写不备份）；写入失败**回滚**。
//   6. **禁写** `landing.forbiddenPaths`（如 OpenChamber 私有的 `opencode.managed.json`）。
//   7. **A-19**：本模块**不得**调用 `opencode reload`（生效由用户在 App 侧重载）。
//   9. **F-FIX-A**：assistant 相关路径以**用户主目录**为基（`userHome`/`MEBULAR_USER_HOME`/`os.homedir()`），
//      **绝不**用 MEBULAR_HOME（那是 Mebular 自有文件的家）；spawn 的子进程统一注入**增强 PATH**。
//   8. **F-PERF-2**：请求路径的探针一律**异步**（exec promisify）+ **短 TTL 会话内缓存**（单飞去重、
//      写后失效、`refresh` 绕过）——不得在事件循环里 `spawnSync` 阻塞（并发 GET 会互相排队）。
//
// 纯函数式：home/cwd/platform/env/run 可注入，便于单元测试（不触碰真实用户目录）。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { exec, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from './version.mjs';

// ---------------------------------------------------------------------------
// 格式适配器（落面形状的唯一真源；A-17 以 `opencode mcp add` 产出为准）
// ---------------------------------------------------------------------------

/**
 * 条目形状注册表（**可序列化 id → 构造函数**）。F-FIX-B：守护运行中 **stdio `mebular mcp` 会被拒**
 * （MCP_STORAGE_LOCKED，F-CLI-2 设计如此）⇒ 注入条目必须指向**守护 HTTP `/mcp`**；
 * 只有拿不到守护端点时才回落 stdio（并保留"同机"前提与指引）。
 */
export const ENTRY_SHAPES = {
  'opencode-remote': (url) => ({ type: 'remote', url }),
  'opencode-stdio': () => ({ type: 'local', command: ['mebular', 'mcp'] }),
  'claude-http': (url) => ({ type: 'http', url }),
  'url-only': (url) => ({ url }),
  'stdio-mcpServers': () => ({ command: 'mebular', args: ['mcp'] }),
  'hermes-url': (url) => ({ url, enabled: true }),
  'hermes-stdio': () => ({ command: 'mebular', args: ['mcp'], enabled: true }),
  'dsh-http': (url) => ({ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'mebular', transport: 'streamable-http', url } }),
  'dsh-stdio': () => ({ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'mebular', transport: 'stdio', command: 'mebular', args: ['mcp'] } }),
};

/** 取某形状的条目；未知形状 → null（调用方回落）。 */
export function entryForShape(shape, url) {
  const build = ENTRY_SHAPES[shape];
  return build ? build(url) : null;
}

/** 适配器注册表（内置）。`keyPath` 含叶子名（助手的 mcp 条目名固定 `mebular`）。 */
export const FORMAT_ADAPTERS = {
  // opencode v2（含 OpenChamber 宿主）：真源 = `opencode mcp add` 产出 `{"mcp":{"servers":{...}}}`
  'opencode-json': {
    id: 'opencode-json', serialization: 'json', strategy: 'merge-key', keyPath: ['mcp', 'servers', 'mebular'],
    legacyKeyPath: ['mcp', 'mebular'], // A-17：旧版错形状，仅用于「诚实标注不生效」
    httpShape: 'opencode-remote', stdioShape: 'opencode-stdio',
  },
  'json-mcpServers': {
    id: 'json-mcpServers', serialization: 'json', strategy: 'merge-key', keyPath: ['mcpServers', 'mebular'],
    httpShape: 'url-only', stdioShape: 'stdio-mcpServers',
  },
  // Hermes：YAML，但写入**必须**经官方 CLI（ruamel 保注释）；无法 env 沙箱 ⇒ 备份/回滚是硬要求。
  'hermes-yaml': {
    id: 'hermes-yaml', serialization: 'yaml', strategy: 'cli-set', keyPath: ['mcp_servers', 'mebular'],
    httpShape: 'hermes-url', stdioShape: 'hermes-stdio',
  },
  // 遗留 DSH（YAML 插件列表）：DDH 插件支持 streamable-http（与 `mebular print-config --client dsh` 同源）。
  dsh: {
    id: 'dsh', serialization: 'yaml', strategy: 'merge-key', keyPath: ['plugins', 'mebular'],
    httpShape: 'dsh-http', stdioShape: 'dsh-stdio',
  },
  toml: { id: 'toml', serialization: 'toml', strategy: 'manual', keyPath: ['mcp_servers', 'mebular'], httpShape: 'url-only', stdioShape: 'stdio-mcpServers' },
  yaml: { id: 'yaml', serialization: 'yaml', strategy: 'manual', keyPath: ['mcp_servers', 'mebular'], httpShape: 'url-only', stdioShape: 'stdio-mcpServers' },
  'generic-snippet': { id: 'generic-snippet', serialization: 'text', strategy: 'manual', keyPath: ['mcpServers', 'mebular'], httpShape: 'url-only', stdioShape: 'stdio-mcpServers' },
};

/** 遗留 format 名 → 适配器 id（保持既有调用方与片段兼容）。 */
const LEGACY_FORMAT = { opencode: 'opencode-json', mcpServers: 'json-mcpServers', generic: 'generic-snippet', dsh: 'dsh' };

export function adapterFor(format) {
  return FORMAT_ADAPTERS[LEGACY_FORMAT[format] ?? format] ?? null;
}

/**
 * 守护 HTTP `/mcp` 端点（**单一真源**：`mebular print-config --client <id> --url …` 同此形态）。
 * 由请求 Host/scheme 推导；`0.0.0.0`/`::` 归一为 `127.0.0.1`（同 `mebular console`）。
 */
export function daemonMcpUrl({ host, encrypted } = {}) {
  const raw = typeof host === 'string' && host.length > 0 ? host : '127.0.0.1:7331';
  const [hostPart, portPart] = raw.split(':');
  const target = hostPart === '0.0.0.0' || hostPart === '::' || hostPart === undefined || hostPart === '' ? '127.0.0.1' : hostPart;
  const port = portPart !== undefined && /^[0-9]+$/.test(portPart) ? portPart : '7331';
  return `${encrypted ? 'https' : 'http'}://${target}:${port}/mcp`;
}

// ---------------------------------------------------------------------------
// MCP URL 同端点判定（陈旧配置检测；只用于 HTTP/remote 条目，stdio 不适用）
// ---------------------------------------------------------------------------

/**
 * HTTP(S) MCP URL 归一化：
 * - 忽略**末尾 `/`**（`…/mcp/` ≡ `…/mcp`）；
 * - host / scheme 大小写归一，`localhost` ≡ `127.0.0.1`（同机回环别名）；
 * - **端口不同 = 不同端点**（旧 56007 vs 当前 7331 必须判为不匹配）；
 * - 路径/查询不同 = 不同端点；非 http(s)/不可解析 → null（不参与比较）。
 */
export function normalizeMcpUrl(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase();
  if (host === 'localhost') host = '127.0.0.1';
  const port = parsed.port.length > 0 ? `:${parsed.port}` : '';
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${host}${port}${path}${parsed.search}`;
}

/** 两个 MCP URL 是否指向同一端点（末尾 `/` 等价；端口不同不等价）。 */
export function sameMcpUrl(a, b) {
  const left = normalizeMcpUrl(a);
  const right = normalizeMcpUrl(b);
  if (left === null || right === null) {
    return typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();
  }
  return left === right;
}

/** 是否为**回环** HTTP MCP 地址（只对这类条目做“旧端口/旧路径”判定）。 */
export function isLoopbackMcpUrl(raw) {
  const normalized = normalizeMcpUrl(raw);
  if (normalized === null) return false;
  let host;
  try {
    host = new URL(normalized).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host === '0.0.0.0';
}

/** URL 诊断展示：去掉 userinfo（如 `user:pass@`）并脱敏已知凭据参数。 */
function displayMcpUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      parsed.username = '';
      parsed.password = '';
      return redactSecrets(parsed.toString());
    }
  } catch {
    // 无法解析时按原文脱敏展示（不阻断诊断）。
  }
  return redactSecrets(raw);
}

/** 回环配置是否与当前 runtime 端点“过期”：同端口/路径仅主机不同（如经 LAN 访问控制台）不算。 */
function staleLoopbackUrl(configuredUrl, expectedUrl) {
  if (!isLoopbackMcpUrl(configuredUrl)) return false;
  if (sameMcpUrl(configuredUrl, expectedUrl)) return false;
  try {
    const configured = new URL(normalizeMcpUrl(configuredUrl));
    const expected = new URL(normalizeMcpUrl(expectedUrl));
    // 控制台可能经 LAN/反向代理访问：同一 scheme+端口+路径时，loopback 对同机客户端仍有效。
    if (configured.protocol === expected.protocol
      && configured.port === expected.port
      && configured.pathname === expected.pathname) return false;
  } catch {
    return true;
  }
  return true;
}

/**
 * 诊断字段 + 可自愈判定：
 * - **回环 URL** 且端口/路径（或 scheme）与当前 runtime 不一致 → `staleUrl`（可自动 reconcile）；
 * - **非回环/自定义远端 URL** 且与当前端点不一致 → `needsConfirmation`（不自动覆盖，人工确认/显式修复）；
 * - 两端一致（仅末尾 `/`、回环别名差异）→ 正常。
 */
function urlDiagnostics(configuredUrl, expectedUrl) {
  const out = {};
  if (typeof configuredUrl === 'string' && configuredUrl.length > 0) out.configuredUrl = displayMcpUrl(configuredUrl);
  if (typeof expectedUrl === 'string' && expectedUrl.length > 0) out.expectedUrl = displayMcpUrl(expectedUrl);
  if (!out.configuredUrl || !out.expectedUrl) return { ...out, staleUrl: false, needsConfirmation: false };
  const configuredLoopback = isLoopbackMcpUrl(configuredUrl);
  const matches = sameMcpUrl(configuredUrl, expectedUrl);
  if (!matches && !configuredLoopback) {
    return {
      ...out,
      staleUrl: false,
      needsConfirmation: true,
      remoteUrl: true,
      staleReason: `自定义远端 MCP 地址与当前端点不一致：${out.configuredUrl}（当前为 ${out.expectedUrl}），不会自动覆盖，请确认或手动修复`,
    };
  }
  const staleUrl = staleLoopbackUrl(configuredUrl, expectedUrl);
  if (!staleUrl) return { ...out, staleUrl: false, needsConfirmation: false, remoteUrl: !configuredLoopback };
  return {
    ...out,
    staleUrl: true,
    needsConfirmation: false,
    remoteUrl: false,
    staleReason: `MCP 地址已过期：${out.configuredUrl}（当前为 ${out.expectedUrl}），请自动修复`,
  };
}

/** 形状选择：给 url → HTTP 形态；否则 stdio（descriptor 可用 `landing.httpShape` 覆盖）。 */
function shapeFor(format, options = {}) {
  const adapter = adapterFor(format);
  if (!adapter) return null;
  return options.url
    ? (options.httpShape ?? adapter.httpShape ?? 'url-only')
    : (options.stdioShape ?? adapter.stdioShape ?? 'stdio-mcpServers');
}

/**
 * 本机 MCP 条目（供合并/写入）：**有守护 url 即指向 HTTP `/mcp`**；无 url 回落 stdio。
 * F-FIX-B：守护运行中 stdio `mebular mcp` 会被 MCP_STORAGE_LOCKED 拒（F-CLI-2 设计如此）。
 */
export function mebularEntry(format, options = {}) {
  const adapter = adapterFor(format);
  if (!adapter) return { command: 'mebular', args: ['mcp'] };
  const entry = entryForShape(shapeFor(format, options), options.url) ?? { command: 'mebular', args: ['mcp'] };
  // descriptor 的固定字段（如 OpenChamber remote 条目的 oauth:false / codemode:false）。
  // 只在 HTTP 形态应用；stdio 回落保持最小形状。
  if (options.url && options.entryDefaults && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    return { ...entry, ...options.entryDefaults };
  }
  return entry;
}

/** 各客户端 MCP 片段（与 `mebular print-config --client …` 同源）；有 `url` → HTTP 形态。 */
export function snippetFor(format, options = {}) {
  if (format === 'opencode-remote') {
    return snippetFor('opencode-json', { url: options.url ?? 'http://127.0.0.1:7331/mcp' });
  }
  const url = options.url ?? null;
  const adapter = adapterFor(format);
  const id = adapter?.id ?? format;
  const entry = mebularEntry(format, { ...options, url });
  if (id === 'opencode-json') {
    return JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { mebular: entry } } }, null, 2);
  }
  if (id === 'dsh') {
    const cfg = entry.config ?? {};
    return cfg.transport === 'streamable-http'
      ? `plugins:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: mebular\n      transport: streamable-http\n      url: ${cfg.url}`
      : "plugins:\n  - name: '@deepseek-ai/dsh-mcp-client'\n    config:\n      serverName: mebular\n      transport: stdio\n      command: mebular\n      args: ['mcp']";
  }
  if (id === 'hermes-yaml') {
    return url
      ? ['mcp_servers:', '  mebular:', `    url: ${url}`, '    enabled: true'].join('\n')
      : ['mcp_servers:', '  mebular:', '    command: mebular', '    args:', '      - mcp', '    enabled: true'].join('\n');
  }
  if (id === 'toml') return url ? `[mcp_servers.mebular]\nurl = "${url}"\nenabled = true` : '[mcp_servers.mebular]\ncommand = "mebular"\nargs = ["mcp"]';
  if (id === 'yaml') return url ? `mcp_servers:\n  mebular:\n    url: ${url}\n    enabled: true` : 'mcp_servers:\n  mebular:\n    command: mebular\n    args: [mcp]';
  return JSON.stringify({ mcpServers: { mebular: entry } }, null, 2);
}

// ---------------------------------------------------------------------------
// A-18：探针/验证输出卫生（只打印键名/变量名，绝不回显凭据值）
// ---------------------------------------------------------------------------

/** 抹掉形如 `token=…` / `api_key: …` / `Authorization: Bearer …` 的值。 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(\bBearer\s+)[A-Za-z0-9\-._~+/=]+/gi, '$1<redacted>')
    .replace(/((?:\b|["'])(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|credential|private[_-]?key)(?:\b|["'])\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>');
}

// ---------------------------------------------------------------------------
// 内置条目（descriptor 六要素）
// ---------------------------------------------------------------------------

const HOME_OPENCODE = ['~', '.config', 'opencode', 'opencode.json'];
const HOME_HERMES = ['~', '.hermes', 'config.yaml'];

/**
 * assistant 落面/探测路径的**用户主目录**（F-FIX-A）：
 * 显式 `options.userHome` > `MEBULAR_USER_HOME` > `os.homedir()`。
 * **绝不**回退到 Mebular home（`MEBULAR_HOME`）——两者语义不同，混用会把路径拼成
 * `<MEBULAR_HOME>/.config/…`（真机事故：Hermes 被误报未安装、OpenChamber 写入错路径）。
 */
export function assistantUserHome(options = {}) {
  const explicit = options.userHome;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = options.env?.MEBULAR_USER_HOME ?? process.env.MEBULAR_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return homedir();
}

// ---------------------------------------------------------------------------
// OpenChamber 原生 memory 共存探测（只读；不读 entries / 不写 / 不注册工具）
// ---------------------------------------------------------------------------

const NATIVE_MEMORY_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** OpenChamber 数据根：`OPENCHAMBER_DATA_DIR` 优先，否则 `~/.config/openchamber`。 */
export function openChamberDataDir(options = {}) {
  const env = options.env ?? process.env;
  const raw = typeof env.OPENCHAMBER_DATA_DIR === 'string' ? env.OPENCHAMBER_DATA_DIR.trim() : '';
  if (raw.length > 0) return resolve(raw);
  return join(assistantUserHome(options), '.config', 'openchamber');
}

/**
 * 原生 memory 共存守卫（**只读**）：
 * - 读 env `OPENCHAMBER_MEMORY_ENABLE`（与 OpenChamber 同 truthy 集合）；
 * - 读 `settings.json` 的 `agentMemoryToolEnabled` 布尔值；
 * - 只 `exists`/列目录判断 `memory.json` 是否存在（global + projects/*），**绝不读取条目**。
 *
 * 不导入、不替换、不双写，也不注册任何 OpenChamber 原生 memory 工具。原生 memory 开启时
 * Mebular 沉浸式默认 `tool-only`，必须由用户显式 opt-in；状态里如实给出 summary/证据。
 */
export function detectOpenChamberNativeMemory(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = openChamberDataDir(options);
  const settingsPath = join(dataDir, 'settings.json');
  const rawFlag = typeof env.OPENCHAMBER_MEMORY_ENABLE === 'string' ? env.OPENCHAMBER_MEMORY_ENABLE : '';
  const featureEnabled = NATIVE_MEMORY_TRUTHY.has(rawFlag.trim().toLowerCase());

  let settingsRead = false;
  let toolEnabled = false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    settingsRead = true;
    toolEnabled = settings?.agentMemoryToolEnabled === true;
  } catch {
    // 文件不存在/不可读/损坏都按「未开启」处理；不修改、不创建。
  }

  const globalMemoryFileExists = existsSync(join(dataDir, 'memory.json'));
  let projectMemoryFiles = 0;
  try {
    const projectsDir = join(dataDir, 'projects');
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(projectsDir, entry.name, 'memory.json'))) {
        projectMemoryFiles += 1;
      }
    }
  } catch {
    // 无 projects/ 目录：正常（尚未使用原生 memory）。
  }
  const memoryFileExists = globalMemoryFileExists || projectMemoryFiles > 0;
  const enabled = featureEnabled && toolEnabled;
  const summary = enabled
    ? (memoryFileExists
      ? 'OpenChamber 原生 memory 已开启且检测到 memory.json；Mebular 沉浸式默认 tool-only，需显式 opt-in（不导入/不替换/不双写）'
      : 'OpenChamber 原生 memory 已开启（尚无 memory.json）；Mebular 沉浸式默认 tool-only，需显式 opt-in（不导入/不替换/不双写）')
    : (featureEnabled || toolEnabled || memoryFileExists
      ? 'OpenChamber 原生 memory 未完全开启；Mebular 沉浸式默认 tool-only，需显式 opt-in（不写入原生 memory）'
      : '未检测到 OpenChamber 原生 memory；Mebular 沉浸式仍需显式 opt-in');

  return {
    kind: 'openchamber-native-memory',
    readOnly: true,
    featureFlag: 'OPENCHAMBER_MEMORY_ENABLE',
    featureEnabled,
    setting: 'agentMemoryToolEnabled',
    toolEnabled,
    settingsRead,
    settingsPath,
    dataDir,
    memoryFileExists,
    memoryFiles: { global: globalMemoryFileExists, projects: projectMemoryFiles },
    enabled,
    active: enabled,
    immersiveDefault: 'tool-only',
    requiresExplicitOptIn: true,
    summary,
    signals: {
      env: 'OPENCHAMBER_MEMORY_ENABLE',
      setting: 'agentMemoryToolEnabled',
      memoryFile: 'memory.json',
    },
  };
}

/** 桌面壳/守护常驻的 opencode 捆绑目录（存在才注入 PATH）。 */
export const OPENCODE_BUNDLE_BIN = '/Applications/OpenChamber.app/Contents/Resources/opencode-cli';

/**
 * 增强 PATH（跨平台：用 `path.delimiter` 分割/拼接，绝不用 ':' 硬编码）：
 * 现有 PATH + `~/.local/bin`；非 Windows 追加 `/usr/local/bin`、`/opt/homebrew/bin`；
 * darwin 且**存在**时追加 opencode 捆绑目录（launchd 服务 env 的 PATH 极简）。
 */
export function enhancedPath(basePath = process.env.PATH, userHome = assistantUserHome(), platform = process.platform, pathDelimiter = delimiter) {
  const base = typeof basePath === 'string' && basePath.length > 0 ? basePath.split(pathDelimiter) : [];
  const extra = [join(userHome, '.local', 'bin')];
  if (platform !== 'win32') extra.push('/usr/local/bin', '/opt/homebrew/bin');
  if (platform === 'darwin' && existsSync(OPENCODE_BUNDLE_BIN)) extra.push(OPENCODE_BUNDLE_BIN);
  return [...new Set([...base, ...extra].filter((p) => typeof p === 'string' && p.length > 0))].join(pathDelimiter);
}

/** 子进程环境：继承进程环境 + 增强 PATH（launchd 服务 env 的 PATH 极简 → rc=127）。 */
export function spawnEnv(options = {}) {
  const userHome = assistantUserHome(options);
  return { ...process.env, ...(options.env ?? {}), PATH: enhancedPath(process.env.PATH, userHome, options.platform ?? process.platform) };
}

function expandHome(parts, home) {
  return join(home, ...parts.slice(1));
}

/** 内置助手注册表（六要素；落面/写入/验证值以 F-EXP-1 实测为准）。 */
export function builtinAssistants(options = {}) {
  const userHome = assistantUserHome(options);
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const appData = platform === 'darwin'
    ? join(userHome, 'Library', 'Application Support')
    : platform === 'win32'
      ? (env.APPDATA ?? join(userHome, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME ?? join(userHome, '.config'));
  const opencodePath = expandHome(HOME_OPENCODE, userHome);
  const hermesPath = expandHome(HOME_HERMES, userHome);
  const openChamberDir = join(userHome, '.config', 'openchamber');

  return [
    {
      id: 'openchamber', name: 'OpenChamber', kind: 'file', format: 'opencode-json',
      description: '复用 OpenCode global 配置：只写 mcp.servers.mebular（remote /mcp）；不接管原生 memory',
      landing: {
        primaryPath: opencodePath,
        keyPath: 'mcp.servers.mebular',
        // App 私有 managed config（含每次启动 run/instances/* 下的副本）只读、禁写。
        forbiddenPaths: [join(openChamberDir, 'opencode.managed.json')],
        forbiddenBasenames: ['opencode.managed.json'],
        forbiddenRoots: [join(openChamberDir, 'run', 'instances')],
        format: 'opencode-json',
        entryDefaults: { oauth: false, codemode: false },
      },
      probe: {
        signals: [
          { kind: 'config-path', paths: [opencodePath] },
          { kind: 'cli', command: 'opencode --version', timeoutMs: 1500 },
          { kind: 'app-bundle', paths: ['/Applications/OpenChamber.app'] },
          { kind: 'process', pattern: 'opencode serve --service' },
        ],
      },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { cli: { command: 'opencode mcp list', expect: 'mebular', timeoutMs: 4000 }, configReadback: true },
      activation: { kind: 'user-reload', note: 'OpenChamber：由用户在 App 侧重载/重启生效；产品不得发 opencode reload 干扰运行服务' },
      risks: [
        'opencode.managed.json（含 run/instances/*）为 App 所有且会被重写，禁写',
        'opencode mcp list 经运行服务回答，只读但勿频繁调用',
        '原生 memory 开启时，Mebular 沉浸式默认 tool-only，需显式 opt-in；不导入、不替换、不双写',
      ],
      nativeMemoryProbe: 'openchamber',
      coexistence: {
        nativeMemory: {
          detect: 'openchamber',
          readOnly: true,
          inputs: ['OPENCHAMBER_MEMORY_ENABLE', 'agentMemoryToolEnabled', 'memory.json'],
          neverImport: true,
          neverReplace: true,
          neverWrite: true,
          neverRegisterTool: true,
        },
        immersive: { defaultMode: 'tool-only', requiresExplicitOptIn: true },
      },
      skillsDirs: [join(userHome, '.config', 'opencode', 'skills'), join(cwd, '.opencode', 'skills')],
      reuseOf: 'opencode',
      note: 'OpenChamber 复用 OpenCode 的 global 配置（接一次即可）；原生 memory 只读共存，不导入/不替换/不双写',
    },
    {
      id: 'hermes', name: 'Hermes', kind: 'file', format: 'hermes-yaml',
      landing: { primaryPath: hermesPath, keyPath: 'mcp_servers.mebular', forbiddenPaths: [], format: 'hermes-yaml' },
      probe: {
        signals: [
          { kind: 'config-path', paths: [hermesPath] },
          { kind: 'dir', paths: [join(userHome, '.hermes')] },
          { kind: 'cli', command: 'hermes --version', timeoutMs: 2500 },
          { kind: 'path', paths: [join(userHome, '.local', 'bin', 'hermes')] },
        ],
      },
      writer: { strategy: 'cli-set', command: 'hermes config set --force mcp_servers.mebular', readbackCommand: 'hermes config get mcp_servers', backup: 'byte-level', atomic: false },
      verify: {
        cli: { command: 'hermes mcp test mebular', expect: '✓ Connected', toolsPattern: 'Tools discovered:\\s*(\\d+)', minTools: 1, timeoutMs: 30000 },
        configReadback: true,
      },
      activation: { kind: 'hot', note: 'Hermes 免重启：新会话即用，或已开会话 /reload-mcp' },
      risks: [
        'Hermes 无法 env 沙箱（HERMES_CONFIG_PATH 被剥离）→ 写前字节级备份 + 失败回滚为硬要求',
        '写入仅经 `hermes config set --force`（ruamel 保注释）；未知子键必须 --force',
      ],
      skillsDirs: [join(userHome, '.hermes', 'skills')],
      reuseOf: null,
      note: 'Hermes 的 MCP 配置在 ~/.hermes/config.yaml',
    },
    {
      id: 'opencode', name: 'OpenCode', kind: 'file', format: 'opencode-json',
      landing: { primaryPath: opencodePath, keyPath: 'mcp.servers.mebular', forbiddenPaths: [], format: 'opencode-json' },
      probe: {
        signals: [
          { kind: 'config-path', paths: [opencodePath] },
          { kind: 'cli', command: 'opencode --version', timeoutMs: 1500 },
          { kind: 'dir', paths: [join(userHome, '.config', 'opencode')] },
        ],
      },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { cli: { command: 'opencode mcp list', expect: 'mebular', timeoutMs: 4000 }, configReadback: true },
      activation: { kind: 'user-reload', note: 'OpenCode 侧重载/重启后生效' },
      risks: ['opencode mcp list 经运行服务回答，只读但勿频繁调用'],
      skillsDirs: [join(userHome, '.config', 'opencode', 'skills'), join(cwd, '.opencode', 'skills')],
      reuseOf: null,
      note: null,
    },
    {
      id: 'claude-code', name: 'Claude Code', kind: 'file', format: 'json-mcpServers',
      landing: { primaryPath: join(userHome, '.claude.json'), keyPath: 'mcpServers.mebular', forbiddenPaths: [], format: 'json-mcpServers', httpShape: 'claude-http' },
      probe: { signals: [{ kind: 'config-path', paths: [join(userHome, '.claude.json')] }, { kind: 'dir', paths: [join(userHome, '.claude')] }, { kind: 'cli', command: 'claude --version', timeoutMs: 1500 }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true },
      activation: { kind: 'user-reload', note: '重启 Claude Code 后生效' },
      risks: [],
      skillsDirs: [join(userHome, '.claude', 'skills'), join(cwd, '.claude', 'skills')],
      reuseOf: null, note: null,
    },
    {
      id: 'claude-desktop', name: 'Claude Desktop', kind: 'file', format: 'json-mcpServers',
      landing: { primaryPath: join(appData, 'Claude', 'claude_desktop_config.json'), keyPath: 'mcpServers.mebular', forbiddenPaths: [], format: 'json-mcpServers', httpShape: 'claude-http' },
      probe: { signals: [{ kind: 'config-path', paths: [join(appData, 'Claude', 'claude_desktop_config.json')] }, { kind: 'dir', paths: [join(appData, 'Claude')] }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true },
      activation: { kind: 'user-reload', note: '完全退出并重开 Claude Desktop 后生效' },
      risks: [],
      skillsDirs: [], reuseOf: null, note: null,
    },
    {
      id: 'cursor', name: 'Cursor', kind: 'file', format: 'json-mcpServers',
      landing: { primaryPath: join(userHome, '.cursor', 'mcp.json'), keyPath: 'mcpServers.mebular', forbiddenPaths: [], format: 'json-mcpServers' },
      probe: { signals: [{ kind: 'config-path', paths: [join(userHome, '.cursor', 'mcp.json')] }, { kind: 'dir', paths: [join(userHome, '.cursor')] }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true },
      activation: { kind: 'user-reload', note: '重启 Cursor 后生效' },
      risks: ['HTTP /mcp 默认只监听回环：客户端与守护须**同机**（跨机请在 config 里启用 TLS+鉴权并用可达主机名）'],
      skillsDirs: [join(userHome, '.cursor', 'skills'), join(cwd, '.cursor', 'skills')], reuseOf: null, note: null,
    },
    {
      id: 'dsh', name: 'DeepSeek Harness (DSH)', kind: 'file', format: 'dsh',
      landing: { primaryPath: join(cwd, '.dsh', 'cordis.yml'), keyPath: 'plugins', forbiddenPaths: [], format: 'dsh' },
      probe: {
        signals: [
          { kind: 'config-path', paths: [join(cwd, '.dsh', 'cordis.yml')] },
          // DSH_HOME 默认 ~/.dsh；全局安装也要能被自动检测（Skill 仍写 ~/.agents/skills）。
          { kind: 'dir', paths: [join(cwd, '.dsh'), join(userHome, '.dsh')] },
        ],
      },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true },
      activation: { kind: 'user-reload', note: '重启 DSH 后生效' },
      risks: ['DSH 配置为 YAML 插件列表：结构未知时不自动改写', 'HTTP /mcp 默认只监听回环：客户端与守护须同机（跨机请启用 TLS+鉴权并用可达主机名）'],
      skillsDirs: [join(userHome, '.agents', 'skills'), join(cwd, '.dsh', 'skills')], reuseOf: null, note: null,
    },
    {
      id: 'generic', name: '其他 AI 助手（复制片段）', kind: 'snippet', format: 'generic-snippet',
      landing: { primaryPath: null, keyPath: 'mcpServers.mebular', forbiddenPaths: [], format: 'generic-snippet' },
      probe: { signals: [{ kind: 'always', reason: '通用条目：不探测，仅提供片段' }] },
      writer: { strategy: 'manual', command: null, backup: 'n/a', atomic: false },
      verify: { configReadback: false },
      activation: { kind: 'user-reload', note: '按你的助手文档重载后生效' },
      risks: ['不支持自动写入：复制片段粘贴到你的 MCP 配置', '片段默认指向本机守护 HTTP /mcp（http://127.0.0.1:<port>/mcp）；跨机请用可达主机名并启用 TLS+鉴权'],
      skillsDirs: [], reuseOf: null, note: '不支持自动写入：复制片段粘贴到你的 MCP 配置',
    },
  ];
}

// ---------------------------------------------------------------------------
// 自定义条目（`<home>/assistants.custom.json`；红线五：与内置同 schema/同判据）
// ---------------------------------------------------------------------------

export function customAssistantsPath(home = homedir()) {
  return join(home, 'assistants.custom.json');
}

const CUSTOM_SCHEMA_HINT = 'assistants.custom.json 需为 {"assistants":[{id,name,landing,probe,writer,verify,activation}]}';

/** 校验一条自定义 descriptor（与内置同 schema；至少一条 probe 信号）。 */
export function validateAssistant(entry) {
  const errors = [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(entry)) return ['条目不是对象'];
  if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) errors.push('id 必须为小写 kebab-case');
  if (typeof entry.name !== 'string' || entry.name.trim() === '') errors.push('name 必填');
  if (!isObj(entry.landing)) errors.push('landing 必填');
  else {
    if (typeof entry.landing.format !== 'string' || !adapterFor(entry.landing.format)) errors.push(`landing.format 未知：${entry.landing.format}`);
    if (entry.landing.primaryPath !== null && typeof entry.landing.primaryPath !== 'string') errors.push('landing.primaryPath 必须是字符串或 null');
    if (entry.landing.forbiddenPaths !== undefined && !Array.isArray(entry.landing.forbiddenPaths)) errors.push('landing.forbiddenPaths 必须是数组');
  }
  if (!isObj(entry.probe) || !Array.isArray(entry.probe.signals) || entry.probe.signals.length === 0) errors.push('probe.signals 至少一条');
  if (!isObj(entry.writer)) errors.push('writer 必填');
  else if (!['merge-key', 'cli-set', 'manual'].includes(entry.writer.strategy)) errors.push(`writer.strategy 未知：${entry.writer.strategy}`);
  if (entry.writer?.strategy === 'cli-set' && (typeof entry.writer.command !== 'string' || entry.writer.command.trim() === '')) errors.push('cli-set 必须给 writer.command');
  if (entry.writer?.strategy !== 'manual' && entry.writer?.backup !== 'byte-level') errors.push('merge-key/cli-set 必须 writer.backup=byte-level');
  if (!isObj(entry.verify)) errors.push('verify 必填');
  else if (entry.verify.cli === undefined && entry.verify.configReadback !== true) errors.push('verify.cli 缺省时 configReadback 必须为 true');
  if (!isObj(entry.activation) || !['hot', 'user-reload'].includes(entry.activation?.kind)) errors.push('activation.kind 必须是 hot|user-reload');
  return errors;
}

/** 读自定义条目；文件损坏 → 返回 error（不静默当空）。 */
export function loadCustomAssistants(options = {}) {
  const home = options.home ?? homedir();
  const file = customAssistantsPath(home);
  if (!existsSync(file)) return { assistants: [], error: null, path: file };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    return { assistants: [], error: `${CUSTOM_SCHEMA_HINT}（解析失败：${error instanceof Error ? error.message : String(error)}）`, path: file };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.assistants)) {
    return { assistants: [], error: CUSTOM_SCHEMA_HINT, path: file };
  }
  const assistants = [];
  for (const entry of parsed.assistants) {
    if (validateAssistant(entry).length === 0) {
      // 归一化：自定义条目可省略 format/kind（从 landing 推导），与内置同形。
      assistants.push({
        ...entry,
        kind: entry.kind ?? (entry.writer?.strategy === 'manual' ? 'snippet' : 'file'),
        format: entry.format ?? entry.landing?.format,
      });
    }
  }
  return { assistants, error: null, path: file };
}

async function saveCustomAssistants(options, assistants) {
  const home = options.home ?? homedir();
  const file = customAssistantsPath(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ assistants }, null, 2)}\n`, 'utf-8');
  try { await chmod(file, 0o600); } catch { /* Windows 无 POSIX mode */ }
  return file;
}

/** 新增自定义条目（id 与内置/自定义冲突 → 失败）。 */
export async function addCustomAssistant(entry, options = {}) {
  const errors = validateAssistant(entry);
  if (errors.length > 0) return { ok: false, reason: `descriptor 校验失败：${errors.join('；')}` };
  if (builtinAssistants(options).some((b) => b.id === entry.id)) return { ok: false, reason: `id 与内置条目冲突：${entry.id}` };
  const { assistants } = loadCustomAssistants(options);
  if (assistants.some((a) => a.id === entry.id)) return { ok: false, reason: `id 已存在：${entry.id}` };
  const next = [...assistants, entry];
  const path = await saveCustomAssistants(options, next);
  clearAssistantsCache(); // F-PERF-2：写后失效，避免读到陈旧三态
  return { ok: true, added: entry.id, path, count: next.length };
}

/** 更新自定义条目（内置不可改）。 */
export async function updateCustomAssistant(id, patch, options = {}) {
  if (builtinAssistants(options).some((b) => b.id === id)) return { ok: false, reason: `内置条目不可修改：${id}` };
  const { assistants } = loadCustomAssistants(options);
  const idx = assistants.findIndex((a) => a.id === id);
  if (idx < 0) return { ok: false, reason: `自定义条目不存在：${id}` };
  const merged = { ...assistants[idx], ...patch, id };
  const errors = validateAssistant(merged);
  if (errors.length > 0) return { ok: false, reason: `descriptor 校验失败：${errors.join('；')}` };
  const next = assistants.slice();
  next[idx] = merged;
  const path = await saveCustomAssistants(options, next);
  clearAssistantsCache(); // F-PERF-2：写后失效，避免读到陈旧三态
  return { ok: true, updated: id, path };
}

/** 删除自定义条目（内置不允许删除）。 */
export async function removeCustomAssistant(id, options = {}) {
  if (builtinAssistants(options).some((b) => b.id === id)) return { ok: false, reason: `内置条目不可删除：${id}` };
  const { assistants } = loadCustomAssistants(options);
  const next = assistants.filter((a) => a.id !== id);
  if (next.length === assistants.length) return { ok: false, reason: `自定义条目不存在：${id}` };
  const path = await saveCustomAssistants(options, next);
  clearAssistantsCache(); // F-PERF-2：写后失效，避免读到陈旧三态
  return { ok: true, removed: id, path, count: next.length };
}

/** 注册表 = 内置 ∪ 自定义（自定义可覆盖同名内置？——不允许：id 冲突在登记时已拒绝）。 */
export function registry(options = {}) {
  const custom = loadCustomAssistants(options);
  return { assistants: [...builtinAssistants(options), ...custom.assistants], customError: custom.error, customPath: custom.path };
}

// ---------------------------------------------------------------------------
// 兼容投影（既有调用方：clientDescriptors / descriptorFor）
// ---------------------------------------------------------------------------

export function clientDescriptors(options = {}) {
  return builtinAssistants(options).map((a) => ({
    id: a.id, name: a.name, format: a.format, kind: a.kind,
    configPath: a.landing.primaryPath,
    skillsDirs: a.skillsDirs ?? [],
    requiresRestart: a.activation.kind === 'user-reload',
    reuseOf: a.reuseOf ?? null, note: a.note ?? null,
    description: a.description ?? null,
    coexistence: a.coexistence ?? null,
  }));
}

export function descriptorFor(id, options = {}) {
  return builtinAssistants(options).find((d) => d.id === id)
    ?? loadCustomAssistants(options).assistants.find((d) => d.id === id)
    ?? null;
}

// ---------------------------------------------------------------------------
// 合并（JSON：只并助手一条键；结构未知 → 不写）
// ---------------------------------------------------------------------------

function keyPathOf(format, keyPathOverride) {
  if (Array.isArray(keyPathOverride)) return keyPathOverride;
  const adapter = adapterFor(format);
  return adapter ? adapter.keyPath : ['mcpServers', 'mebular'];
}

function walkGet(root, path) {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return { missing: true, badAt: key };
    if (!(key in node)) return { missing: true, value: undefined };
    node = node[key];
  }
  return { value: node };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 扫描 JSON 字符串（text[start] === '"'）返回结束位置（不含引号之后）。 */
function scanJsonString(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') return i + 1;
    i += 1;
  }
  throw new Error('unterminated JSON string');
}

/** 轻量 JSON 区间解析（仅用于已有合法 JSON 的「只替换 mebular」写入，保留其他字节）。 */
function parseJsonRanges(text) {
  let i = 0;
  const skip = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const value = () => {
    skip();
    const start = i;
    const ch = text[i];
    if (ch === '{') {
      i += 1;
      const members = [];
      skip();
      if (text[i] === '}') { i += 1; return { type: 'object', start, end: i, members }; }
      for (;;) {
        skip();
        const keyStart = i;
        if (text[i] !== '"') throw new Error('object key expected');
        i = scanJsonString(text, i);
        const key = JSON.parse(text.slice(keyStart, i));
        skip();
        if (text[i] !== ':') throw new Error('colon expected');
        i += 1;
        const child = value();
        members.push({ key, keyStart, value: child });
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; break; }
        throw new Error('object delimiter expected');
      }
      return { type: 'object', start, end: i, members };
    }
    if (ch === '[') {
      i += 1;
      const items = [];
      skip();
      if (text[i] === ']') { i += 1; return { type: 'array', start, end: i, items }; }
      for (;;) {
        items.push(value());
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; break; }
        throw new Error('array delimiter expected');
      }
      return { type: 'array', start, end: i, items };
    }
    if (ch === '"') {
      const end = scanJsonString(text, i);
      i = end;
      return { type: 'string', start, end };
    }
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i += 1;
    return { type: 'primitive', start, end: i };
  };
  return value();
}

function lineIndentAt(text, index) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart));
  return match ? match[0] : '';
}

function indentJsonValue(value, text, start, indent) {
  const target = indent ?? ' '.repeat(Math.max(0, start - (text.lastIndexOf('\n', Math.max(0, start - 1)) + 1)));
  return JSON.stringify(value, null, 2).split('\n').join(`\n${target}`);
}

/** 把 `keys` 逐层包成对象（用于补齐缺失的中间键）。 */
function nestedJsonValue(keys, value) {
  let out = value;
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    out = { [keys[index]]: out };
  }
  return out;
}

/** 在已有 JSON 对象的最后一个成员之后插入一个属性（其他字节不动）。 */
function insertJsonProperty(text, node, key, value) {
  const indent = `${lineIndentAt(text, node.start)}  `;
  const property = `${JSON.stringify(key)}: ${indentJsonValue(value, text, node.start + 1, indent)}`;
  if (node.members.length > 0) {
    const at = node.members[node.members.length - 1].value.end;
    return text.slice(0, at) + `,\n${indent}${property}` + text.slice(at);
  }
  return text.slice(0, node.start + 1)
    + `\n${indent}${property}\n${lineIndentAt(text, node.start)}`
    + text.slice(node.start + 1);
}

/**
 * 只改 `<keyPath>` 的 JSON 文本：已有条目 → 原位替换 value；缺失 → 插入父对象
 * （中间键缺失时一并补齐）；删除 → 摘除成员。其余字节（其他键、缩进、换行）原样保留。
 * 结构异常 → null（调用方回落到整体序列化）。
 */
function spliceJsonEntry(text, path, value) {
  const root = parseJsonRanges(text);
  let node = root;
  for (let depth = 0; depth < path.length - 1; depth += 1) {
    const key = path[depth];
    if (node.type !== 'object') return null;
    const member = node.members.find((item) => item.key === key);
    if (!member) {
      if (value === undefined) return text;
      return insertJsonProperty(text, node, key, nestedJsonValue(path.slice(depth + 1), value));
    }
    node = member.value;
  }
  if (node.type !== 'object') return null;
  const leaf = path[path.length - 1];
  const index = node.members.findIndex((item) => item.key === leaf);

  if (value === undefined) {
    if (index < 0) return text;
    const member = node.members[index];
    if (node.members.length === 1) {
      return text.slice(0, node.start + 1) + text.slice(node.end - 1);
    }
    if (index > 0) {
      const previous = node.members[index - 1];
      return text.slice(0, previous.value.end) + text.slice(member.value.end);
    }
    const next = node.members[index + 1];
    return text.slice(0, member.keyStart) + text.slice(next.keyStart);
  }

  if (index >= 0) {
    const member = node.members[index];
    return text.slice(0, member.value.start)
      + indentJsonValue(value, text, member.value.start)
      + text.slice(member.value.end);
  }

  return insertJsonProperty(text, node, leaf, value);
}

/**
 * JSON 合并：设置或删除 `<keyPath>`（默认含叶子 `mebular`），保留其余键。
 * 中间键存在但非对象 → error（结构未知，不自动改写）。
 *
 * `preserveEntryFields`：已有 Mebular 条目是对象时，仅覆盖新条目提供的字段（保留 headers、
 * timeout、protocol 等用户字段；local → remote 升级时移除 command/cwd/environment）。
 * `preserveFormatting`：用区间替换只动 mebular 文本，其他配置键字节不变（失败回落整体序列化）。
 */
export function mergeJsonEntry(existingText, { format, entry, keyPath, preserveEntryFields = false, preserveFormatting = false } = {}) {
  const path = keyPathOf(format, keyPath);
  let parsed;
  if (existingText === null || existingText === undefined || existingText.trim() === '') {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(existingText);
    } catch (error) {
      return { error: `配置不是合法 JSON（${error instanceof Error ? error.message : String(error)}）` };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '配置顶层不是对象（结构未知，不自动改写）' };
  }
  const parents = path.slice(0, -1);
  const leaf = path[path.length - 1];
  const next = { ...parsed };
  let cursor = next;
  for (const key of parents) {
    const current = cursor[key];
    if (current === undefined) {
      cursor[key] = {};
    } else if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { error: `字段 ${key} 结构未知（非对象，不自动改写）` };
    } else {
      cursor[key] = { ...current };
    }
    cursor = cursor[key];
  }
  const previous = cursor[leaf];
  let nextEntry = entry;
  if (preserveEntryFields && entry !== undefined && isPlainObject(previous) && isPlainObject(entry)) {
    nextEntry = { ...previous, ...entry };
    if (entry.type === 'remote' && previous.type !== 'remote') {
      // local → remote：移除只对 stdio/local 有意义的字段，其他用户字段保留。
      delete nextEntry.command;
      delete nextEntry.cwd;
      delete nextEntry.environment;
    }
  }
  const changed = JSON.stringify(previous ?? null) !== JSON.stringify(nextEntry ?? null);
  if (entry === undefined) delete cursor[leaf];
  else cursor[leaf] = nextEntry;

  let text = `${JSON.stringify(next, null, 2)}\n`;
  if (!changed && typeof existingText === 'string') {
    text = existingText;
  } else if (preserveFormatting && typeof existingText === 'string' && existingText.trim() !== '') {
    try {
      const spliced = spliceJsonEntry(existingText, path, nextEntry);
      if (spliced !== null) text = spliced;
    } catch {
      // 区间解析失败：保持整体序列化的安全回落。
    }
  }
  return { changed, next, text };
}

/** 只替换 DSH mebular 条目里的 `url:` 行（保留其他插件与键）。 */
function replaceDshMebularUrl(text, url) {
  const block = dshMebularBlock(text);
  if (block === null) return null;
  const start = text.indexOf(block);
  if (start < 0) return null;
  const replaced = block.replace(/^(\s*url\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s#]+)/m, `$1${url}`);
  if (replaced === block) return null;
  return `${text.slice(0, start)}${replaced}${text.slice(start + block.length)}`;
}

/** DSH(YAML) 合并：空文件 → 写片段；已含 serverName: mebular → 幂等；结构未知 → 不写。 */
export function mergeDsh(existingText, options = {}) {
  const snippet = snippetFor('dsh', options);
  if (existingText === null || existingText.trim() === '') return { changed: true, text: `${snippet}\n` };
  if (/serverName:\s*['"]?mebular['"]?/.test(existingText)) {
    // 已接入：仅当**形态/端点等价**才算幂等，否则只改 mebular 的 URL（保留其他插件）。
    const block = dshMebularBlock(existingText);
    const scope = block ?? existingText;
    const wantHttp = Boolean(options.url);
    const hasHttp = /transport:\s*streamable-http/.test(scope);
    if (wantHttp === hasHttp) {
      if (wantHttp && hasHttp) {
        const urlInfo = urlDiagnostics(yamlEntryUrl(scope), options.url);
        if (urlInfo.staleUrl === true) {
          const next = replaceDshMebularUrl(existingText, options.url);
          if (next !== null) return { changed: true, text: next };
          return { error: 'DSH 配置中的 mebular URL 无法定位：未自动改写（请按片段人工合并）' };
        }
      }
      return { changed: false, text: existingText };
    }
    return { changed: true, text: `${snippet}\n` };
  }
  return { error: 'DSH 配置已存在但未接入：YAML 结构未知，未自动改写（请按片段人工合并）' };
}

/** 行级 diff（信任增强：写入前后预览）。 */
export function lineDiff(before, after) {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
  }
  return out.join('\n');
}

function safeReadText(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

/** YAML 行式判据：`<parent>:` 下出现 2 空格缩进的 `<child>:`（Hermes 用；避免引 yaml 依赖）。 */
export function yamlHasKey(text, parent, child) {
  if (typeof text !== 'string') return false;
  const lines = text.split('\n');
  let inParent = false;
  for (const line of lines) {
    if (new RegExp(`^${parent}\\s*:`).test(line)) { inParent = true; continue; }
    if (!inParent) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // 注释/空行不终止父段（与 yamlEntryBlock 一致）
    if (/^\S/.test(line)) break;                            // 真正的顶格非注释行 → 父段结束
    if (new RegExp(`^\\s{1,4}${child}\\s*:`).test(line)) return true;
  }
  return false;
}

/** 提取 YAML 中 `<parent>:` 下 `<child>:` 的块文本（行式，供语义判据；无需 yaml 依赖）。 */
export function yamlEntryBlock(text, parent, child) {
  const lines = String(text ?? '').split('\n');
  let inParent = false;
  let block = null;
  for (const line of lines) {
    if (new RegExp(`^${parent}\\s*:`).test(line)) { inParent = true; continue; }
    if (!inParent) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // 顶格注释/空行不终止父段，也不进子块
    if (/^\S/.test(line)) break; // 真正的顶格非注释行 → 父段结束（**保留**已收集的块，勿清空）
    if (new RegExp(`^\\s{1,6}${child}\\s*:`).test(line)) { block = [line]; continue; }
    if (block !== null) block.push(line); // 子块内的缩进行
  }
  return block === null ? null : block.join('\n');
}

/** 提取 YAML 块里 `url:` 的标量值（支持单/双引号与行尾注释；无则 null）。 */
export function yamlEntryUrl(block) {
  if (typeof block !== 'string') return null;
  const match = /^\s*url\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m.exec(block);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * 提取 DSH YAML 插件列表中 `serverName: mebular` 的那一项（行式；无需 yaml 依赖）。
 * 只用于把 URL 判据/改写限制在 mebular 条目内，避免误碰其他插件。
 */
export function dshMebularBlock(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s+name\s*:/.test(lines[i])) continue;
    const itemIndent = lines[i].match(/^\s*/)?.[0].length ?? 0;
    const item = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      const leading = line.match(/^\s*/)?.[0].length ?? 0;
      const nextItem = /^\s*-\s+/.test(line) && leading === itemIndent;
      const topLevel = line.trim().length > 0 && leading === 0;
      if (nextItem || topLevel) break;
      item.push(line);
    }
    const block = item.join('\n');
    if (/serverName:\s*['"]?mebular['"]?/.test(block)) return block;
  }
  return null;
}

/** 该格式下「HTTP/remote」形态（valid）；`stdio` 形态守护运行中会被拒（MCP_STORAGE_LOCKED）。 */
export function entryIsHttp(format, entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (format === 'opencode-json') return entry.type === 'remote' || entry.type === 'http';
  if (format === 'dsh') return entry.config?.transport === 'streamable-http';
  return typeof entry.url === 'string' && entry.url.length > 0;
}
export function entryIsStdio(format, entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (format === 'opencode-json') return entry.type === 'local' && Array.isArray(entry.command);
  if (format === 'dsh') return entry.config?.transport === 'stdio';
  return typeof entry.command === 'string' && entry.url === undefined;
}

/** 该助手在落面是否已有**正确形状**的 mebular 条目；并如实报 legacy 错形状。 */
export function landingState(assistant, options = {}) {
  const primary = assistant.landing?.primaryPath ?? null;
  const format = assistant.landing?.format;
  const adapter = adapterFor(format);
  if (!primary) return { exists: false, present: false, legacyShape: false, text: null };
  const text = safeReadText(primary);
  if (text === null) return { exists: false, present: false, legacyShape: false, text: null };
  if (format === 'dsh') {
    const block = dshMebularBlock(text);
    const scope = block ?? text;
    const has = /serverName:\s*['"]?mebular['"]?/.test(scope);
    const hasHttp = has && /transport:\s*streamable-http/.test(scope);
    const urlInfo = urlDiagnostics(yamlEntryUrl(scope), options.mcpUrl);
    const staleUrl = hasHttp && urlInfo.staleUrl === true;
    const needsConfirmation = hasHttp && urlInfo.needsConfirmation === true;
    return {
      exists: true,
      present: hasHttp && !staleUrl && !needsConfirmation,
      legacyShape: false,
      staleStdio: has && /transport:\s*stdio/.test(scope) && !hasHttp,
      ...urlInfo,
      staleUrl,
      needsConfirmation,
      text,
    };
  }
  if (adapter?.serialization === 'yaml') {
    const path = keyPathOf(format);
    const block = yamlEntryBlock(text, path[0], path[1]);
    const hasUrl = block !== null && /^\s*url\s*:\s*\S+/m.test(block);
    const hasCommand = block !== null && /^\s*command\s*:\s*\S+/m.test(block);
    const urlInfo = urlDiagnostics(yamlEntryUrl(block), options.mcpUrl);
    const staleUrl = hasUrl && urlInfo.staleUrl === true;
    const needsConfirmation = hasUrl && urlInfo.needsConfirmation === true;
    // 语义判据：remote（有 url 且端点未过期/未待确认）→ present；stdio 形态或旧 loopback 地址 → stale
    const present = hasUrl && !hasCommand && !staleUrl && !needsConfirmation;
    return {
      exists: true,
      present,
      legacyShape: false,
      staleStdio: !present && hasCommand,
      ...urlInfo,
      staleUrl,
      needsConfirmation,
      text,
    };
  }
  try {
    const parsed = JSON.parse(text);
    const path = keyPathOf(format);
    const stored = walkGet(parsed, path).value ?? null;
    const legacy = adapter?.legacyKeyPath
      ? walkGet(parsed, adapter.legacyKeyPath).value !== undefined
      : false;
    // 语义判据（兼容迁移）：remote/http 形态且端点未过期 → present；stdio 形态 → stale
    const isHttp = entryIsHttp(format, stored);
    const storedUrl = typeof stored?.url === 'string' ? stored.url : null;
    const urlInfo = urlDiagnostics(isHttp ? storedUrl : null, options.mcpUrl);
    const staleUrl = isHttp && urlInfo.staleUrl === true;
    const needsConfirmation = isHttp && urlInfo.needsConfirmation === true;
    const present = isHttp && !staleUrl && !needsConfirmation;
    const staleStdio = !present && entryIsStdio(format, stored);
    return { exists: true, present, legacyShape: legacy && !present, staleStdio, ...urlInfo, staleUrl, needsConfirmation, text };
  } catch {
    return { exists: true, present: false, legacyShape: false, text, parseError: true };
  }
}

// ---------------------------------------------------------------------------
// 探测（多信号并集，逐信号可证伪；红线一/二）
// ---------------------------------------------------------------------------

export const DEFAULT_CLI_TIMEOUT_MS = 1500;

function defaultRun(command, timeoutMs, options = {}) {
  const res = spawnSync(command, { shell: true, encoding: 'utf-8', timeout: timeoutMs, env: spawnEnv(options) });
  return { ok: res.status === 0, code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function defaultProcessList(options = {}) {
  try {
    const res = spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf-8', timeout: 2000, env: spawnEnv(options) });
    return res.status === 0 ? (res.stdout ?? '') : '';
  } catch {
    return '';
  }
}

const execAsync = promisify(exec);

/** 异步命令执行（请求路径唯一入口；`exec` 自带 shell 语义，跨平台）。 */
async function defaultRunAsync(command, timeoutMs, options = {}) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 1 << 20, windowsHide: true, env: spawnEnv(options) });
    return { ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
    };
  }
}

async function defaultProcessListAsync(options = {}) {
  const r = await defaultRunAsync('ps -Ao command', 2000, options);
  return r.ok ? r.stdout : '';
}

/** 评估一条 probe 信号；返回 `{ kind, source, hit, detail }`（detail 一律脱敏）。 */
export function probeSignal(signal, options = {}) {
  const run = options.run ?? defaultRun;
  const source = signal.paths?.[0] ?? signal.command ?? signal.pattern ?? signal.kind;
  try {
    if (signal.kind === 'always') return { kind: signal.kind, source, hit: true, detail: signal.reason ?? 'n/a' };
    if (signal.kind === 'config-path' || signal.kind === 'app-bundle' || signal.kind === 'dir' || signal.kind === 'path') {
      const paths = Array.isArray(signal.paths) ? signal.paths : [];
      const hit = paths.some((p) => existsSync(p));
      return { kind: signal.kind, source, hit, detail: hit ? `存在：${paths.find((p) => existsSync(p))}` : `不存在：${paths.join(' / ')}` };
    }
    if (signal.kind === 'cli') {
      const r = run(signal.command, signal.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS, options);
      return { kind: signal.kind, source, hit: r.ok === true, detail: `rc=${r.code}` };
    }
    if (signal.kind === 'process') {
      const list = options.processList ?? (() => defaultProcessList(options));
      const out = typeof list === 'function' ? list() : String(list ?? '');
      const hit = out.includes(signal.pattern);
      return { kind: signal.kind, source, hit, detail: hit ? '进程命中' : '进程未命中' };
    }
    return { kind: signal.kind, source, hit: false, detail: `未知信号类型：${signal.kind}` };
  } catch (error) {
    return { kind: signal.kind, source, hit: false, detail: `探测异常：${redactSecrets(error?.message ?? error)}` };
  }
}


/** `probeSignal` 的**异步**版本（请求路径用；语义完全一致，仅把 spawnSync 换成 exec）。 */
export async function probeSignalAsync(signal, options = {}) {
  const runAsync = options.runAsync ?? (options.run
    ? (cmd, t) => Promise.resolve(options.run(cmd, t))
    : defaultRunAsync);
  const listAsync = options.processListAsync ?? (options.processList !== undefined
    ? () => Promise.resolve(options.processList)
    : () => defaultProcessListAsync(options));
  const source = signal.paths?.[0] ?? signal.command ?? signal.pattern ?? signal.kind;
  try {
    if (signal.kind === 'always') return { kind: signal.kind, source, hit: true, detail: signal.reason ?? 'n/a' };
    if (signal.kind === 'config-path' || signal.kind === 'app-bundle' || signal.kind === 'dir' || signal.kind === 'path') {
      const paths = Array.isArray(signal.paths) ? signal.paths : [];
      const hit = paths.some((p) => existsSync(p));
      return { kind: signal.kind, source, hit, detail: hit ? `存在：${paths.find((p) => existsSync(p))}` : `不存在：${paths.join(' / ')}` };
    }
    if (signal.kind === 'cli') {
      // F-PERF-2：CLI 版本类探针按**短 TTL**缓存（默认 30s）——真实 CLI 启动可达数百毫秒
      // （本机 hermes --version ≈763ms），`refresh` 只重算**列表/落面**，不必重复 spawn 版本探测。
      // 注：注入的 `run`/`runAsync`（测试）不缓存，保证替身语义确定。
      const injected = options.runAsync !== undefined || options.run !== undefined;
      const cacheKey = `${signal.command}::${signal.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS}`;
      if (!injected && options.refreshProbes !== true) {
        const cachedCli = cliProbeCache.get(cacheKey);
        if (cachedCli && Date.now() - cachedCli.at < PROBE_CACHE_TTL_MS) {
          return { kind: signal.kind, source, hit: cachedCli.hit, detail: `rc=${cachedCli.code}` };
        }
      }
      const r = await runAsync(signal.command, signal.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS, options);
      if (!injected) cliProbeCache.set(cacheKey, { at: Date.now(), hit: r.ok === true, code: r.code });
      return { kind: signal.kind, source, hit: r.ok === true, detail: `rc=${r.code}` };
    }
    if (signal.kind === 'process') {
      const out = String((await listAsync()) ?? '');
      const hit = out.includes(signal.pattern);
      return { kind: signal.kind, source, hit, detail: hit ? '进程命中' : '进程未命中' };
    }
    return { kind: signal.kind, source, hit: false, detail: `未知信号类型：${signal.kind}` };
  } catch (error) {
    return { kind: signal.kind, source, hit: false, detail: `探测异常：${redactSecrets(error?.message ?? error)}` };
  }
}

// ---------------------------------------------------------------------------
// 三态 + 派生态（A-1/A-2/A-4/A-6 数据面）
// ---------------------------------------------------------------------------

/** 单条助手状态（含 evidence / hasVerify / activation / kind）。 */
function builtinsCount(reg, options) {
  return Math.min(builtinAssistants(options).length, reg.assistants.length);
}

/** 条目选项（形状 + url）：由 descriptor 的 `landing` 与当前守护端点决定。 */
function entryOptionsFor(assistant, options = {}) {
  const url = options.mcpUrl ?? null;
  const httpShape = assistant.landing?.httpShape;
  const entryDefaults = assistant.landing?.entryDefaults;
  return {
    ...(url ? { url } : {}),
    ...(httpShape ? { httpShape } : {}),
    ...(url && entryDefaults ? { entryDefaults } : {}),
  };
}

function buildStateItem(assistant, signals, landing, options = {}) {
  const anyHit = signals.some((s) => s.hit);
  const anyError = signals.some((s) => typeof s.detail === 'string' && s.detail.startsWith('探测异常'));
  const strategy = assistant.writer?.strategy ?? 'merge-key';
  const staleUrl = landing.staleUrl === true;
  const staleStdio = landing.staleStdio === true;
  const needsConfirmation = landing.needsConfirmation === true;
  let state;
  if (strategy === 'manual' && !landing.present) state = anyHit ? 'manual' : 'not-installed';
  else if (landing.present) state = 'connected';
  else if (needsConfirmation) state = 'needs-confirmation'; // 自定义远端 URL 与当前端点不一致：不自动覆盖
  else if (staleUrl) state = 'stale';      // 配置的 loopback MCP 地址已过期（旧端口/旧路径）
  else if (staleStdio) state = 'stale';    // 已写入但过时（stdio）→ 升级直连
  else if (!anyHit) state = anyError ? 'detect-failed' : 'not-installed';
  else state = 'not-connected';
  const STATE_LABEL = { 'not-installed': '未安装', 'not-connected': '未接入', connected: '已接入 ✓', manual: '需手动', 'detect-failed': '检测失败', stale: '已写入·需升级为直连', 'needs-confirmation': '需要修复/请确认' };
  const staleReason = needsConfirmation || staleUrl ? (landing.staleReason ?? 'MCP 地址与当前端点不一致，请确认或手动修复') : null;
  const nativeMemory = assistant.nativeMemoryProbe === 'openchamber'
    ? detectOpenChamberNativeMemory(options)
    : null;
  const coexistence = assistant.coexistence
    ? {
        ...assistant.coexistence,
        nativeMemory: nativeMemory
          ? { ...(assistant.coexistence.nativeMemory ?? {}), ...nativeMemory }
          : (assistant.coexistence.nativeMemory ?? null),
        immersive: {
          ...(assistant.coexistence.immersive ?? {}),
          defaultMode: 'tool-only',
          requiresExplicitOptIn: true,
          nativeMemoryActive: nativeMemory?.enabled === true,
        },
      }
    : null;
  return {
    id: assistant.id,
    name: assistant.name,
    kind: assistant.registryKind ?? 'builtin', // builtin | custom（UI 区分来源）
    type: assistant.kind === 'snippet' ? 'snippet' : 'file', // file | snippet（descriptor 形态）
    registryKind: assistant.registryKind ?? 'builtin',
    state,
    stateLabel: needsConfirmation ? '需要修复/请确认' : staleUrl ? '配置已过期 · 请自动修复' : (STATE_LABEL[state] ?? state),
    evidence: signals.map((s) => ({ ...s, detail: redactSecrets(s.detail) })),
    anySignalHit: anyHit,
    landing: {
      primaryPath: assistant.landing?.primaryPath ?? null,
      keyPath: assistant.landing?.keyPath ?? null,
      forbiddenPaths: assistant.landing?.forbiddenPaths ?? [],
      forbiddenBasenames: assistant.landing?.forbiddenBasenames ?? [],
      forbiddenRoots: assistant.landing?.forbiddenRoots ?? [],
      entryDefaults: assistant.landing?.entryDefaults ?? null,
      format: assistant.landing?.format ?? assistant.format,
      strategy,
      present: landing.present,
      legacyShape: landing.legacyShape === true,
      stale: staleUrl || staleStdio,
      staleKind: staleUrl ? 'url' : staleStdio ? 'stdio' : null,
      staleStdio,
      staleUrl,
      needsConfirmation,
      remoteUrl: landing.remoteUrl === true,
      staleReason,
      configuredUrl: landing.configuredUrl ?? null,
      expectedUrl: landing.expectedUrl ?? null,
      exists: landing.exists,
      parseError: landing.parseError === true,
    },
    hasVerify: Boolean(assistant.verify?.cli?.command),
    verify: assistant.verify ?? null,
    activation: assistant.activation ?? { kind: 'user-reload' },
    writer: assistant.writer ?? null,
    risks: assistant.risks ?? [],
    skillsDirs: assistant.skillsDirs ?? [],
    format: assistant.format,
    configPath: assistant.landing?.primaryPath ?? null,
    reuseOf: assistant.reuseOf ?? null,
    note: assistant.note ?? null,
    description: assistant.description ?? null,
    nativeMemory,
    coexistence,
    snippet: snippetFor(assistant.format, entryOptionsFor(assistant, options)),
    mcpUrl: options.mcpUrl ?? null,
    // 陈旧配置诊断（顶层投影，UI/脚本无需深入 landing）
    stale: staleUrl || staleStdio,
    staleKind: staleUrl ? 'url' : staleStdio ? 'stdio' : null,
    staleUrl,
    needsConfirmation,
    remoteUrl: landing.remoteUrl === true,
    staleReason,
    configuredUrl: landing.configuredUrl ?? null,
    expectedUrl: landing.expectedUrl ?? null,
    // 兼容既有 `/admin/api/clients` 字段（只扩展不破坏；UI 亦可继续用）
    installed: signals.some((s) => s.kind !== 'always' && s.hit),
    connected: state === 'connected',
    requiresRestart: (assistant.activation?.kind ?? 'user-reload') === 'user-reload',
    needsManual: state === 'manual',
    parseError: landing.parseError === true ? '配置无法解析（不自动改写）' : null,
    skillsInstalled: (assistant.skillsDirs ?? []).some((d) => existsSync(join(d, 'mebular-memory', 'SKILL.md'))),
  };
}

/** 单条助手状态（**同步**；测试与离线场景用）。 */
export function assistantState(assistant, options = {}) {
  const signals = (assistant.probe?.signals ?? []).map((s) => probeSignal(s, options));
  return buildStateItem(assistant, signals, landingState(assistant, options), options);
}

/** 单条助手状态（**异步**；请求路径用——不阻塞事件循环）。 */
export async function assistantStateAsync(assistant, options = {}) {
  const signals = await Promise.all((assistant.probe?.signals ?? []).map((s) => probeSignalAsync(s, options)));
  return buildStateItem(assistant, signals, landingState(assistant, options), options);
}

// ---------------------------------------------------------------------------
// F-PERF-2：会话内短 TTL 缓存（+ 单飞去重），避免每请求重复 spawn 探针
// ---------------------------------------------------------------------------

/** 默认 TTL（ms）；可用 `MEBULAR_CLIENTS_CACHE_MS` 覆盖（0 = 不缓存）。 */
export const ASSISTANTS_CACHE_TTL_MS = Number(process.env.MEBULAR_CLIENTS_CACHE_MS ?? 1500);

/** CLI 探针结果缓存 TTL（ms）；`MEBULAR_PROBE_CACHE_MS=0` 关闭。 */
export const PROBE_CACHE_TTL_MS = Number(process.env.MEBULAR_PROBE_CACHE_MS ?? 30000);

const cliProbeCache = new Map();

let assistantsCache = { key: null, at: 0, value: null };
let assistantsInflight = { key: null, promise: null };

/** 清空缓存（写操作后调用，避免读到陈旧状态）。 */
export function clearAssistantsCache() {
  assistantsCache = { key: null, at: 0, value: null };
  assistantsInflight = { key: null, promise: null };
  cliProbeCache.clear();
}

async function computeListAssistantsAsync(options) {
  const reg = registry(options);
  const builtinCount = builtinAssistants(options).length;
  const items = await Promise.all(reg.assistants.map(async (a, i) => {
    const registryKind = i < builtinCount ? 'builtin' : 'custom';
    return { ...(await assistantStateAsync(a, options)), registryKind, kind: registryKind };
  }));
  return { assistants: items, customError: reg.customError, customPath: reg.customPath, cached: false };
}

/**
 * 注册表驱动的完整列表（**异步**，请求路径唯一入口）。
 * - TTL 内命中直接返回（`cached:true`）；`refresh:true` 或 `ttlMs:0` 绕过；
 * - 并发请求**单飞**：同一 key 的在途计算被共享（避免并发 10 发 → 10 次 spawn）。
 */
export async function listAssistantsAsync(options = {}) {
  const key = `${assistantUserHome(options)}::${options.home ?? ''}::${options.cwd ?? process.cwd()}::${options.mcpUrl ?? ''}`;
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : ASSISTANTS_CACHE_TTL_MS;
  if (options.refresh !== true) {
    if (ttl > 0 && assistantsCache.key === key && assistantsCache.value && Date.now() - assistantsCache.at < ttl) {
      return { ...assistantsCache.value, cached: true };
    }
    if (assistantsInflight.key === key && assistantsInflight.promise) return assistantsInflight.promise;
  }
  const promise = computeListAssistantsAsync(options)
    .then((value) => {
      assistantsCache = { key, at: Date.now(), value };
      assistantsInflight = { key: null, promise: null };
      return value;
    })
    .catch((error) => {
      assistantsInflight = { key: null, promise: null };
      throw error;
    });
  assistantsInflight = { key, promise };
  return promise;
}

/** 注册表驱动的完整列表（**同步**；测试/离线）。 */
export function listAssistants(options = {}) {
  const reg = registry(options);
  const items = reg.assistants.map((a, i) => {
    const registryKind = i < builtinsCount(reg, options) ? 'builtin' : 'custom';
    return { ...assistantState(a, options), registryKind, kind: registryKind };
  });
  return { assistants: items, customError: reg.customError, customPath: reg.customPath };
}

/** 兼容投影：既有 `/admin/api/clients` 的字段面（只扩展不破坏）。 */
export function detectClients(options = {}) {
  return listAssistants(options).assistants;
}

// ---------------------------------------------------------------------------
// 写入（merge-key / cli-set / manual）：备份 → 写 → 失败回滚
// ---------------------------------------------------------------------------

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf-8');
  await rename(tmp, path);
}

function isForbidden(assistant, path) {
  const landing = assistant.landing ?? {};
  if ((landing.forbiddenPaths ?? []).some((f) => f === path)) return true;
  // App 私有 managed config 的任何副本（如 run/instances/<id>/opencode.managed.json）。
  if ((landing.forbiddenBasenames ?? []).includes(basename(path))) return true;
  const roots = landing.forbiddenRoots ?? [];
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

function computeMerged(assistant, existing, options = {}) {
  if (assistant.format === 'dsh') return mergeDsh(existing, entryOptionsFor(assistant, options));
  const adapter = adapterFor(assistant.landing?.format ?? assistant.format);
  const preserve = adapter?.serialization === 'json';
  return mergeJsonEntry(existing, {
    format: assistant.format,
    entry: mebularEntry(assistant.format, entryOptionsFor(assistant, options)),
    keyPath: keyPathOf(assistant.landing?.format ?? assistant.format),
    preserveEntryFields: preserve,
    preserveFormatting: preserve,
  });
}

export function previewClient(id, options = {}) {
  const assistant = descriptorFor(id, options);
  if (!assistant) return { ok: false, reason: `未知客户端：${id}` };
  const primary = assistant.landing?.primaryPath ?? null;
  if (!primary || assistant.writer?.strategy === 'manual') {
    return { ok: true, needsManual: true, snippet: snippetFor(assistant.format, entryOptionsFor(assistant, options)), preview: '' };
  }
  const existing = safeReadText(primary);
  const merged = computeMerged(assistant, existing, options);
  if (merged.error) return { ok: true, needsManual: true, reason: merged.error, snippet: snippetFor(assistant.format, entryOptionsFor(assistant, options)), preview: '' };
  return { ok: true, changed: merged.changed, preview: lineDiff(existing ?? '', merged.text), configPath: primary };
}

/**
 * cli-set 写入（Hermes）：**一次写入整棵子树** `mcp_servers.mebular`（F-EXP-1 已证结构化字面量可解析）。
 *
 * 真机事故：逐字段 `hermes config set --force mcp_servers.mebular.<field>` 会让 ruamel round-trip
 * 把**新建嵌套映射错位**（块被追加到文件末尾、丢 `mcp_servers:` 键 → 回读 `mcp_servers.mebular`
 * 不存在 = 不生效）。故：一次写入整棵子树 → **回读校验放置**（`hermes config get mcp_servers`）
 * → 放置错/写失败一律**整文件回滚**（字节级备份）。
 *
 * F-PERF-2/F-FIX-B：请求路径一律 `runAsync`（`exec`），**不得 `spawnSync`**（会阻塞事件循环，
 * 让宿主的健康探测超时）。
 */
async function connectViaCli(assistant, options = {}) {
  const runAsync = options.runAsync ?? (options.run
    ? (cmd, t) => Promise.resolve(options.run(cmd, t))   // 注入替身（测试）：同步 run 也可用
    : (cmd, t) => defaultRunAsync(cmd, t ?? 30000, options));
  const primary = assistant.landing.primaryPath;
  const base = assistant.writer.command;
  const entry = mebularEntry(assistant.format, entryOptionsFor(assistant, options));
  // 幂等：已等价 → 不写、不备份
  const before = landingState(assistant, options);
  if (before.present) {
    return { ok: true, changed: false, configPath: primary, backupPath: null, commands: [], preview: '', note: '已接入（幂等：无需改动）' };
  }
  const backupPath = existsSync(primary) ? `${primary}.bak-${tsStamp()}` : null;
  if (backupPath) await copyFile(primary, backupPath);
  const rollback = async () => { if (backupPath) await copyFile(backupPath, primary); clearAssistantsCache(); };
  const commands = [];

  // ① 一次写整棵子树（单次 CLI 调用：4 次逐字段 → 1 次）
  const cmd = `${base} ${JSON.stringify(JSON.stringify(entry))}`;
  const res = await runAsync(cmd, assistant.verify?.cli?.timeoutMs ?? 30000);
  commands.push({ cmd, code: res.code ?? (res.ok ? 0 : 1) });
  if (res.ok !== true) {
    await rollback();
    return { ok: false, changed: false, rolledBack: true, backupPath, commands, reason: '写入失败已回滚', needsManual: true, snippet: snippetFor(assistant.format, entryOptionsFor(assistant, options)) };
  }

  // ② 放置校验：条目必须落在 `mcp_servers` 段内（真机事故即此处失守）
  const readbackCommand = assistant.writer.readbackCommand;
  if (typeof readbackCommand === 'string' && readbackCommand.length > 0) {
    const rb = await runAsync(readbackCommand, 30000);
    commands.push({ cmd: readbackCommand, code: rb.code ?? (rb.ok ? 0 : 1) });
    const placed = /^\s*mebular\s*:/m.test(`${rb.stdout ?? ''}\n${rb.stderr ?? ''}`);
    if (rb.ok !== true || !placed) {
      await rollback();
      return {
        ok: false, changed: false, rolledBack: true, backupPath, commands,
        reason: '写入放置错位（条目不在 mcp_servers 段内）已回滚',
        needsManual: true, snippet: snippetFor(assistant.format, entryOptionsFor(assistant, options)),
      };
    }
  }

  clearAssistantsCache(); // F-PERF-2：写后失效
  return {
    ok: true, changed: true, backupPath, commands, configPath: primary,
    preview: lineDiff(safeReadText(primary) ?? '', snippetFor(assistant.format, entryOptionsFor(assistant, options))),
  };
}

/** 接入成功后顺带 ensure 该客户端的 Skill；失败只记录，绝不阻断 MCP 接入。 */
async function attachSkills(result, id, options = {}) {
  if (!result?.ok || options.skipSkills === true) return result;
  const assistant = descriptorFor(id, options);
  if ((assistant?.skillsDirs ?? []).length === 0) return result;
  try {
    result.skills = await installSkills(id, options);
  } catch (error) {
    result.skills = { ok: false, id, reason: `Skill 安装失败：${redactSecrets(error?.message ?? error)}` };
  }
  return result;
}

/** 接入：merge-key（备份 → 原子写）/ cli-set（官方 CLI）/ manual（仅片段）。 */
export async function connectClient(id, options = {}) {
  const assistant = descriptorFor(id, options);
  if (!assistant) return { ok: false, reason: `未知客户端：${id}` };
  const strategy = assistant.writer?.strategy ?? 'merge-key';
  const primary = assistant.landing?.primaryPath ?? null;
  if (strategy === 'manual' || !primary) {
    return { ok: false, needsManual: true, snippet: snippetFor(assistant.format), reason: '该客户端不支持自动写入：请复制片段' };
  }
  if (isForbidden(assistant, primary)) {
    return { ok: false, reason: `禁写路径（landing.forbiddenPaths）：${primary}` };
  }
  if (strategy === 'cli-set') return attachSkills(await connectViaCli(assistant, options), id, options);
  const existing = safeReadText(primary);
  const merged = computeMerged(assistant, existing, options);
  if (merged.error) {
    return { ok: false, needsManual: true, snippet: snippetFor(assistant.format, entryOptionsFor(assistant, options)), reason: merged.error, configPath: primary };
  }
  const preview = lineDiff(existing ?? '', merged.text);
  if (!merged.changed) {
    return attachSkills({ ok: true, changed: false, configPath: primary, backupPath: null, preview, note: '已接入（幂等：无需改动）' }, id, options);
  }
  const backupPath = existing !== null ? `${primary}.bak-${tsStamp()}` : null;
  if (backupPath) await copyFile(primary, backupPath);
  try {
    await atomicWrite(primary, merged.text);
    clearAssistantsCache(); // F-PERF-2：写后失效
  } catch (error) {
    if (backupPath) await copyFile(backupPath, primary); // 失败回滚
    return { ok: false, changed: false, rolledBack: Boolean(backupPath), backupPath, reason: `写入失败已回滚：${redactSecrets(error?.message ?? error)}` };
  }
  return attachSkills({ ok: true, changed: true, configPath: primary, backupPath, preview }, id, options);
}

/**
 * 自动 reconcile 的 JSON 专用写入：只改 `<keyPath>.url`，保留 mebular 条目里的
 * `type` / `headers` / 其他自定义字段；写前备份、失败回滚、原子写。
 * 结构未知/解析失败 → 返回错误，交回状态检测与手动兜底。
 */
async function reconcileJsonMebularUrl(assistant, mcpUrl) {
  const primary = assistant.landing?.primaryPath ?? null;
  if (!primary) return { ok: false, reason: '缺少配置路径' };
  if (isForbidden(assistant, primary)) return { ok: false, reason: `禁写路径（landing.forbiddenPaths）：${primary}` };
  const text = safeReadText(primary);
  if (text === null) return { ok: false, reason: '配置文件不存在' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `配置不是合法 JSON（${error instanceof Error ? error.message : String(error)}）` };
  }
  const path = keyPathOf(assistant.landing?.format ?? assistant.format);
  const stored = walkGet(parsed, path).value ?? null;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return { ok: false, reason: 'mebular 条目结构未知（不自动改写）' };
  }
  if (stored.url === mcpUrl) return { ok: true, changed: false, configPath: primary, backupPath: null };
  let node = parsed;
  for (const key of path.slice(0, -1)) node = node?.[key];
  if (node === null || typeof node !== 'object') return { ok: false, reason: 'mebular 父级结构未知（不自动改写）' };
  const defaults = assistant.landing?.entryDefaults ?? {};
  // 只补缺失的固定字段（oauth:false / codemode:false），已有字段一律保留。
  node[path[path.length - 1]] = { ...defaults, ...stored, url: mcpUrl };
  const backupPath = `${primary}.bak-${tsStamp()}`;
  await copyFile(primary, backupPath);
  try {
    await atomicWrite(primary, `${JSON.stringify(parsed, null, 2)}\n`);
    clearAssistantsCache();
  } catch (error) {
    await copyFile(backupPath, primary);
    return { ok: false, reason: `写入失败已回滚：${redactSecrets(error?.message ?? error)}` };
  }
  return { ok: true, changed: true, configPath: primary, backupPath };
}

/**
 * 运行时就绪后的**自动自愈**（普通旧端口漂移的主路径）：
 * 只把**已存在且配置为本机 loopback** 的 Mebular HTTP 条目幂等更新到当前 `mcpUrl`。
 *
 * 边界（刻意保守）：
 * - 不创建新客户端配置（`exists !== true` 跳过）；不 force Skill、不调用 installSkills；
 * - 非 loopback / 用户自定义远端 URL 不覆盖（留给状态检测显示“需要修复/请确认”与手动兜底）；
 * - 只改 Mebular 自己的入口，保留其他 MCP servers / 其他配置；JSON 条目只改 url，保留其余字段；
 * - 不触碰 memory / identity / storage / sync / cloud / subscription / task / audit。
 *
 * 单项失败只记录，返回结构化报告；调用方（runtime ready）绝不因此阻断启动。
 */
export async function reconcileClientEndpoints(options = {}) {
  const mcpUrl = typeof options.mcpUrl === 'string' && options.mcpUrl.trim().length > 0 ? options.mcpUrl.trim() : null;
  if (!mcpUrl) {
    return { ok: true, skipped: true, reason: 'no_mcp_url', scope: 'client-endpoint-reconcile', clients: [], summary: { total: 0, changed: 0, failed: 0 } };
  }
  const reg = registry(options);
  const clients = [];
  for (const assistant of reg.assistants) {
    const strategy = assistant.writer?.strategy ?? 'merge-key';
    if (strategy === 'manual' || !assistant.landing?.primaryPath) continue;
    let landing;
    try {
      landing = landingState(assistant, { ...options, mcpUrl });
    } catch (error) {
      clients.push({
        id: assistant.id, name: assistant.name, ok: false, changed: false,
        from: null, to: mcpUrl, reason: `状态探测失败：${redactSecrets(error?.message ?? error)}`,
      });
      continue;
    }
    // 主路径只自动处理 loopback 旧端点；stdio / 远端自定义 / 未接入都不在此处写。
    if (landing.exists !== true || landing.staleUrl !== true) continue;
    try {
      const adapter = adapterFor(assistant.landing?.format ?? assistant.format);
      const result = adapter?.serialization === 'json'
        ? await reconcileJsonMebularUrl(assistant, mcpUrl)
        : await connectClient(assistant.id, { ...options, mcpUrl, skipSkills: true });
      clients.push({
        id: assistant.id,
        name: assistant.name,
        ok: result.ok === true,
        changed: result.changed === true,
        from: landing.configuredUrl ?? null,
        to: mcpUrl,
        ...(result.ok === true ? {} : { reason: redactSecrets(result.reason ?? 'reconcile_failed') }),
      });
    } catch (error) {
      clients.push({
        id: assistant.id, name: assistant.name, ok: false, changed: false,
        from: landing.configuredUrl ?? null, to: mcpUrl,
        reason: redactSecrets(error?.message ?? error),
      });
    }
  }
  const failed = clients.filter((entry) => entry.ok !== true);
  const changed = clients.filter((entry) => entry.changed === true);
  return {
    ok: failed.length === 0,
    scope: 'client-endpoint-reconcile',
    clients,
    summary: { total: clients.length, changed: changed.length, failed: failed.length },
  };
}

/** 回滚：显式备份优先；否则最近一次备份；无备份则删除 mebular 条目（DSH 除外）。 */
/** 备份候选是否已含 mebular 条目——**与状态探针同一判据**（landingState：present ∪ staleStdio ∪ staleUrl ∪ needsConfirmation ∪ legacyShape），
 *  避免自建弱判据（如 yamlHasKey）漏报导致回滚选错快照。 */
function backupHasMebularEntry(assistant, backupPath) {
  const st = landingState({ ...assistant, landing: { ...assistant.landing, primaryPath: backupPath } }, {});
  return Boolean(st.present || st.staleStdio || st.staleUrl || st.needsConfirmation || st.legacyShape);
}

export async function rollbackClient(id, options = {}) {
  clearAssistantsCache(); // F-PERF-2：回滚会改变落面
  const assistant = descriptorFor(id, options);
  if (!assistant || !assistant.landing?.primaryPath) return { ok: false, reason: `未知客户端：${id}` };
  const primary = assistant.landing.primaryPath;
  const existing = safeReadText(primary);
  if (existing === null) return { ok: false, reason: '配置文件不存在，无需回滚' };
  const dir = dirname(primary);
  const base = `${primary.slice(primary.lastIndexOf(sep) + 1)}.bak-`;
  // 备份候选：**新 → 旧**；目标 = 最新一个**不含 mebular 条目**的备份（= 真正的「接入前」快照）
  // 旧实现取「最新备份」：连续连接/多次回滚的安全备份本身已含 mebular → 回滚实为无操作（真机走查事故）
  const candidates = readdirSync(dir).filter((f) => f.startsWith(base)).sort().reverse();
  const target = options.backupPath
    ?? candidates.map((f) => join(dir, f)).find((p) => !backupHasMebularEntry(assistant, p)) ?? null;
  const safety = `${primary}.bak-${tsStamp()}`;
  await copyFile(primary, safety);
  if (target) {
    await atomicWrite(primary, await readFile(target, 'utf-8'));
    clearAssistantsCache();
  return { ok: true, restoredFrom: target, backupPath: safety, removed: false };
  }
  if (assistant.format === 'dsh') return { ok: false, reason: 'DSH 无备份可回滚：请按片段人工移除' };
  const adapter = adapterFor(assistant.landing?.format ?? assistant.format);
  const merged = mergeJsonEntry(existing, {
    format: assistant.format,
    entry: undefined,
    keyPath: keyPathOf(assistant.landing?.format ?? assistant.format),
    preserveFormatting: adapter?.serialization === 'json',
  });
  if (merged.error) return { ok: false, reason: merged.error };
  await atomicWrite(primary, merged.text);
  clearAssistantsCache();
  return { ok: true, restoredFrom: null, backupPath: safety, removed: true };
}

// ---------------------------------------------------------------------------
// 验证闭环（A-9/A-10/A-11）
// ---------------------------------------------------------------------------

/** 回读校验：条目存在 ∧ 原配置其余键无损（有备份时逐键比对）。 */
export function readbackCheck(assistant, options = {}) {
  const landing = landingState(assistant, options);
  if (!landing.exists) return { ok: false, detail: '配置文件不存在' };
  if (!landing.present) {
    if (landing.legacyShape) return { ok: false, detail: '只找到旧形状（不生效），建议重新接入' };
    if (landing.needsConfirmation) return { ok: false, detail: landing.staleReason ?? '自定义远端 MCP 地址与当前端点不一致，请确认或手动修复' };
    if (landing.staleUrl) return { ok: false, detail: landing.staleReason ?? 'MCP 地址已过期，请自动修复' };
    if (landing.staleStdio) return { ok: false, detail: '条目是 stdio 形态：守护运行中会被拒（MCP_STORAGE_LOCKED），建议重新接入为 HTTP /mcp' };
    return { ok: false, detail: '未找到 mebular 条目' };
  }
  const primary = assistant.landing.primaryPath;
  let intact = true;
  try {
    const dir = dirname(primary);
    const base = `${primary.slice(primary.lastIndexOf(sep) + 1)}.bak-`;
    const backups = readdirSync(dir).filter((f) => f.startsWith(base)).sort();
    if (backups.length > 0 && (assistant.landing.format ?? assistant.format) !== 'hermes-yaml') {
      const before = JSON.parse(readFileSync(join(dir, backups[backups.length - 1]), 'utf-8'));
      const after = JSON.parse(landing.text);
      const path = keyPathOf(assistant.landing.format ?? assistant.format);
      const pruneEmpty = (node) => {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
        const out = {};
        for (const [k, v] of Object.entries(node)) {
          const pruned = pruneEmpty(v);
          if (pruned !== null && typeof pruned === 'object' && !Array.isArray(pruned) && Object.keys(pruned).length === 0) continue;
          out[k] = pruned;
        }
        return out;
      };
      const strip = (obj) => {
        const clone = JSON.parse(JSON.stringify(obj));
        let node = clone;
        for (const key of path.slice(0, -1)) { if (node?.[key] === undefined) return clone; node = node[key]; }
        if (node && typeof node === 'object') delete node[path[path.length - 1]];
        return pruneEmpty(clone);
      };
      intact = JSON.stringify(strip(before)) === JSON.stringify(strip(after));
    }
  } catch {
    intact = false;
  }
  return { ok: intact, detail: intact ? 'mebular 条目已写入，其余键无损' : '其余键与备份不一致' };
}

/** 解析 `verify.cli` 输出：expect 命中 ∧（可选）toolsPattern 的 N ≥ minTools。 */
export function parseVerifyOutput(verifyCli, output) {
  const text = String(output ?? '');
  const expect = verifyCli?.expect;
  const expectHit = typeof expect === 'string' ? text.includes(expect) : true;
  let tools = null;
  if (typeof verifyCli?.toolsPattern === 'string') {
    const m = new RegExp(verifyCli.toolsPattern).exec(text);
    tools = m ? Number(m[1]) : null;
  }
  const minTools = Number.isFinite(verifyCli?.minTools) ? verifyCli.minTools : null;
  const toolsOk = minTools === null ? true : (tools ?? -1) >= minTools;
  return { ok: expectHit && toolsOk, expectHit, tools, toolsOk };
}

/**
 * 验证：① 回读（必有）→ ② CLI（有 verify.cli 则必跑）→ 终结态。
 * `userConfirmedReload` 由 UI 的「我已重载，重新验证」按钮传入（A-10）。
 */
export async function verifyAssistant(id, options = {}) {
  const assistant = descriptorFor(id, options);
  if (!assistant) return { ok: false, reason: `未知客户端：${id}` };
  const steps = [];
  const readback = readbackCheck(assistant, options);
  steps.push({ name: 'readback', label: '回读校验', ok: readback.ok, detail: redactSecrets(readback.detail) });
  let cliResult = null;
  const cli = assistant.verify?.cli;
  if (cli?.command) {
    const runAsync = options.runAsync ?? (options.run
      ? (cmd, t) => Promise.resolve(options.run(cmd, t))
      : (cmd, t) => defaultRunAsync(cmd, t ?? cli.timeoutMs ?? 5000, options));
    const res = await runAsync(cli.command, cli.timeoutMs ?? 5000);
    const parsed = parseVerifyOutput(cli, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
    const ok = res.ok === true && parsed.ok;
    cliResult = { code: res.code ?? (res.ok ? 0 : 1), parsed, output: redactSecrets(`${res.stdout ?? ''}${res.stderr ?? ''}`).slice(-800) };
    steps.push({ name: 'cli', label: 'CLI 验证', ok, detail: ok ? `命中 ${cli.expect ?? ''}`.trim() : `未通过（rc=${cliResult.code}${parsed.tools !== null ? `, tools=${parsed.tools}` : ''}）`, output: cliResult.output });
  }
  const allOk = steps.every((s) => s.ok);
  const hot = (assistant.activation?.kind ?? 'user-reload') === 'hot';
  let state;
  if (!allOk) state = 'verify-failed';
  else if (hot || options.userConfirmedReload === true) state = 'connected';
  else state = 'pending-restart';
  const STATE_LABEL = { connected: '已接入 ✓', 'pending-restart': '待生效', 'verify-failed': '验证未过' };
  return {
    ok: allOk,
    id, state, stateLabel: STATE_LABEL[state] ?? state,
    steps,
    activation: assistant.activation,
    needsUserReload: state === 'pending-restart',
    backupHint: options.backupPath ?? null,
  };
}

// ---------------------------------------------------------------------------
// Skill 安装（单一实现：缺失安装 / 受管旧版更新 / 用户修改保留 / force 覆盖）
// ---------------------------------------------------------------------------

/**
 * 受管版本标记：每个 Skill 目录一份 `.mebular-skill.json`。
 *
 * - 有标记 ∧ `managedBy=mebular` ∧ 文件哈希与标记一致 → Mebular 管理且用户未改；
 * - 无标记 / 哈希不一致 → 用户自定义或用户改过 → 默认保留；
 * - `force`（自动修复）→ 完整覆盖已知 Skill 文件（不删除用户额外文件）。
 *
 * `files` 记录 **Mebular 写入的受管文件**哈希（含 `mcp/` 片段），因此「受管旧版」既能按版本号识别，
 * 也能识别同版本但内容漂移的安装；用户额外添加的文件不参与判定，也不会被删除。
 */
export const SKILL_MANIFEST_FILE = '.mebular-skill.json';
const SKILL_MANIFEST_SCHEMA = 1;
const SKILL_SPECS = [
  {
    name: 'mebular-memory',
    files: [
      ['SKILL.md', 'SKILL.md'],
      ['MEMORY_POLICY.md', 'MEMORY_POLICY.md'],
      ['SETUP.md', 'SETUP.md'],
    ],
    copyDirs: [['mcp', 'mcp']],
  },
  {
    name: 'mebular-tasks',
    files: [
      ['tasks/SKILL.md', 'SKILL.md'],
      ['SETUP.md', 'SETUP.md'],
    ],
    copyDirs: [],
  },
];

function moduleSkillRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill');
}

function skillRootCandidates(options = {}) {
  return [
    options.skillRoot,
    moduleSkillRoot(),
    join(options.repoRoot ?? process.cwd(), 'packages', 'skill'),
  ].filter((p) => typeof p === 'string' && p.length > 0);
}

function resolveSkillRoot(options = {}) {
  return skillRootCandidates(options).find((p) => existsSync(join(p, 'SKILL.md'))) ?? null;
}

function skillSourceVersion(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // 独立/测试 Skill 源可以没有 package.json：回落到 MCP 对外版本。
  }
  return APP_VERSION;
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function listRelativeFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === SKILL_MANIFEST_FILE || entry.name === '.DS_Store') continue;
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

function hashSkillDir(dir) {
  const out = {};
  for (const rel of listRelativeFiles(dir)) {
    out[rel] = sha256Buffer(readFileSync(join(dir, ...rel.split('/'))));
  }
  return out;
}

/**
 * 受管文件相对路径校验（POSIX / Windows 共用）：
 * 拒绝绝对路径、盘符、反斜杠分隔、空段、`.`/`..` 段与非字符串。
 * 只用于 `marker.files` 的清理；不安全的 key 直接跳过，绝不触碰 Skill 目录外。
 */
export function isSafeManagedRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0') || rel.includes('\\')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function readSkillMarker(dir) {
  try {
    const data = JSON.parse(readFileSync(join(dir, SKILL_MANIFEST_FILE), 'utf-8'));
    if (data?.schema !== SKILL_MANIFEST_SCHEMA || data?.managedBy !== 'mebular') return null;
    if (data.files === null || typeof data.files !== 'object' || Array.isArray(data.files)) return null;
    const files = {};
    for (const [key, value] of Object.entries(data.files)) {
      if (typeof value === 'string') files[key] = value;
    }
    return { ...data, files };
  } catch {
    return null;
  }
}

function skillSourcePairs(rootDir, spec) {
  const pairs = [];
  for (const [src, rel] of spec.files) {
    const abs = join(rootDir, ...src.split('/'));
    if (!existsSync(abs)) throw new Error(`Skill 源缺少 ${src}`);
    pairs.push([abs, rel]);
  }
  for (const [srcDir, relDir] of spec.copyDirs ?? []) {
    const absDir = join(rootDir, srcDir);
    if (!existsSync(absDir)) throw new Error(`Skill 源缺少 ${srcDir}/（Skill 承诺随包安装接入片段）`);
    for (const rel of listRelativeFiles(absDir)) {
      pairs.push([join(absDir, ...rel.split('/')), `${relDir}/${rel}`]);
    }
  }
  return pairs;
}

function hashesForPairs(pairs) {
  return Object.fromEntries(pairs.map(([abs, rel]) => [rel, sha256Buffer(readFileSync(abs))]));
}

async function writeSkillFiles(dir, pairs, marker, { version, source, skill, managedHashes }) {
  for (const [abs, rel] of pairs) {
    const dest = join(dir, ...rel.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(abs, dest);
  }
  // 受管旧版的多余文件（例如上一版有、这一版已移除）只按旧标记清理；绝不扫描/删除用户文件。
  if (marker) {
    const keep = new Set(pairs.map(([, rel]) => rel));
    for (const rel of Object.keys(marker.files ?? {})) {
      if (keep.has(rel) || !isSafeManagedRelPath(rel)) continue;
      await rm(join(dir, ...rel.split('/')), { force: true });
    }
  }
  const files = managedHashes ?? hashesForPairs(pairs);
  await writeFile(join(dir, SKILL_MANIFEST_FILE), `${JSON.stringify({
    schema: SKILL_MANIFEST_SCHEMA,
    managedBy: 'mebular',
    skill,
    version,
    installedAt: new Date().toISOString(),
    source,
    files,
  }, null, 2)}\n`, 'utf-8');
  return files;
}

async function installSkillSpec(rootDir, targetDir, spec, { force = false, version, source } = {}) {
  const dir = join(targetDir, spec.name);
  const existed = existsSync(join(dir, 'SKILL.md'));
  const marker = existed ? readSkillMarker(dir) : null;
  const currentHashes = existed ? hashSkillDir(dir) : {};
  const pairs = skillSourcePairs(rootDir, spec);
  const sourceHashes = hashesForPairs(pairs);

  if (existed && force !== true) {
    if (!marker) return { name: spec.name, status: 'kept', dir, reason: '无受管标记（用户自定义），未覆盖' };
    // 只比较标记登记的受管文件；用户额外添加的文件不阻止更新，也不会被删除。
    const managedUnchanged = Object.entries(marker.files).every(([rel, hash]) => currentHashes[rel] === hash);
    if (!managedUnchanged) {
      return { name: spec.name, status: 'kept', dir, reason: '文件与受管标记不一致（用户修改过），未覆盖' };
    }
    const sourceCurrent = Object.entries(sourceHashes).every(([rel, hash]) => marker.files[rel] === hash);
    if (marker.version === version && sourceCurrent) {
      return { name: spec.name, status: 'unchanged', dir, version };
    }
  }

  await writeSkillFiles(dir, pairs, marker, { version, source, skill: spec.name, managedHashes: sourceHashes });
  return { name: spec.name, status: existed ? 'updated' : 'installed', dir, version };
}

function summarizeSkillResults(targetDir, results, { version, source } = {}) {
  const failed = results.filter((r) => r.status === 'failed');
  const by = (status) => results.filter((r) => r.status === status).map((r) => r.dir);
  let status = 'unchanged';
  if (failed.length > 0) status = 'failed';
  else if (results.some((r) => r.status === 'installed')) status = 'installed';
  else if (results.some((r) => r.status === 'updated')) status = 'updated';
  else if (results.some((r) => r.status === 'kept')) status = 'kept';
  return {
    ok: failed.length === 0,
    status,
    targetDir,
    version: version ?? null,
    source: source ?? null,
    installed: by('installed'),
    updated: by('updated'),
    kept: by('kept'),
    unchanged: by('unchanged'),
    skills: results,
    ...(failed.length > 0 ? { reason: failed.map((r) => `${r.name}: ${r.reason ?? '安装失败'}`).join('；') } : {}),
  };
}

/** 安装到指定目录（install.mjs / 显式安装共用；默认保留用户修改，force 覆盖）。 */
export async function installSkillsToDir(targetDir, options = {}) {
  if (typeof targetDir !== 'string' || targetDir.length === 0) {
    return { ok: false, reason: '缺少 Skill 目标目录', skills: [], installed: [], updated: [], kept: [], unchanged: [] };
  }
  const rootDir = resolveSkillRoot(options);
  if (!rootDir) {
    return {
      ok: false,
      reason: `未找到 Skill 源（试过：${skillRootCandidates(options).join('、')}）`,
      targetDir,
      skills: [],
      installed: [],
      updated: [],
      kept: [],
      unchanged: [],
    };
  }
  const version = skillSourceVersion(rootDir);
  const source = 'mebular';
  const results = [];
  for (const spec of SKILL_SPECS) {
    try {
      results.push(await installSkillSpec(rootDir, targetDir, spec, { force: options.force === true, version, source }));
    } catch (error) {
      results.push({ name: spec.name, status: 'failed', dir: join(targetDir, spec.name), reason: redactSecrets(error?.message ?? error) });
    }
  }
  return summarizeSkillResults(targetDir, results, { version, source });
}

function preferredSkillTarget(dirs) {
  // 与既有 installSkills 行为一致：descriptor 的首个目录 = 客户端全局 Skill 目录。
  // 不优先挑“已存在的 cwd 目录”，否则 cwd=仓库时会误把 Skill 写进项目。
  return dirs[0];
}

/**
 * 安装 mebular-memory + mebular-tasks 到该客户端首个已知 Skill 目录。
 * 默认语义 = ensure：缺失安装、受管旧版更新、用户修改/无标记保留；`force:true` 完整覆盖。
 */
export async function installSkills(id, options = {}) {
  const desc = descriptorFor(id, options);
  if (!desc) return { ok: false, id, reason: `未知客户端：${id}`, skills: [], installed: [], updated: [], kept: [], unchanged: [] };
  const dirs = (desc.skillsDirs ?? []).filter(Boolean);
  if (dirs.length === 0) return { ok: false, id, reason: '该客户端没有已知的 Skill 目录', skills: [], installed: [], updated: [], kept: [], unchanged: [] };
  const target = options.skillDir ?? preferredSkillTarget(dirs);
  const result = await installSkillsToDir(target, options);
  return { ...result, id };
}

function skillStateDetected(state) {
  return Boolean(state?.anySignalHit || state?.installed);
}

/**
 * 对所有**已检测到的客户端**做 Skill ensure（单一实现）。
 *
 * - 目录只来自 descriptor 的 `skillsDirs`；未检测到的客户端不创建任何目录；
 * - 同一 Skill 目录被多个客户端共享时只处理一次（OpenCode / OpenChamber）；
 * - 单个 Skill/客户端失败只记录，不抛出。
 */
export async function ensureSkills(options = {}) {
  const wanted = Array.isArray(options.clientIds) ? new Set(options.clientIds) : null;
  const reg = registry(options);
  const clients = [];
  const seenTargets = new Map();
  for (const assistant of reg.assistants) {
    if (wanted && !wanted.has(assistant.id)) continue;
    const dirs = (assistant.skillsDirs ?? []).filter(Boolean);
    if (dirs.length === 0) {
      clients.push({ id: assistant.id, name: assistant.name, detected: false, status: 'skipped', reason: '该客户端没有已知的 Skill 目录' });
      continue;
    }
    let state;
    try {
      state = await assistantStateAsync(assistant, options);
    } catch (error) {
      clients.push({ id: assistant.id, name: assistant.name, detected: false, status: 'failed', reason: `检测失败：${redactSecrets(error?.message ?? error)}` });
      continue;
    }
    if (!skillStateDetected(state)) {
      clients.push({ id: assistant.id, name: assistant.name, detected: false, status: 'skipped', reason: '未检测到该客户端' });
      continue;
    }
    const target = preferredSkillTarget(dirs);
    if (seenTargets.has(target)) {
      clients.push({
        id: assistant.id, name: assistant.name, detected: true, status: 'skipped',
        targetDir: target, reason: `与 ${seenTargets.get(target)} 共享 Skill 目录，已由前者处理`,
      });
      continue;
    }
    seenTargets.set(target, assistant.id);
    try {
      const result = await installSkills(assistant.id, options);
      clients.push({ ...result, name: assistant.name, detected: true });
    } catch (error) {
      clients.push({
        id: assistant.id, name: assistant.name, detected: true, status: 'failed',
        targetDir: target, reason: redactSecrets(error?.message ?? error), skills: [],
        installed: [], updated: [], kept: [], unchanged: [],
      });
    }
  }
  const failed = clients.filter((c) => c.status === 'failed');
  return {
    ok: failed.length === 0,
    clients,
    summary: {
      total: clients.length,
      installed: clients.filter((c) => c.status === 'installed').length,
      updated: clients.filter((c) => c.status === 'updated').length,
      kept: clients.filter((c) => c.status === 'kept').length,
      unchanged: clients.filter((c) => c.status === 'unchanged').length,
      skipped: clients.filter((c) => c.status === 'skipped').length,
      failed: failed.length,
    },
  };
}

/**
 * 启动/初始化收敛入口（**永不阻断**调用方）：
 * 测试环境默认关闭，避免验证脚本写真实 `~/.config/opencode/skills`；
 * 需要显式验证自动接线时设置 `MEBULAR_SKILL_AUTOWIRE=1`。
 */
export async function autoEnsureSkills(options = {}) {
  const forcedOn = process.env.MEBULAR_SKILL_AUTOWIRE === '1';
  // 安全网：临时 MEBULAR home + 真实用户主目录 = 验证脚本形态，绝不写真实 Skill 目录。
  const tempHomeWithRealUser = typeof options.home === 'string'
    && options.home.startsWith(tmpdir())
    && typeof options.userHome === 'string'
    && !options.userHome.startsWith(tmpdir());
  const disabled = options.enabled === false
    || (!forcedOn && (process.env.MEBULAR_SKILL_AUTOWIRE === '0'
      || process.env.JEST_WORKER_ID !== undefined
      || process.env.NODE_ENV === 'test'
      || tempHomeWithRealUser));
  if (disabled) {
    return { ok: true, skipped: true, reason: 'skill auto-wire disabled', clients: [], summary: { total: 0, installed: 0, updated: 0, kept: 0, unchanged: 0, skipped: 0, failed: 0 } };
  }
  try {
    return await ensureSkills(options);
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: `Skill 自动安装失败：${redactSecrets(error?.message ?? error)}`,
      clients: [],
      summary: { total: 0, installed: 0, updated: 0, kept: 0, unchanged: 0, skipped: 0, failed: 1 },
    };
  }
}

/**
 * 自动修复（只做客户端接入）：
 * 对**已检测到的**助手逐个重新执行 MCP 接入（connectClient）+ Skill force 安装 + 验证。
 * 不触碰 memory / identity / cloud / task / audit；单项失败不影响其他项。
 */
export async function repairClients(options = {}) {
  const list = await listAssistantsAsync({ ...options, refresh: true });
  const candidates = list.assistants.filter((assistant) => skillStateDetected(assistant));
  const clients = [];
  const seenSkillTargets = new Map();
  for (const assistant of candidates) {
    const base = {
      id: assistant.id,
      name: assistant.name,
      detected: true,
      stateBefore: assistant.state ?? null,
      connect: null,
      skills: null,
      verify: null,
      stateAfter: null,
    };
    if (assistant.writer?.strategy === 'manual' || !assistant.landing?.primaryPath) {
      clients.push({ ...base, connect: { ok: false, skipped: true, reason: '该客户端不支持自动写入：只提供片段' }, skills: { ok: true, skipped: true, reason: '无自动接入目录' } });
      continue;
    }
    try {
      base.connect = await connectClient(assistant.id, { ...options, skipSkills: true });
    } catch (error) {
      base.connect = { ok: false, reason: `接入失败：${redactSecrets(error?.message ?? error)}` };
    }
    const skillDirs = (assistant.skillsDirs ?? []).filter(Boolean);
    if (skillDirs.length > 0) {
      // 与 ensureSkills 同判据：共享全局目录（OpenChamber / OpenCode）只 force 安装一次。
      const target = preferredSkillTarget(skillDirs);
      const shared = seenSkillTargets.get(target);
      if (shared) {
        // 共享目录（OpenChamber / OpenCode）复用首次安装结果，但明确标注 skipped；实际只写一次。
        base.skills = {
          ...(shared.result ?? {}),
          id: assistant.id,
          ok: shared.result?.ok ?? true,
          skipped: true,
          targetDir: target,
          sharedWith: shared.id,
          reason: `与 ${shared.id} 共享 Skill 目录，已由前者处理`,
        };
      } else {
        seenSkillTargets.set(target, { id: assistant.id, result: null });
        try {
          const result = await installSkills(assistant.id, { ...options, force: true });
          seenSkillTargets.set(target, { id: assistant.id, result });
          base.skills = result;
        } catch (error) {
          const failure = { ok: false, targetDir: target, reason: `Skill 安装失败：${redactSecrets(error?.message ?? error)}` };
          seenSkillTargets.set(target, { id: assistant.id, result: failure });
          base.skills = failure;
        }
      }
    } else {
      base.skills = { ok: true, skipped: true, reason: '该客户端没有已知的 Skill 目录' };
    }
    try {
      base.verify = await verifyAssistant(assistant.id, options);
      base.stateAfter = base.verify?.state ?? null;
    } catch (error) {
      base.verify = { ok: false, reason: `验证失败：${redactSecrets(error?.message ?? error)}` };
    }
    clients.push(base);
  }
  const failed = clients.filter((entry) => (entry.connect?.ok === false && entry.connect?.skipped !== true)
    || entry.skills?.ok === false);
  const repaired = clients.filter((entry) => entry.connect?.ok === true && entry.connect?.skipped !== true);
  return {
    ok: failed.length === 0,
    scope: 'client-integration',
    repairedAt: new Date().toISOString(),
    clients,
    summary: {
      total: clients.length,
      repaired: repaired.length,
      failed: failed.length,
      skipped: clients.filter((entry) => entry.connect?.skipped === true).length,
    },
  };
}
