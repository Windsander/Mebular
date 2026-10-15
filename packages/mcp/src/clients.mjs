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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { exec, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return entryForShape(shapeFor(format, options), options.url) ?? { command: 'mebular', args: ['mcp'] };
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

  return [
    {
      id: 'openchamber', name: 'OpenChamber', kind: 'file', format: 'opencode-json',
      landing: {
        primaryPath: opencodePath,
        keyPath: 'mcp.servers.mebular',
        forbiddenPaths: [join(userHome, '.config', 'openchamber', 'opencode.managed.json')],
        format: 'opencode-json',
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
        'opencode.managed.json 为 App 所有且会被重写，禁写',
        'opencode mcp list 经运行服务回答，只读但勿频繁调用',
      ],
      skillsDirs: [join(userHome, '.config', 'opencode', 'skills')],
      reuseOf: 'opencode',
      note: 'OpenChamber 复用 OpenCode 的 global 配置（接一次即可）',
    },
    {
      id: 'hermes', name: 'Hermes', kind: 'file', format: 'hermes-yaml',
      landing: { primaryPath: hermesPath, keyPath: 'mcp_servers.mebular', forbiddenPaths: [], format: 'hermes-yaml' },
      probe: {
        signals: [
          { kind: 'config-path', paths: [hermesPath] },
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
      skillsDirs: [join(userHome, '.agents', 'skills')],
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
      skillsDirs: [join(userHome, '.config', 'opencode', 'skills'), join(userHome, '.agents', 'skills'), join(cwd, '.agents', 'skills'), join(cwd, '.opencode', 'skills')],
      reuseOf: null,
      note: null,
    },
    {
      id: 'claude-code', name: 'Claude Code', kind: 'file', format: 'json-mcpServers',
      landing: { primaryPath: join(userHome, '.claude.json'), keyPath: 'mcpServers.mebular', forbiddenPaths: [], format: 'json-mcpServers', httpShape: 'claude-http' },
      probe: { signals: [{ kind: 'config-path', paths: [join(userHome, '.claude.json')] }, { kind: 'cli', command: 'claude --version', timeoutMs: 1500 }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true },
      activation: { kind: 'user-reload', note: '重启 Claude Code 后生效' },
      risks: [],
      skillsDirs: [join(userHome, '.agents', 'skills'), join(cwd, '.agents', 'skills')],
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
      risks: ['HTTP /mcp 默认只监听回环：客户端与守护须**同机**（跨机请在 config 里启用 TLS+鉴权并用可达主机名）'], skillsDirs: [], reuseOf: null, note: null,
    },
    {
      id: 'dsh', name: 'DeepSeek Harness (DSH)', kind: 'file', format: 'dsh',
      landing: { primaryPath: join(cwd, '.dsh', 'cordis.yml'), keyPath: 'plugins', forbiddenPaths: [], format: 'dsh' },
      probe: { signals: [{ kind: 'config-path', paths: [join(cwd, '.dsh', 'cordis.yml')] }, { kind: 'dir', paths: [join(cwd, '.dsh')] }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true },
      activation: { kind: 'user-reload', note: '重启 DSH 后生效' },
      risks: ['DSH 配置为 YAML 插件列表：结构未知时不自动改写', 'HTTP /mcp 默认只监听回环：客户端与守护须同机（跨机请启用 TLS+鉴权并用可达主机名）'],
      skillsDirs: [join(cwd, '.dsh', 'skills'), join(userHome, '.agents', 'skills')], reuseOf: null, note: null,
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

/**
 * JSON 合并：设置或删除 `<keyPath>`（默认含叶子 `mebular`），保留其余键。
 * 中间键存在但非对象 → error（结构未知，不自动改写）。
 */
export function mergeJsonEntry(existingText, { format, entry, keyPath } = {}) {
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
  const changed = JSON.stringify(cursor[leaf] ?? null) !== JSON.stringify(entry ?? null);
  if (entry === undefined) delete cursor[leaf];
  else cursor[leaf] = entry;
  return { changed, next, text: `${JSON.stringify(next, null, 2)}\n` };
}

/** DSH(YAML) 合并：空文件 → 写片段；已含 serverName: mebular → 幂等；结构未知 → 不写。 */
export function mergeDsh(existingText, options = {}) {
  const snippet = snippetFor('dsh', options);
  if (existingText === null || existingText.trim() === '') return { changed: true, text: `${snippet}\n` };
  if (/serverName:\s*['"]?mebular['"]?/.test(existingText)) {
    // 已接入：仅当**形态等价**（HTTP vs stdio）才算幂等，否则需改写
    const wantHttp = Boolean(options.url);
    const hasHttp = /transport:\s*streamable-http/.test(existingText);
    if (wantHttp === hasHttp) return { changed: false, text: existingText };
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
    if (/^\S/.test(line)) inParent = false; // 回到顶层
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
    if (new RegExp(`^${parent}\s*:`).test(line)) { inParent = true; continue; }
    if (!inParent) continue;
    if (/^\S/.test(line)) { inParent = false; block = null; continue; }
    if (new RegExp(`^\\s{1,6}${child}\\s*:`).test(line)) { block = [line]; continue; }
    if (block !== null) {
      if (/^\s*\S/.test(line)) block.push(line);
      else break;
    }
  }
  return block === null ? null : block.join('\n');
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
    const has = /serverName:\s*['"]?mebular['"]?/.test(text);
    const present = has && /transport:\s*streamable-http/.test(text);
    return { exists: true, present, legacyShape: false, staleStdio: has && /transport:\s*stdio/.test(text) && !present, text };
  }
  if (adapter?.serialization === 'yaml') {
    const path = keyPathOf(format);
    const block = yamlEntryBlock(text, path[0], path[1]);
    const hasUrl = block !== null && /^\s*url\s*:\s*\S+/m.test(block);
    const hasCommand = block !== null && /^\s*command\s*:\s*\S+/m.test(block);
    // 语义判据：remote（有 url）→ present；stdio（有 command 无 url）→ stale；旧「逐字段错位追加」也归 stale
    const present = hasUrl && !hasCommand;
    return { exists: true, present, legacyShape: false, staleStdio: !present && hasCommand, text };
  }
  try {
    const parsed = JSON.parse(text);
    const path = keyPathOf(format);
    const stored = walkGet(parsed, path).value ?? null;
    const legacy = adapter?.legacyKeyPath
      ? walkGet(parsed, adapter.legacyKeyPath).value !== undefined
      : false;
    // 语义判据（兼容迁移）：remote/http 形态 → present；stdio 形态或**端口与当前守护端点不符** → stale
    const isHttp = entryIsHttp(format, stored);
    const storedUrl = typeof stored?.url === 'string' ? stored.url : null;
    const urlOk = options.mcpUrl === undefined || options.mcpUrl === null || storedUrl === options.mcpUrl;
    const present = isHttp && urlOk;
    const staleStdio = !present && (entryIsStdio(format, stored) || (isHttp && !urlOk));
    return { exists: true, present, legacyShape: legacy && !present, staleStdio, text };
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
  return { ...(url ? { url } : {}), ...(httpShape ? { httpShape } : {}) };
}

function buildStateItem(assistant, signals, landing, options = {}) {
  const anyHit = signals.some((s) => s.hit);
  const anyError = signals.some((s) => typeof s.detail === 'string' && s.detail.startsWith('探测异常'));
  const strategy = assistant.writer?.strategy ?? 'merge-key';
  let state;
  if (strategy === 'manual' && !landing.present) state = anyHit ? 'manual' : 'not-installed';
  else if (landing.present) state = 'connected';
  else if (landing.staleStdio) state = 'stale';   // 已写入但过时（stdio）→ 升级直连
  else if (!anyHit) state = anyError ? 'detect-failed' : 'not-installed';
  else state = 'not-connected';
  const STATE_LABEL = { 'not-installed': '未安装', 'not-connected': '未接入', connected: '已接入 ✓', manual: '需手动', 'detect-failed': '检测失败', stale: '已写入·需升级为直连' };
  return {
    id: assistant.id,
    name: assistant.name,
    kind: assistant.registryKind ?? 'builtin', // builtin | custom（UI 区分来源）
    type: assistant.kind === 'snippet' ? 'snippet' : 'file', // file | snippet（descriptor 形态）
    registryKind: assistant.registryKind ?? 'builtin',
    state,
    stateLabel: STATE_LABEL[state] ?? state,
    evidence: signals.map((s) => ({ ...s, detail: redactSecrets(s.detail) })),
    anySignalHit: anyHit,
    landing: {
      primaryPath: assistant.landing?.primaryPath ?? null,
      keyPath: assistant.landing?.keyPath ?? null,
      forbiddenPaths: assistant.landing?.forbiddenPaths ?? [],
      format: assistant.landing?.format ?? assistant.format,
      strategy,
      present: landing.present,
      legacyShape: landing.legacyShape === true,
      staleStdio: landing.staleStdio === true,
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
    snippet: snippetFor(assistant.format, entryOptionsFor(assistant, options)),
    mcpUrl: options.mcpUrl ?? null,
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
  const forbidden = assistant.landing?.forbiddenPaths ?? [];
  return forbidden.some((f) => f === path);
}

function computeMerged(assistant, existing, options = {}) {
  if (assistant.format === 'dsh') return mergeDsh(existing, entryOptionsFor(assistant, options));
  return mergeJsonEntry(existing, {
    format: assistant.format,
    entry: mebularEntry(assistant.format, entryOptionsFor(assistant, options)),
    keyPath: keyPathOf(assistant.landing?.format ?? assistant.format),
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
  if (strategy === 'cli-set') return connectViaCli(assistant, options);
  const existing = safeReadText(primary);
  const merged = computeMerged(assistant, existing, options);
  if (merged.error) {
    return { ok: false, needsManual: true, snippet: snippetFor(assistant.format, entryOptionsFor(assistant, options)), reason: merged.error, configPath: primary };
  }
  const preview = lineDiff(existing ?? '', merged.text);
  if (!merged.changed) {
    return { ok: true, changed: false, configPath: primary, backupPath: null, preview, note: '已接入（幂等：无需改动）' };
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
  return { ok: true, changed: true, configPath: primary, backupPath, preview };
}

/** 回滚：显式备份优先；否则最近一次备份；无备份则删除 mebular 条目（DSH 除外）。 */
export async function rollbackClient(id, options = {}) {
  clearAssistantsCache(); // F-PERF-2：回滚会改变落面
  const assistant = descriptorFor(id, options);
  if (!assistant || !assistant.landing?.primaryPath) return { ok: false, reason: `未知客户端：${id}` };
  const primary = assistant.landing.primaryPath;
  const existing = safeReadText(primary);
  if (existing === null) return { ok: false, reason: '配置文件不存在，无需回滚' };
  const dir = dirname(primary);
  const base = `${primary.slice(primary.lastIndexOf(sep) + 1)}.bak-`;
  const candidates = readdirSync(dir).filter((f) => f.startsWith(base)).sort();
  const target = options.backupPath ?? (candidates.length > 0 ? join(dir, candidates[candidates.length - 1]) : null);
  const safety = `${primary}.bak-${tsStamp()}`;
  await copyFile(primary, safety);
  if (target) {
    await atomicWrite(primary, await readFile(target, 'utf-8'));
    clearAssistantsCache();
  return { ok: true, restoredFrom: target, backupPath: safety, removed: false };
  }
  if (assistant.format === 'dsh') return { ok: false, reason: 'DSH 无备份可回滚：请按片段人工移除' };
  const merged = mergeJsonEntry(existing, { format: assistant.format, entry: undefined, keyPath: keyPathOf(assistant.landing?.format ?? assistant.format) });
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
// Skill 安装
// ---------------------------------------------------------------------------

function moduleSkillRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill');
}

/** 安装 mebular-memory + mebular-tasks 到该客户端首个已知 Skill 目录。 */
export async function installSkills(id, options = {}) {
  const desc = descriptorFor(id, options);
  if (!desc) return { ok: false, reason: `未知客户端：${id}` };
  const dirs = (desc.skillsDirs ?? []).filter(Boolean);
  if (dirs.length === 0) return { ok: false, reason: '该客户端没有已知的 Skill 目录' };
  const candidates = [
    options.skillRoot,
    moduleSkillRoot(),
    join(options.repoRoot ?? process.cwd(), 'packages', 'skill'),
  ].filter((p) => typeof p === 'string' && p.length > 0);
  const rootDir = candidates.find((p) => existsSync(join(p, 'SKILL.md')));
  if (!rootDir) {
    return { ok: false, reason: `未找到 Skill 源（试过：${candidates.join('、')}）`, snippet: '请在仓库内运行，或手动复制 Skill 目录' };
  }
  const target = dirs[0];
  const mem = join(target, 'mebular-memory');
  const tasks = join(target, 'mebular-tasks');
  await mkdir(mem, { recursive: true });
  await mkdir(tasks, { recursive: true });
  await copyFile(join(rootDir, 'SKILL.md'), join(mem, 'SKILL.md'));
  await copyFile(join(rootDir, 'MEMORY_POLICY.md'), join(mem, 'MEMORY_POLICY.md'));
  await copyFile(join(rootDir, 'SETUP.md'), join(mem, 'SETUP.md'));
  await copyFile(join(rootDir, 'tasks', 'SKILL.md'), join(tasks, 'SKILL.md'));
  await copyFile(join(rootDir, 'SETUP.md'), join(tasks, 'SETUP.md'));
  return { ok: true, installed: [mem, tasks] };
}
