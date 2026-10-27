#!/usr/bin/env node
/**
 * Real DSH E2E: P0 failure/recovery + P1 managed/Agent matrix (Phase 4).
 *
 * Preserves the Phase 1 happy path and Phase 2 failure/recovery scenarios on
 * top of reusable world primitives (scripts/lib/dsh-e2e-world.mjs):
 *
 *   happy-path             sidebar / connected / iframe / Console / real tool call
 *   managed-lifecycle      no daemon -> plugin starts its own child; stopping
 *                          DSH stops only that child
 *   managed-reuse          managed profile reuses an external daemon; stopping
 *                          DSH leaves that daemon alive
 *   managed-cli-missing    no CLI/runtime -> down + download_required + install guide + Agent hint
 *   daemon-down-recovery   down at boot -> up -> down -> up, without restarting DSH;
 *                          down shows the offline panel (not the install guide)
 *   panel-false            separate profile, no sidebar/iframe, MCP tools still work
 *   custom-port            MEBULAR_HTTP_PORT wins over a conflicting runtime.json;
 *                          panel, /mebular/embed-info, and MCP use one origin
 *   uninstall              dsh plugin remove leaves the external daemon untouched
 *   security-headers       plain Console stays DENY; ?embed=dsh loosens only on
 *                          loopback; discovery documents carry no secrets/paths
 *
 * Every scenario gets its own MEBULAR_HOME, DSH_HOME, profile, random ports,
 * temp directory, probe output, and artifacts. Artifacts are redacted before
 * they are kept (scripts/lib/redact.mjs) and audited after writing.
 *
 * Agent-visible status is read through DSH's own systemPrompt registry
 * (`ctx.inject(['systemPrompt'])` + `assemble()`), never from the DOM.
 *
 * Usage:
 *   node scripts/verify-dsh-e2e.mjs [--scenario <name>]... [--keep]
 *     [--dsh-version <version|minimum|current|latest>] [--root <dir>] [--list]
 *     [--plugin-tarball <path>]
 *
 * `--plugin-tarball` installs an explicit plugin tarball instead of packing
 * `packages/dsh-plugin`; it exists for the negative control (test-of-test) and
 * never changes the default path when omitted.
 *
 * `--root` (or MEBULAR_DSH_E2E_ROOT) pins the harness root so CI can upload a
 * stable failure path ($RUNNER_TEMP/dsh-e2e/<version>). The directory must not
 * overlap the repository, the home directory, or the filesystem root. The
 * harness only removes roots it created, or entries it owns under a directory
 * carrying its marker file; success cleans up, failure keeps the scene.
 *
 * Exit codes: 0 all selected scenarios passed; 1 any failure or artifact leak.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, parse as parsePath, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome } from './lib/cdp.mjs';
import { createWorld } from './lib/dsh-e2e-world.mjs';
import {
  countMatches,
  fetchJson,
  fetchRaw,
  freePort,
  packPackage,
  readJsonIfExists,
  runCommand,
  sleep,
  tail,
  waitForValue,
} from './lib/e2e-process.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mebularBin = join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const probeDir = join(repoRoot, 'tests', 'dsh', 'e2e', 'fixtures', 'probe-plugin');
const versionsPath = join(repoRoot, 'tests', 'dsh', 'e2e', 'versions.json');

const IFRAME_SELECTOR = 'iframe[title="Mebular Console"]';
const SIDEBAR_SELECTOR = 'button[aria-label="Mebular"]';
const STATUS_SELECTOR = '[data-mebular-status]';

// Ownership marker for an explicit --root. Only entries matching this pattern
// are ever removed from a directory the harness did not create itself.
const ROOT_MARKER = '.mebular-dsh-e2e-root.json';
const HARNESS_ROOT_ENTRY = /^(?:scenario-.+|pack|dsh-install|\.mebular-dsh-e2e-root\.json)$/;

let passed = 0;
let failed = 0;

const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
  }
  return ok;
};

class StepError extends Error {}

function requireCheck(name, ok, detail = '') {
  if (!check(name, ok, detail)) throw new StepError(name);
  return true;
}

function parseArgs(argv) {
  const options = {
    scenarios: [], keep: false, dshVersion: null, root: null, list: false, pluginTarball: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--scenario') {
      const value = argv[index + 1] ?? '';
      if (value.length === 0) throw new Error('--scenario 需要名称');
      options.scenarios.push(value);
      index += 1;
    } else if (arg.startsWith('--scenario=')) {
      options.scenarios.push(arg.slice('--scenario='.length));
    } else if (arg === '--dsh-version') {
      options.dshVersion = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--dsh-version=')) {
      options.dshVersion = arg.slice('--dsh-version='.length);
    } else if (arg === '--root') {
      const value = argv[index + 1] ?? '';
      if (value.length === 0) throw new Error('--root 需要目录');
      options.root = value;
      index += 1;
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (value.length === 0) throw new Error('--root 需要目录');
      options.root = value;
    } else if (arg === '--plugin-tarball') {
      const value = argv[index + 1] ?? '';
      if (value.length === 0) throw new Error('--plugin-tarball 需要 tarball 路径');
      options.pluginTarball = value;
      index += 1;
    } else if (arg.startsWith('--plugin-tarball=')) {
      const value = arg.slice('--plugin-tarball='.length);
      if (value.length === 0) throw new Error('--plugin-tarball 需要 tarball 路径');
      options.pluginTarball = value;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/**
 * Resolve an explicit plugin tarball (negative control only). The default path
 * still packs `packages/dsh-plugin`, so an invalid override fails loudly here
 * instead of being silently ignored.
 *
 * @returns {Promise<{ path: string, size: number, filename: string }>}
 */
async function resolvePluginTarballOverride(value) {
  const path = resolve(value);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`--plugin-tarball 不存在：${path}`);
  }
  if (!info.isFile()) throw new Error(`--plugin-tarball 不是文件：${path}`);
  if (info.size === 0) throw new Error(`--plugin-tarball 是空文件：${path}`);
  return { path, size: info.size, filename: basename(path) };
}

function resolveDshVersion(value, versions) {
  if (value === 'minimum') return versions.minimum;
  if (value === 'current') return versions.current;
  return value;
}

function isSameOrInside(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function realpathOrSelf(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Nearest existing ancestor of a path that may not exist yet. */
async function nearestExistingAncestor(target) {
  let current = target;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Reject roots that overlap the filesystem root, the home directory, or the
 * repository — including when the overlap is only visible through a symlinked
 * ancestor. A root that is itself a symlink is rejected outright.
 *
 * @returns {Promise<{ exists: boolean, realDir: string }>}
 */
async function assertSafeRoot(dir) {
  const lexicalHome = resolve(homedir());
  if (dir === parsePath(dir).root) {
    throw new Error(`--root 不能是文件系统根目录：${dir}`);
  }
  if (dir === lexicalHome) {
    throw new Error(`--root 不能是用户主目录：${dir}`);
  }
  if (isSameOrInside(dir, repoRoot) || isSameOrInside(repoRoot, dir)) {
    throw new Error(`--root 不能与仓库目录重叠：${dir}`);
  }

  let exists = true;
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink()) {
      throw new Error(`--root 不能是符号链接：${dir}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`--root 不是目录：${dir}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    exists = false;
  }

  let realDir;
  if (exists) {
    realDir = await realpath(dir);
  } else {
    // The root does not exist yet: resolve the nearest existing ancestor and
    // re-attach the missing suffix, so a symlinked parent cannot hide an
    // overlap with the repository or home directory.
    const ancestor = await nearestExistingAncestor(dirname(dir));
    const realAncestor = await realpath(ancestor);
    realDir = resolve(realAncestor, relative(ancestor, dir));
  }

  const realHome = await realpathOrSelf(lexicalHome);
  const realRepo = await realpathOrSelf(repoRoot);
  if (realDir === parsePath(realDir).root) {
    throw new Error(`--root 不能是文件系统根目录（realpath）：${realDir}`);
  }
  if (realDir === realHome) {
    throw new Error(`--root 不能是用户主目录（realpath）：${realDir}`);
  }
  if (isSameOrInside(realDir, realRepo) || isSameOrInside(realRepo, realDir)) {
    throw new Error(`--root 不能与仓库目录重叠（realpath：${realDir}）：${dir}`);
  }
  return { exists, realDir };
}

/**
 * Create or validate the harness root.
 *
 * Default: a fresh mkdtemp directory (Phase 1/2 behavior, removed on success).
 * Explicit root: must be absent, empty, or a previous harness root carrying the
 * marker (only harness-owned entries). Never a repository ancestor/descendant,
 * the home directory, or the filesystem root; symlinked roots are rejected.
 */
async function prepareRoot(requested) {
  if (requested === null || requested === undefined) {
    const dir = await mkdtemp(join(tmpdir(), 'mebular-dsh-e2e-'));
    await writeRootMarker(dir, true);
    return { dir, explicit: false, created: true };
  }

  const dir = resolve(requested);
  const { exists } = await assertSafeRoot(dir);

  if (!exists) {
    await mkdir(dir, { recursive: true });
    await writeRootMarker(dir, true);
    return { dir, explicit: true, created: true };
  }

  const entries = await readdir(dir);
  if (entries.length > 0) {
    if (!entries.includes(ROOT_MARKER)) {
      throw new Error(`--root 目录非空且缺少 ${ROOT_MARKER} 标记，拒绝使用/清理：${dir}`);
    }
    const unknown = entries.filter((name) => !HARNESS_ROOT_ENTRY.test(name));
    if (unknown.length > 0) {
      throw new Error(`--root 目录含非 harness 文件（${unknown.join(', ')}），拒绝清理：${dir}`);
    }
    // Previous failed run: clear only harness-owned entries, keep the directory.
    for (const name of entries) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
  await writeRootMarker(dir, false);
  return { dir, explicit: true, created: false };
}

async function writeRootMarker(dir, created) {
  await writeFile(
    join(dir, ROOT_MARKER),
    `${JSON.stringify({ tool: 'verify-dsh-e2e', createdAt: new Date().toISOString(), created }, null, 2)}\n`,
    'utf-8',
  );
}

async function cleanupRoot(rootInfo, { keep }) {
  if (keep) return { removed: false, dir: rootInfo.dir };
  if (rootInfo.created) {
    await rm(rootInfo.dir, { recursive: true, force: true }).catch(() => undefined);
    return { removed: true, dir: rootInfo.dir };
  }
  // The directory existed before this run: remove only entries the harness owns.
  const entries = await readdir(rootInfo.dir).catch(() => []);
  for (const name of entries) {
    if (HARNESS_ROOT_ENTRY.test(name)) {
      await rm(join(rootInfo.dir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { removed: true, dir: rootInfo.dir };
}

function probeSummary(probe) {
  if (probe === null || probe === undefined) return 'probe=missing';
  return `phase=${probe.phase ?? '?'} mcpTools=${probe.mebularToolCount ?? '?'} schemas=${probe.schemaCount ?? '?'} agent=${probe.agent?.supported ?? 'pending'} done=${probe.done === true}`;
}

async function waitProbeOrFail(world, predicate, description, timeoutMs = 60000, detailFn = probeSummary) {
  const result = await world.waitForProbe(predicate, { timeoutMs, describe: description });
  const detail = result.ok ? detailFn(result.value) : `${detailFn(result.value)} timeout=${timeoutMs}ms`;
  requireCheck(description, result.ok, detail);
  return result.value;
}

async function statusDetail(world) {
  return world.state.page.evalJs(
    `document.querySelector(${JSON.stringify(STATUS_SELECTOR)})?.getAttribute('data-mebular-status') ?? '(missing)'`,
  );
}

async function assertNoPageExceptions(world) {
  const exceptions = world.state.page.errors.filter((entry) => entry.kind === 'exception');
  check('页面没有未捕获异常', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 500));
}

const OFFLINE_PANEL_TITLE = '^(?:Mebular 未运行|Mebular is not running)$';
const INSTALL_PANEL_TITLE = '^(?:安装 Mebular Runtime|Install Mebular Runtime)$';

async function waitForPanelHeading(world, pattern, timeoutMs = 30000) {
  return world.state.page.waitFor(
    `[...document.querySelectorAll("h2")].some((node) =>
      new RegExp(${JSON.stringify(pattern)}, "i").test(node.textContent?.trim() ?? "")
    )`,
    { timeout: timeoutMs },
  );
}

async function panelHeadingText(world) {
  return world.state.page.evalJs(
    '[...document.querySelectorAll("h2")].map((node) => node.textContent?.trim() ?? "").find((text) => /Mebular/.test(text)) ?? ""',
  );
}

async function assertNoSensitive(world, value, label) {
  const text = JSON.stringify(value ?? null);
  const leaks = [];
  const needles = [
    ['seed-token', world.seed.memoryToken],
    ['mebular-home', world.state.mebularHome],
    ['dsh-home', world.state.dshHome],
    ['scenario-dir', world.state.scenarioDir],
    ['repo-root', repoRoot],
  ];
  for (const [name, needle] of needles) {
    if (typeof needle === 'string' && needle.length > 1 && text.includes(needle)) leaks.push(name);
  }
  if (/[?&;]token=/.test(text)) leaks.push('token-query');
  if (/\bBearer\s+/i.test(text)) leaks.push('bearer');
  if (/\bAuthorization\b/i.test(text)) leaks.push('authorization');
  if (/\bcliPath\b/i.test(text)) leaks.push('cliPath');
  check(label, leaks.length === 0, leaks.length === 0 ? '' : leaks.join(', '));
}

function panelFalsePatch() {
  return [
    '# E2E profile patch: keep the MCP bridge, disable only the DSH panel.',
    '# A profile patch replaces the whole config for the matched row.',
    '- id: mebular',
    '  config:',
    '    lifecycle: attach',
    '    panel: false',
    '',
  ].join('\n');
}

function managedPatch(cliPath) {
  return [
    '# E2E profile patch: let the plugin own its daemon child.',
    '# A profile patch replaces the whole config for the matched row.',
    '- id: mebular',
    '  config:',
    '    lifecycle: managed',
    `    cliPath: ${JSON.stringify(cliPath)}`,
    '    panel: true',
    '',
  ].join('\n');
}

/** PATH dirs that cannot resolve a `mebular` executable (download_required). */
function pathWithoutMebular(env) {
  const dirs = String(env.PATH ?? '').split(delimiter).filter((dir) => dir.length > 0);
  return dirs.filter((dir) => !existsSync(join(dir, 'mebular')) && !existsSync(join(dir, 'mebular.cmd')));
}

function pathHasNode(dirs) {
  return dirs.some((dir) => existsSync(join(dir, 'node')) || existsSync(join(dir, 'node.exe')));
}

async function waitForDshInfo(world, predicate, timeoutMs = 45000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await world.fetchDshJson('/mebular/embed-info').catch(() => null);
    if (predicate(last?.json ?? null)) return last.json;
    await sleep(250);
  }
  return last?.json ?? null;
}

async function waitForRuntime(world, predicate, timeoutMs = 20000) {
  const result = await waitForValue(
    async () => readJsonIfExists(join(world.state.mebularHome, 'runtime.json')),
    (value) => value !== null && predicate(value),
    { timeoutMs, intervalMs: 250, describe: 'runtime.json' },
  );
  return result.value;
}

async function portClosed(port) {
  try {
    await fetchJson(`http://127.0.0.1:${port}/healthz`, 1000);
    return false;
  } catch {
    return true;
  }
}

function agentSummary(probe) {
  const agent = probe?.agent;
  if (agent === null || agent === undefined) return 'agent=missing';
  const text = typeof agent.text === 'string' ? agent.text : '';
  return `supported=${agent.supported ?? 'pending'} section=${agent.sectionPresent === true} textLength=${text.trim().length} error=${agent.error ?? 'none'}`;
}

function agentUnavailableReason(probe) {
  const agent = probe?.agent;
  if (agent === null || agent === undefined) return 'probe 未记录 systemPrompt 状态';
  if (agent.supported !== true) {
    return `systemPrompt 不可读（supported=${agent.supported ?? 'pending'}，${agent.error ?? 'no service'}）`;
  }
  if (typeof agent.error === 'string' && agent.error.length > 0) return agent.error;
  return null;
}

function agentText(probe) {
  return typeof probe?.agent?.text === 'string' ? probe.agent.text.trim() : '';
}

function checkAgentReadable(probe, label) {
  const reason = agentUnavailableReason(probe);
  check(`${label}：Agent 状态来自 ctx.systemPrompt.assemble()`, reason === null, reason ?? agentSummary(probe));
  return reason === null;
}

function checkAgentUp(probe, label) {
  if (!checkAgentReadable(probe, label)) return false;
  const text = agentText(probe);
  return check(
    `${label}：daemon up 时 mebular:status 不贡献 prompt 文本`,
    text.length === 0,
    `textLength=${text.length} text=${tail(text, 180) || '(empty)'}`,
  );
}

function findDownAgent(probe) {
  const history = Array.isArray(probe?.agentHistory) ? probe.agentHistory : [];
  return history.find((entry) => entry?.mebularToolCount === 0
    && entry?.supported === true
    && typeof entry?.text === 'string'
    && entry.text.trim().length > 0) ?? null;
}

function checkAgentDownText(probe, label) {
  const entry = findDownAgent(probe);
  const detail = entry === null
    ? agentSummary(probe)
    : `textLength=${entry.text.trim().length} toolCount=${entry.mebularToolCount} phase=${entry.phase ?? '?'}`;
  if (!check(`${label}：daemon down 时记录了非空的 mebular:status`, entry !== null, detail)) {
    return;
  }
  const text = entry.text.trim();
  check(`${label}：明确说 Mebular 记忆不可用`, /Mebular/i.test(text) && /unavailable|not running|not healthy|starting/i.test(text), tail(text, 220));
  check(`${label}：给出启动 App / mebular serve 的恢复动作`, /(Mebular app|mebular serve)/i.test(text), tail(text, 220));
  check(`${label}：不诱导模型声称记忆可用`, /do not claim/i.test(text), tail(text, 220));
  check(`${label}：恢复后 section 文本重新为空`, agentText(probe).length === 0 || probe?.done !== true, `text=${tail(agentText(probe), 160) || '(empty)'}`);
}

function checkAgentCliMissingText(probe, label) {
  if (!checkAgentReadable(probe, label)) return;
  const text = agentText(probe);
  check(`${label}：daemon down 时 mebular:status 非空`, text.length > 0, tail(text, 220) || '(empty)');
  check(`${label}：说明 CLI/runtime 缺失`, /(CLI|cliPath|MEBULAR_CLI|runtime)/i.test(text), tail(text, 240));
  check(`${label}：给出安装 / 配置恢复动作`, /install (the )?Mebular|MEBULAR_CLI|cliPath/i.test(text) && /restart DSH/i.test(text), tail(text, 240));
}

const scenarios = [
  {
    name: 'happy-path',
    title: 'Happy path（Phase 1 回归）',
    run: async (world, context) => {
      const daemon = await world.startDaemon();
      check('daemon SERVE_READY', daemon.ready.port === daemon.port, `port=${daemon.port}`);
      check('GET /healthz 200 + status ok', daemon.health.status === 200 && daemon.health.json?.status === 'ok', `status=${daemon.health.status}`);
      const runtime = await readJsonIfExists(join(world.state.mebularHome, 'runtime.json'));
      check('runtime.json 指向同一个 daemon 端口', runtime?.http?.port === daemon.port, JSON.stringify(runtime?.http ?? null));

      const bundles = await world.installProfile();
      check(
        'profile bundles 包含插件与 probe',
        bundles.includes('@mebular/dsh-plugin') && bundles.includes('@mebular/dsh-e2e-probe'),
        JSON.stringify(bundles),
      );

      const dump = await world.dumpConfig();
      check('只有一条 mebular host row', countMatches(dump, /^\s*-\s*id:\s*mebular\s*$/gm) === 1);
      check('mebular host 只出现一次', countMatches(dump, /^\s*name:\s*'@mebular\/dsh-plugin'\s*$/gm) === 1);
      check('probe row 只出现一次', countMatches(dump, /^\s*-\s*id:\s*mebular-e2e-probe\s*$/gm) === 1);
      check('没有静态 MCP client row', countMatches(dump, /@deepseek-ai\/dsh-mcp-client/gm) === 0);
      check('没有静态 serverName: mebular', countMatches(dump, /serverName:\s*['"]?mebular['"]?/gm) === 0);

      const dshUrl = await world.startDsh({ probeExpect: 'up' });
      check('DSH Web 打印 loopback URL', /^http:\/\/127\.0\.0\.1:\d+\//.test(dshUrl), world.redact(dshUrl));

      await world.openBrowser({ chromePath: context.chromePath, url: dshUrl });
      const title = await world.state.page.evalJs('document.title');
      check('DSH Web 页面已加载', title === 'DeepSeek Harness', title);

      check('侧边栏存在唯一的 Mebular 入口', await world.state.page.waitFor(
        `document.querySelectorAll(${JSON.stringify(SIDEBAR_SELECTOR)}).length === 1`,
        { timeout: 45000 },
      ));
      check('侧边栏状态为 connected', await world.waitForStatus('connected', 45000), await statusDetail(world));

      check('点击侧边栏打开面板', await world.openPanel());
      check('Mebular 面板 iframe 已挂载', await world.waitForIframe());
      const iframeSrc = await world.iframeSrc();
      const expectedEmbedUrl = `http://127.0.0.1:${daemon.port}/console/?embed=dsh`;
      check('iframe src 指向 /console/?embed=dsh', iframeSrc === expectedEmbedUrl, iframeSrc);

      const embedFlag = await world.waitForFrameEval(
        `http://127.0.0.1:${daemon.port}/console/`,
        'document.documentElement.dataset.embed',
        (value) => value === 'dsh',
      );
      check('iframe 内 documentElement.dataset.embed === "dsh"', embedFlag.ok, String(embedFlag.value ?? embedFlag.error?.message ?? 'missing'));

      const consoleReady = await world.waitForFrameEval(
        `http://127.0.0.1:${daemon.port}/console/`,
        'document.readyState === "complete" && Boolean(document.querySelector("#app, main, .console-root, #starfield, canvas"))',
        (value) => value === true,
        15000,
      );
      check('Console 文档已就绪并渲染主容器', consoleReady.ok);

      const probe = await waitProbeOrFail(world, (value) => value.done === true, 'probe 完成工具读取与调用', 90000);
      check('probe 通过 ctx.tools.schemas() 看到工具', probe.schemaCount > 0, `count=${probe.schemaCount}`);
      check(
        '关键 Mebular 工具已注册',
        probe.required?.['mcp__mebular__memory_write'] === true
          && probe.required?.['mcp__mebular__memory_query'] === true,
        `missing=${JSON.stringify(probe.missingRequired ?? [])}`,
      );
      check('不硬编码工具总数（只要求 > 0）', probe.mebularToolCount > 0, `mebular=${probe.mebularToolCount}`);
      const invocation = probe.invocation;
      check('probe 通过 ctx.tools.execute() 调用只读工具', invocation?.tool === 'mcp__mebular__memory_query' && invocation?.ok === true, invocation?.tool ?? '(none)');
      check('工具调用不是错误结果', invocation?.isError === false, String(invocation?.error ?? ''));
      const invocationText = typeof invocation?.text === 'string' ? invocation.text : '';
      check('调用返回临时 home 的真实记忆（含本次 token）', invocationText.includes(world.seed.memoryToken));
      check('调用返回本次 seed 的记忆 id', invocationText.includes(world.seed.memoryId), world.seed.memoryId);
      checkAgentUp(probe, 'daemon up');

      await assertNoPageExceptions(world);

      console.log('\n  证据');
      const sidebarCount = await world.state.page.evalJs(
        `document.querySelectorAll(${JSON.stringify(SIDEBAR_SELECTOR)}).length`,
      );
      console.log(`    侧边栏：${SIDEBAR_SELECTOR} × ${sidebarCount}；状态=${await statusDetail(world)}`);
      console.log(`    iframe：${iframeSrc}`);
      console.log(`    Console：dataset.embed=${embedFlag.value}`);
      console.log(`    工具：schemas=${probe.schemaCount}，mebular=${probe.mebularToolCount}`);
      console.log(`    Agent：${agentSummary(probe)}（up 时文本为空）`);
      console.log(`    真实调用：${invocation.tool} -> ${world.redact(tail(invocationText, 180))}`);
      console.log(`    seed：memoryId=${world.seed.memoryId} token=<redacted>（已命中）`);
    },
  },
  {
    name: 'managed-lifecycle',
    title: 'Managed 生命周期（插件自启 child，DSH 退出只回收自己的 child）',
    run: async (world, context) => {
      const port = await freePort();
      const bundles = await world.installProfile({ patch: managedPatch(mebularBin) });
      check(
        'managed profile 包含插件与 probe',
        bundles.includes('@mebular/dsh-plugin') && bundles.includes('@mebular/dsh-e2e-probe'),
        JSON.stringify(bundles),
      );
      const dump = await world.dumpConfig();
      check('dump-config 只有一条 mebular row', countMatches(dump, /^\s*-\s*id:\s*mebular\s*$/gm) === 1);
      check('dump-config mebular lifecycle: managed', /id:\s*mebular\b[\s\S]*?lifecycle:\s*managed/.test(dump));
      check('dump-config cliPath 指向仓库 Mebular CLI', /cliPath:[\s\S]{0,300}mebular\.mjs/.test(dump), tail(dump, 300));

      // No daemon exists yet: the managed profile points at a reserved port, so
      // a real daemon on 7331 can never be mistaken for this scenario's child.
      await world.startDsh({ probeExpect: 'up', env: { MEBULAR_HTTP_PORT: String(port) } });
      await world.openBrowser({ chromePath: context.chromePath });
      check('DSH Web 页面已加载', (await world.state.page.evalJs('document.title')) === 'DeepSeek Harness');
      check('managed daemon 启动后状态 connected', await world.waitForStatus('connected', 60000), await statusDetail(world));
      check('点击侧边栏打开面板', await world.openPanel());
      check('managed daemon 的 iframe 已挂载', await world.waitForIframe(45000));
      const iframeSrc = await world.iframeSrc();
      check('iframe 指向 managed 端口', iframeSrc === `http://127.0.0.1:${port}/console/?embed=dsh`, iframeSrc);

      const info = await waitForDshInfo(world, (json) => json?.managed === true && json?.status === 'up');
      check('embed-info status=up + ok', info?.status === 'up' && info?.ok === true, JSON.stringify(info));
      check('embed-info mode=managed', info?.mode === 'managed', String(info?.mode));
      check('embed-info managed=true', info?.managed === true, String(info?.managed));
      check('embed-info reason=null', info?.reason === null, String(info?.reason));
      check('embed-info consoleUrl 指向 managed 端口', info?.consoleUrl === `http://127.0.0.1:${port}/console`, info?.consoleUrl ?? '(missing)');

      const runtime = await waitForRuntime(world, (value) => Number.isInteger(value?.pid) && value?.http?.port === port);
      const childPid = runtime?.pid;
      const dshPid = world.state.dsh?.proc?.pid;
      check('runtime.json 记录 managed child pid', Number.isInteger(childPid) && childPid > 0, `pid=${childPid}`);
      check('managed child 不是 DSH 进程', childPid !== dshPid, `child=${childPid} dsh=${dshPid}`);
      check('managed child 存活', world.isProcessAlive(childPid), `pid=${childPid}`);
      check('managed child 与 embed-info 使用同一端口', runtime?.http?.port === port, `port=${runtime?.http?.port}`);
      world.trackOwnedChild(childPid);

      const probe = await waitProbeOrFail(world, (value) => value.done === true, 'managed daemon 下工具注册并可调用', 90000);
      check('managed 时工具数 > 0', probe.mebularToolCount > 0, `mebular=${probe.mebularToolCount}`);
      check('managed 时关键工具存在', probe.required?.['mcp__mebular__memory_write'] === true && probe.required?.['mcp__mebular__memory_query'] === true);
      check('managed 时真实调用成功', probe.invocation?.ok === true, String(probe.invocation?.error ?? ''));
      check('managed 时调用返回本次 seed token', typeof probe.invocation?.text === 'string' && probe.invocation.text.includes(world.seed.memoryToken));
      checkAgentUp(probe, 'managed up');
      await assertNoPageExceptions(world);

      const stopped = await world.stopDsh();
      check('stopDsh 结束 DSH 进程', stopped !== null && !world.isProcessAlive(dshPid), `pid=${dshPid}`);
      check('停止 DSH 后 managed child 退出', await world.waitForExit(childPid, 20000), `pid=${childPid}`);
      check('停止 DSH 后 managed 端口不再监听', await portClosed(port), `port=${port}`);

      console.log('\n  证据');
      console.log(`    profile：lifecycle=managed cliPath=<repo>/packages/mcp/bin/mebular.mjs`);
      console.log(`    embed-info：${JSON.stringify(info)}`);
      console.log(`    managed child：pid=${childPid}（DSH pid=${dshPid}）exit=${!world.isProcessAlive(childPid)}`);
      console.log(`    工具：mebular=${probe.mebularToolCount}；真实调用=${probe.invocation?.tool} ok`);
      console.log(`    Agent：${agentSummary(probe)}（up 时文本为空）`);
      console.log(`    停止 DSH 后端口 ${port} 已关闭`);
    },
  },
  {
    name: 'managed-reuse',
    title: 'Managed 复用外部 daemon（DSH 退出不停止外部 daemon）',
    run: async (world, context) => {
      const daemon = await world.startDaemon();
      const externalPid = daemon.pid;
      const runtimeBefore = await readJsonIfExists(join(world.state.mebularHome, 'runtime.json'));
      check('外部 daemon 已写入 runtime.json', runtimeBefore?.pid === externalPid, `pid=${runtimeBefore?.pid}`);

      const bundles = await world.installProfile({ patch: managedPatch(mebularBin) });
      check('managed reuse profile 已安装插件', bundles.includes('@mebular/dsh-plugin'), JSON.stringify(bundles));
      await world.startDsh({ probeExpect: 'up' });
      await world.openBrowser({ chromePath: context.chromePath });
      check('DSH Web 页面已加载', (await world.state.page.evalJs('document.title')) === 'DeepSeek Harness');
      check('复用外部 daemon 后状态 connected', await world.waitForStatus('connected', 45000), await statusDetail(world));

      const info = await waitForDshInfo(world, (json) => json?.managed === false && json?.status === 'up');
      check('embed-info status=up + ok', info?.status === 'up' && info?.ok === true, JSON.stringify(info));
      check('embed-info mode=managed', info?.mode === 'managed', String(info?.mode));
      check('复用外部 daemon 时 managed=false', info?.managed === false, String(info?.managed));
      check('embed-info reason=null', info?.reason === null, String(info?.reason));
      check('embed-info consoleUrl 指向外部 daemon', info?.consoleUrl === `http://127.0.0.1:${daemon.port}/console`, info?.consoleUrl ?? '(missing)');

      const probe = await waitProbeOrFail(world, (value) => value.done === true, '复用外部 daemon 时工具可调用', 90000);
      check('复用外部 daemon 时工具数 > 0', probe.mebularToolCount > 0, `mebular=${probe.mebularToolCount}`);
      check('复用外部 daemon 时真实调用成功', probe.invocation?.ok === true, String(probe.invocation?.error ?? ''));
      check('复用外部 daemon 时调用返回 seed token', typeof probe.invocation?.text === 'string' && probe.invocation.text.includes(world.seed.memoryToken));
      checkAgentUp(probe, 'managed reuse up');
      await assertNoPageExceptions(world);

      const dshPid = world.state.dsh?.proc?.pid;
      const stopped = await world.stopDsh();
      check('stopDsh 结束 DSH 进程', stopped !== null && !world.isProcessAlive(dshPid), `pid=${dshPid}`);
      check('停止 DSH 后外部 daemon 仍存活', world.isProcessAlive(externalPid), `pid=${externalPid}`);
      const health = await fetchRaw(`http://127.0.0.1:${daemon.port}/healthz`);
      const consolePage = await fetchRaw(`http://127.0.0.1:${daemon.port}/console/`);
      check('停止 DSH 后外部 daemon /healthz 仍 200', health.status === 200, `status=${health.status}`);
      check('停止 DSH 后外部 daemon /console/ 仍 200', consolePage.status === 200, `status=${consolePage.status}`);
      const runtimeAfter = await readJsonIfExists(join(world.state.mebularHome, 'runtime.json'));
      check('外部 daemon runtime.json 未被改动', runtimeAfter?.pid === externalPid && runtimeAfter?.http?.port === daemon.port, JSON.stringify(runtimeAfter?.http ?? null));

      console.log('\n  证据');
      console.log(`    embed-info：${JSON.stringify(info)}`);
      console.log(`    外部 daemon：pid=${externalPid} port=${daemon.port} alive=${world.isProcessAlive(externalPid)}`);
      console.log(`    DSH pid=${dshPid} stopped=${!world.isProcessAlive(dshPid)}`);
      console.log(`    工具：mebular=${probe.mebularToolCount}；真实调用=${probe.invocation?.tool} ok`);
      console.log(`    Agent：${agentSummary(probe)}（up 时文本为空）`);
    },
  },
  {
    name: 'managed-cli-missing',
    title: 'Managed runtime 缺失（down + download_required + Agent 安装提示）',
    run: async (world, context) => {
      const port = await freePort();
      const missingCli = join(world.state.scenarioDir, 'missing-cli', 'mebular.mjs');
      const bundles = await world.installProfile({ patch: managedPatch(missingCli) });
      check('managed cli-missing profile 已安装插件', bundles.includes('@mebular/dsh-plugin'), JSON.stringify(bundles));

      // Keep node (and the rest of the toolchain) on PATH but remove every
      // directory that could resolve a `mebular` executable, so the plugin
      // genuinely takes the shared-runtime download_required branch.
      const pathDirs = pathWithoutMebular(world.env);
      if (!pathHasNode(pathDirs) && !existsSync(join(dirname(process.execPath), 'mebular'))) {
        pathDirs.unshift(dirname(process.execPath));
      }
      requireCheck('过滤后的 PATH 仍可解析 node（且没有 mebular）', pathHasNode(pathDirs), pathDirs.join(delimiter));

      await world.startDsh({
        probeExpect: 'down',
        env: { MEBULAR_HTTP_PORT: String(port), PATH: pathDirs.join(delimiter) },
      });
      await world.openBrowser({ chromePath: context.chromePath });
      check('DSH Web 页面已加载', (await world.state.page.evalJs('document.title')) === 'DeepSeek Harness');
      check('CLI 缺失时状态为 offline', await world.waitForStatus('offline', 60000), await statusDetail(world));
      check('CLI 缺失时点击侧边栏打开面板', await world.openPanel());
      const installGuideVisible = await waitForPanelHeading(world, INSTALL_PANEL_TITLE);
      const installHeading = await panelHeadingText(world);
      check('CLI 缺失时面板显示安装引导', installGuideVisible);
      check(
        'CLI 缺失时占位标题为安装引导',
        new RegExp(INSTALL_PANEL_TITLE, 'i').test(installHeading),
        installHeading || '(no Mebular heading)',
      );
      check('CLI 缺失时没有 iframe', await world.waitForNoIframe(15000));

      const info = await waitForDshInfo(world, (json) => json?.status === 'down' && json?.reason === 'download_required');
      check('embed-info status=down', info?.status === 'down', JSON.stringify(info));
      check('embed-info reason=download_required', info?.reason === 'download_required', String(info?.reason));
      check('embed-info state=download_required', info?.state === 'download_required', String(info?.state));
      check('embed-info downloadRequired=true', info?.downloadRequired === true, String(info?.downloadRequired));
      check('embed-info install 引导可用', info?.install?.allowed === true, JSON.stringify(info?.install));
      check('embed-info managed=false', info?.managed === false, String(info?.managed));
      check('embed-info ok=false', info?.ok === false, String(info?.ok));

      const probe = await waitProbeOrFail(world, (value) => value.done === true, 'CLI 缺失时 probe 完成观察', 60000);
      check('CLI 缺失时没有 mcp__mebular__* 工具', probe.mebularToolCount === 0, `mebular=${probe.mebularToolCount}`);
      check('CLI 缺失时关键工具均未注册', probe.required?.['mcp__mebular__memory_write'] === false && probe.required?.['mcp__mebular__memory_query'] === false);
      checkAgentCliMissingText(probe, 'download_required');
      await assertNoPageExceptions(world);

      console.log('\n  证据');
      console.log(`    embed-info：${JSON.stringify(info)}`);
      console.log(`    工具：mebular=${probe.mebularToolCount}；required=${JSON.stringify(probe.required)}`);
      console.log(`    Agent：${agentSummary(probe)}`);
      console.log(`    Agent 文本：${tail(agentText(probe), 300)}`);
    },
  },

  {
    name: 'daemon-down-recovery',
    title: 'Daemon down 启动 → 恢复 → 掉线 → 再恢复',
    run: async (world, context) => {
      const port = await freePort();
      // No daemon yet: the port is reserved but closed. MEBULAR_HTTP_PORT
      // points the plugin at it, so the fallback 7331 is never involved.
      // Pin the repo CLI explicitly: this is the installed -> daemon-down state,
      // independent of whether npm/direct-node added node_modules/.bin to PATH.
      await world.installProfile();
      await world.startDsh({
        probeExpect: 'recover',
        env: { MEBULAR_HTTP_PORT: String(port), MEBULAR_CLI: mebularBin },
      });
      await world.openBrowser({ chromePath: context.chromePath });
      check('DSH Web 页面已加载', (await world.state.page.evalJs('document.title')) === 'DeepSeek Harness');
      check('down 时侧边栏仍存在', await world.state.page.waitFor(
        `document.querySelectorAll(${JSON.stringify(SIDEBAR_SELECTOR)}).length === 1`,
        { timeout: 45000 },
      ));
      check('down 时状态为 offline', await world.waitForStatus('offline', 45000), await statusDetail(world));
      check('down 时点击侧边栏打开面板', await world.openPanel());
      check(
        'down 时侧边栏面板已渲染',
        await world.state.page.waitFor('document.querySelectorAll("h2").length > 0', { timeout: 30000 }),
      );
      check('down 时没有 iframe', await world.waitForNoIframe(15000));
      const offlinePlaceholderVisible = await waitForPanelHeading(world, OFFLINE_PANEL_TITLE);
      const placeholderHeading = await panelHeadingText(world);
      check('down 时面板显示 offline 占位', offlinePlaceholderVisible);
      check(
        'down 时占位标题为 Mebular 未运行',
        new RegExp(OFFLINE_PANEL_TITLE, 'i').test(placeholderHeading),
        placeholderHeading || '(no Mebular heading)',
      );
      const downPanelText = await world.pageText();
      check(
        'down 时说明 daemon 未响应及恢复动作',
        /Mebular daemon/i.test(downPanelText) && /mebular serve/i.test(downPanelText),
        tail(downPanelText, 300),
      );
      const downAtBoot = await waitProbeOrFail(
        world,
        (value) => value.pollCount >= 3 && value.mebularToolCount === 0,
        'down 时没有 mcp__mebular__* 工具',
        30000,
      );
      check(
        'down 时关键工具均未注册',
        downAtBoot.required?.['mcp__mebular__memory_write'] === false
          && downAtBoot.required?.['mcp__mebular__memory_query'] === false,
        JSON.stringify(downAtBoot.required ?? {}),
      );

      const dshPid = world.state.dsh.proc.pid;
      const firstDaemon = await world.startDaemon({ port });
      check('运行中启动 daemon 成功', firstDaemon.port === port, `port=${firstDaemon.port}`);

      const firstUp = await waitProbeOrFail(
        world,
        (value) => value.firstUpAt !== null,
        'daemon 启动后工具自动重挂',
        45000,
      );
      check('恢复后状态 connected', await world.waitForStatus('connected', 45000), await statusDetail(world));
      check('恢复后 iframe 自动出现', await world.waitForIframe(45000));
      check('恢复后 iframe 指向同一 daemon', (await world.iframeSrc()) === `http://127.0.0.1:${port}/console/?embed=dsh`, await world.iframeSrc());

      const stopped = await world.stopDaemon();
      check('运行中停止 daemon', stopped !== null, `pid=${stopped?.pid ?? '?'}`);
      const runtimeDown = await waitProbeOrFail(
        world,
        (value) => value.downAt !== null,
        'daemon 掉线后工具自动注销',
        45000,
      );
      check('掉线后工具数为 0', runtimeDown.mebularToolCount === 0, `mebular=${runtimeDown.mebularToolCount}`);
      check('掉线后 Agent 状态文本非空', agentText(runtimeDown).length > 0, agentSummary(runtimeDown));
      check('掉线后状态 offline', await world.waitForStatus('offline', 45000), await statusDetail(world));
      check('掉线后 iframe 消失', await world.waitForNoIframe(45000));

      const secondDaemon = await world.startDaemon({ port });
      check('同一端口重启 daemon', secondDaemon.port === port, `port=${secondDaemon.port}`);
      const recovered = await waitProbeOrFail(
        world,
        (value) => value.recoveredAt !== null && value.done === true,
        'daemon 重启后工具再次挂载并完成真实调用',
        60000,
      );
      check('再次恢复后状态 connected', await world.waitForStatus('connected', 45000), await statusDetail(world));
      check('再次恢复后 iframe 重新出现', await world.waitForIframe(45000));
      const invocation = recovered.invocation;
      check('恢复后的真实调用成功', invocation?.ok === true, String(invocation?.error ?? ''));
      check('恢复后的调用仍返回本次 seed token', typeof invocation?.text === 'string' && invocation.text.includes(world.seed.memoryToken));
      check('恢复后的调用仍返回 memory id', typeof invocation?.text === 'string' && invocation.text.includes(world.seed.memoryId));
      check('全程未重启 DSH', world.state.dsh.proc.pid === dshPid && world.state.dsh.proc.exitCode === null, `pid=${dshPid}`);
      checkAgentDownText(recovered, 'daemon down');
      checkAgentUp(recovered, 'daemon recovered');
      await assertNoPageExceptions(world);

      console.log('\n  证据');
      console.log(`    启动：无 daemon，状态=offline，工具=${downAtBoot.mebularToolCount}`);
      console.log(`    第一次恢复：状态=connected，工具=${firstUp.mebularToolCount}，iframe 已加载`);
      console.log(`    掉线：状态=offline，工具=${runtimeDown.mebularToolCount}，iframe 已移除`);
      console.log(`    掉线 Agent 文本：${tail(agentText(runtimeDown), 300) || '(empty)'}`);
      console.log(`    第二次恢复：状态=connected，工具=${recovered.mebularToolCount}，真实调用=${invocation.tool} ok`);
      console.log(`    恢复后 Agent：${agentSummary(recovered)}（up 时文本为空）`);
      console.log(`    DSH pid 全程=${dshPid}`);
    },
  },
  {
    name: 'panel-false',
    title: 'panel:false（独立 profile，仅关面板）',
    run: async (world, context) => {
      const daemon = await world.startDaemon();
      const bundles = await world.installProfile({ patch: panelFalsePatch() });
      check('panel:false profile 已安装插件', bundles.includes('@mebular/dsh-plugin'), JSON.stringify(bundles));
      const dump = await world.dumpConfig();
      check('dump-config 中只有一条 mebular row', countMatches(dump, /^\s*-\s*id:\s*mebular\s*$/gm) === 1);
      check('dump-config 中 mebular row 为 panel: false', /id:\s*mebular\b[\s\S]*?panel:\s*false/.test(dump));

      await world.startDsh({ probeExpect: 'up' });
      await world.openBrowser({ chromePath: context.chromePath });
      check('DSH Web 页面已加载', (await world.state.page.evalJs('document.title')) === 'DeepSeek Harness');
      const panelGlobal = await world.state.page.waitFor(
        'window.__MEBULAR_DSH__?.panel === false',
        { timeout: 45000 },
      );
      check('host 注入 window.__MEBULAR_DSH__ = { panel: false }', panelGlobal, JSON.stringify(await world.state.page.evalJs('window.__MEBULAR_DSH__ ?? null')));

      // Give the client bundle time to apply; absence is only meaningful after
      // the page and the bootstrap global are both ready.
      await sleep(3000);
      check('DSH 侧边栏基础 UI 已渲染', await world.state.page.waitFor(
        'document.querySelectorAll("button[aria-label]").length > 0',
        { timeout: 15000 },
      ));
      check('没有 Mebular 侧边栏', (await world.state.page.evalJs(`document.querySelectorAll(${JSON.stringify(SIDEBAR_SELECTOR)}).length`)) === 0);
      check('没有 Mebular iframe', (await world.state.page.evalJs(`document.querySelectorAll(${JSON.stringify(IFRAME_SELECTOR)}).length`)) === 0);
      check('DSH 页面主体已渲染', (await world.pageText()).trim().length > 0);

      const embedInfo = await world.fetchDshJson('/mebular/embed-info');
      check('/mebular/embed-info 200', embedInfo.status === 200, `status=${embedInfo.status}`);
      check('embed-info 报告 panel=false + up', embedInfo.json?.panel === false && embedInfo.json?.status === 'up' && embedInfo.json?.ok === true, JSON.stringify(embedInfo.json));
      check('embed-info 与 daemon 同源', embedInfo.json?.consoleUrl === `http://127.0.0.1:${daemon.port}/console`, embedInfo.json?.consoleUrl ?? '(missing)');

      const probe = await waitProbeOrFail(world, (value) => value.done === true, 'panel:false 时工具仍注册并可调用', 90000);
      check('panel:false 时工具数 > 0', probe.mebularToolCount > 0, `mebular=${probe.mebularToolCount}`);
      check('panel:false 时关键工具存在', probe.required?.['mcp__mebular__memory_write'] === true && probe.required?.['mcp__mebular__memory_query'] === true);
      check('panel:false 时真实调用成功', probe.invocation?.ok === true, String(probe.invocation?.error ?? ''));
      check('panel:false 时调用返回 seed token', typeof probe.invocation?.text === 'string' && probe.invocation.text.includes(world.seed.memoryToken));
      checkAgentUp(probe, 'panel:false up');
      await assertNoPageExceptions(world);

      console.log('\n  证据');
      console.log(`    panel global：${JSON.stringify(await world.state.page.evalJs('window.__MEBULAR_DSH__ ?? null'))}`);
      console.log(`    sidebar=${await world.state.page.evalJs(`document.querySelectorAll(${JSON.stringify(SIDEBAR_SELECTOR)}).length`)} iframe=${await world.state.page.evalJs(`document.querySelectorAll(${JSON.stringify(IFRAME_SELECTOR)}).length`)}`);
      console.log(`    工具：mebular=${probe.mebularToolCount}；真实调用=${probe.invocation?.tool} ok`);
      console.log(`    embed-info：${JSON.stringify(embedInfo.json)}`);
    },
  },
  {
    name: 'custom-port',
    title: '自定义端口/发现（env 覆盖冲突的 runtime.json）',
    run: async (world, context) => {
      const daemon = await world.startDaemon();
      let conflictPort = await freePort();
      while (conflictPort === daemon.port) conflictPort = await freePort();
      // Make runtime.json point at a *live pid* but a closed port. The plugin
      // contract says MEBULAR_HTTP_PORT wins; a green bridge proves it did.
      await writeFile(
        join(world.state.mebularHome, 'runtime.json'),
        JSON.stringify({
          version: '0.0.0-conflict',
          pid: process.pid,
          http: { host: '127.0.0.1', port: conflictPort },
          consolePath: '/console',
          mcpPath: '/mcp',
          embedProtocol: 1,
        }, null, 2),
        'utf-8',
      );

      await world.installProfile();
      await world.startDsh({ probeExpect: 'up', env: { MEBULAR_HTTP_PORT: String(daemon.port) } });
      await world.openBrowser({ chromePath: context.chromePath });
      check('DSH Web 页面已加载', (await world.state.page.evalJs('document.title')) === 'DeepSeek Harness');
      check('显式端口下状态 connected', await world.waitForStatus('connected', 45000), await statusDetail(world));
      check('点击侧边栏打开面板', await world.openPanel());
      check('显式端口下 iframe 已挂载', await world.waitForIframe());
      const expectedOrigin = `http://127.0.0.1:${daemon.port}`;
      const iframeSrc = await world.iframeSrc();
      check('iframe 使用 MEBULAR_HTTP_PORT 的 origin', iframeSrc === `${expectedOrigin}/console/?embed=dsh`, iframeSrc);

      const dshInfo = await world.fetchDshJson('/mebular/embed-info');
      check('/mebular/embed-info 200', dshInfo.status === 200, `status=${dshInfo.status}`);
      check('/mebular/embed-info 与 daemon 同源', dshInfo.json?.consoleUrl === `${expectedOrigin}/console`, dshInfo.json?.consoleUrl ?? '(missing)');
      check('/mebular/embed-info mcpUrl 同源', dshInfo.json?.mcpUrl === `${expectedOrigin}/mcp`, dshInfo.json?.mcpUrl ?? '(missing)');
      check('/mebular/embed-info embedUrl 同源', dshInfo.json?.embedUrl === `${expectedOrigin}/console/?embed=dsh`, dshInfo.json?.embedUrl ?? '(missing)');

      const daemonInfo = await fetchJson(`${expectedOrigin}/app/embed/info`);
      check('daemon /app/embed/info 200', daemonInfo.status === 200, `status=${daemonInfo.status}`);
      check('daemon embed-info 三处同源', daemonInfo.json?.consoleUrl === `${expectedOrigin}/console`
        && daemonInfo.json?.embedUrl === `${expectedOrigin}/console/?embed=dsh`
        && daemonInfo.json?.mcpUrl === `${expectedOrigin}/mcp`, JSON.stringify(daemonInfo.json));

      const probe = await waitProbeOrFail(world, (value) => value.done === true, '显式端口下工具可用', 90000);
      check('MCP 工具来自同一 daemon', probe.invocation?.ok === true && typeof probe.invocation?.text === 'string' && probe.invocation.text.includes(world.seed.memoryToken));
      check('未误用冲突 runtime.json 的端口', !JSON.stringify({ iframeSrc, dshInfo: dshInfo.json, daemonInfo: daemonInfo.json }).includes(`:${conflictPort}`), `conflictPort=${conflictPort}`);
      checkAgentUp(probe, 'custom-port up');
      await assertNoPageExceptions(world);

      console.log('\n  证据');
      console.log(`    daemon 端口=${daemon.port}；runtime.json 冲突端口=${conflictPort}（无监听）`);
      console.log(`    iframe：${iframeSrc}`);
      console.log(`    /mebular/embed-info：console=${dshInfo.json?.consoleUrl} embed=${dshInfo.json?.embedUrl} mcp=${dshInfo.json?.mcpUrl}`);
      console.log(`    daemon /app/embed/info：console=${daemonInfo.json?.consoleUrl} mcp=${daemonInfo.json?.mcpUrl}`);
      console.log(`    MCP 调用：${probe.invocation?.tool} ok；token 命中=${probe.invocation?.text?.includes(world.seed.memoryToken) === true}`);
    },
  },
  {
    name: 'uninstall',
    title: '卸载隔离（plugin remove 不误停外部 daemon）',
    run: async (world, context) => {
      const daemon = await world.startDaemon();
      await world.installProfile({ withProbe: false });
      await world.startDsh({ probeExpect: null });
      await world.openBrowser({ chromePath: context.chromePath });
      check('卸载前状态 connected', await world.waitForStatus('connected', 45000), await statusDetail(world));
      const daemonPid = daemon.pid;
      const dshPid = world.state.dsh.proc.pid;

      await world.removePlugin('@mebular/dsh-plugin');
      const profilePkg = await readJsonIfExists(join(world.state.dshHome, 'profiles', 'web', 'package.json'));
      const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
      check('profile bundles 不再包含插件', !bundles.includes('@mebular/dsh-plugin'), JSON.stringify(bundles));

      let removed = false;
      let lastDump = '';
      for (let attempt = 0; attempt < 30; attempt += 1) {
        lastDump = await world.dumpConfig();
        if (!/\bid:\s*mebular\b/.test(lastDump)) {
          removed = true;
          break;
        }
        await sleep(1000);
      }
      check('dump-config 不再包含 mebular row', removed);
      check('daemon 进程仍存活', world.isProcessAlive(daemonPid), `pid=${daemonPid}`);
      const health = await fetchRaw(`http://127.0.0.1:${daemon.port}/healthz`);
      const consolePage = await fetchRaw(`http://127.0.0.1:${daemon.port}/console/`);
      check('daemon /healthz 仍 200', health.status === 200, `status=${health.status}`);
      check('daemon /console/ 仍 200', consolePage.status === 200, `status=${consolePage.status}`);
      check('DSH 进程未退出', world.state.dsh.proc.pid === dshPid && world.state.dsh.proc.exitCode === null, `pid=${dshPid}`);
      check('DSH 页面仍可用', (await world.state.page.evalJs('document.title')) === 'DeepSeek Harness');
      await assertNoPageExceptions(world);

      console.log('\n  证据');
      console.log(`    plugin remove 后 bundles=${JSON.stringify(bundles)}`);
      console.log(`    dump-config 无 mebular row=${removed}`);
      console.log(`    daemon pid=${daemonPid} alive=${world.isProcessAlive(daemonPid)}；/healthz=${health.status}；/console/=${consolePage.status}`);
      console.log(`    DSH pid=${dshPid} alive=${world.state.dsh.proc.exitCode === null}`);
    },
  },
  {
    name: 'security-headers',
    title: '安全头与发现文档脱敏',
    run: async (world, context) => {
      const daemon = await world.startDaemon();
      await world.installProfile({ withProbe: false });
      await world.startDsh({ probeExpect: null });
      await world.openBrowser({ chromePath: context.chromePath });
      check('安全头场景状态 connected', await world.waitForStatus('connected', 45000), await statusDetail(world));

      const origin = `http://127.0.0.1:${daemon.port}`;
      const plain = await fetchRaw(`${origin}/console/`);
      const embed = await fetchRaw(`${origin}/console/?embed=dsh`);
      world.state.headers = {
        plainConsole: { status: plain.status, headers: plain.headers },
        embedConsole: { status: embed.status, headers: embed.headers },
      };

      check('普通 /console/ 200', plain.status === 200, `status=${plain.status}`);
      check('普通 /console/ X-Frame-Options: DENY', plain.headers['x-frame-options'] === 'DENY', plain.headers['x-frame-options'] ?? '(missing)');
      check("普通 /console/ frame-ancestors 'none'", (plain.headers['content-security-policy'] ?? '').includes("frame-ancestors 'none'"));
      check('?embed=dsh /console/ 200', embed.status === 200, `status=${embed.status}`);
      check('?embed=dsh 不发送 X-Frame-Options', embed.headers['x-frame-options'] === undefined, embed.headers['x-frame-options'] ?? '(absent)');
      const embedCsp = embed.headers['content-security-policy'] ?? '';
      check(
        '?embed=dsh 的 frame-ancestors 只放开 loopback 与 DSH Desktop',
        embedCsp.includes('frame-ancestors http://127.0.0.1:* http://localhost:* dsh-app://app'),
        embedCsp,
      );

      const daemonInfo = await fetchJson(`${origin}/app/embed/info`);
      check('daemon /app/embed/info 200', daemonInfo.status === 200, `status=${daemonInfo.status}`);
      await assertNoSensitive(world, daemonInfo.json, 'daemon /app/embed/info 不含 token/密钥/home/CLI 路径');

      const dshInfo = await world.fetchDshJson('/mebular/embed-info');
      check('/mebular/embed-info 200', dshInfo.status === 200, `status=${dshInfo.status}`);
      const allowedKeys = [
        'ok', 'status', 'state', 'mode', 'runtimeMode', 'managed', 'panel', 'version',
        'daemonUrl', 'profile', 'provider', 'service', 'downloadRequired', 'install',
        'update', 'upgrade', 'embedProtocol', 'consoleUrl', 'embedUrl', 'mcpUrl',
        'loopback', 'reason',
      ];
      const keys = Object.keys(dshInfo.json ?? {}).sort();
      check('/mebular/embed-info 字段白名单', keys.every((key) => allowedKeys.includes(key)), JSON.stringify(keys));
      const requiredKeys = ['ok', 'status', 'panel', 'consoleUrl', 'embedUrl', 'mcpUrl', 'loopback'];
      check('/mebular/embed-info 包含契约字段', requiredKeys.every((key) => keys.includes(key)), JSON.stringify(requiredKeys));
      await assertNoSensitive(world, dshInfo.json, '/mebular/embed-info 不含 token/密钥/home/CLI 路径');
      check('/mebular/embed-info 同源', dshInfo.json?.consoleUrl === `${origin}/console` && dshInfo.json?.embedUrl === `${origin}/console/?embed=dsh`, JSON.stringify(dshInfo.json));

      await assertNoPageExceptions(world);

      console.log('\n  证据');
      console.log(`    普通 /console/：status=${plain.status} X-Frame-Options=${plain.headers['x-frame-options']}`);
      console.log(`    普通 CSP：${plain.headers['content-security-policy']}`);
      console.log(`    ?embed=dsh：status=${embed.status} X-Frame-Options=${embed.headers['x-frame-options'] ?? '(absent)'}`);
      console.log(`    embed CSP：${embedCsp}`);
      console.log(`    /mebular/embed-info：${JSON.stringify(dshInfo.json)}`);
      console.log(`    daemon /app/embed/info keys=${Object.keys(daemonInfo.json ?? {}).join(',')}`);
    },
  },
];

function selectScenarios(requested) {
  if (requested.length === 0) return scenarios;
  const selected = [];
  for (const value of requested) {
    const matches = scenarios.filter((scenario) => scenario.name === value || scenario.name.startsWith(value));
    if (matches.length === 0) {
      throw new Error(`未知场景 ${value}；可选：${scenarios.map((scenario) => scenario.name).join(', ')}`);
    }
    for (const match of matches) if (!selected.includes(match)) selected.push(match);
  }
  return selected;
}

async function runScenario(scenario, context) {
  console.log(`\n────────────────────────────────────────`);
  console.log(`▶ ${scenario.name}：${scenario.title}`);
  console.log(`────────────────────────────────────────`);
  const before = { passed, failed };
  let world = null;
  let failure = null;
  let artifacts = null;

  try {
    world = await createWorld({
      name: scenario.name,
      root: context.root,
      repoRoot,
      dshBin: context.dshBin,
      dshInstall: context.dshInstall,
      dshVersion: context.dshVersion,
      pluginTarball: context.pluginTarball,
      probeTarball: context.probeTarball,
    });
    await scenario.run(world, context);
  } catch (error) {
    failure = error;
    const message = world === null ? String(error?.message ?? error) : world.redact(error?.message ?? error);
    console.log(`\n✗ 场景失败：${message}`);
  } finally {
    if (world !== null) {
      const failedChecks = failed - before.failed;
      const needsArtifacts = failure !== null || failedChecks > 0 || context.keep;
      if (needsArtifacts) {
        artifacts = await world.collectArtifacts(failure?.message ?? (failedChecks > 0 ? `${failedChecks} check(s) failed` : 'keep'));
        if (artifacts.leaks.length > 0) {
          check('artifacts 已脱敏（无敏感片段）', false, JSON.stringify(artifacts.leaks));
          failure ??= new Error('artifact redaction leak');
        } else {
          check('artifacts 已脱敏（无敏感片段）', true, `files=${artifacts.files.length}`);
        }
        console.log(`  artifacts: ${artifacts.dir}`);
        if (failure !== null) {
          console.log(`  daemon log（tail）: ${world.redact(tail(`${world.state.daemon?.stdout ?? ''}\n${world.state.daemon?.stderr ?? ''}`, 1200))}`);
          console.log(`  DSH log（tail）: ${world.redact(tail(`${world.state.dsh?.stdout ?? ''}\n${world.state.dsh?.stderr ?? ''}`, 1200))}`);
        }
      }
      const cleanup = await world.cleanup({ keep: needsArtifacts });
      if (cleanup.retained) console.log(`  临时目录保留：${cleanup.dir}`);
    }
  }

  const passedDelta = passed - before.passed;
  const failedDelta = failed - before.failed;
  const ok = failure === null && failedDelta === 0;
  return {
    name: scenario.name,
    ok,
    passed: passedDelta,
    failed: failedDelta,
    artifacts: artifacts?.dir ?? null,
    failure: failure === null ? null : (world?.redact(failure.message) ?? failure.message),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const scenario of scenarios) console.log(`${scenario.name}\t${scenario.title}`);
    return 0;
  }
  const pluginTarballOverride = options.pluginTarball === null
    ? null
    : await resolvePluginTarballOverride(options.pluginTarball);
  const selected = selectScenarios(options.scenarios);
  const versions = JSON.parse(await readFile(versionsPath, 'utf-8'));
  const dshVersion = resolveDshVersion(options.dshVersion ?? versions.minimum ?? versions.current, versions);
  if (typeof dshVersion !== 'string' || dshVersion.length === 0) {
    throw new Error('versions.json 缺少 minimum/current；请用 --dsh-version 指定');
  }
  const envRoot = typeof process.env.MEBULAR_DSH_E2E_ROOT === 'string'
    ? process.env.MEBULAR_DSH_E2E_ROOT.trim()
    : '';
  const rootRequest = options.root ?? (envRoot.length > 0 ? envRoot : null);

  console.log('DSH 真实 E2E（P0 失败/恢复 + P1 managed/Agent）');
  console.log('========================================');
  console.log(`场景：${selected.map((scenario) => scenario.name).join(', ')}`);
  console.log(`DSH 版本：${dshVersion}`);

  // Static prerequisites. E2E is allowed to fail; it is never allowed to skip.
  const preflight = [];
  const distEntry = join(repoRoot, 'dist', 'index.js');
  preflight.push(check('repo build present（dist/index.js）', existsSync(distEntry), existsSync(distEntry) ? 'dist/index.js' : '先运行 npm ci / npm run build'));
  preflight.push(check('Mebular CLI present', existsSync(mebularBin)));
  preflight.push(check('Console assets present', existsSync(join(repoRoot, 'packages', 'console', 'index.html'))));
  let pnpmVersion = null;
  try {
    pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    pnpmVersion = null;
  }
  preflight.push(check('pnpm available（dsh plugin add 需要）', Boolean(pnpmVersion), pnpmVersion ?? '未找到 pnpm'));
  const chromePath = findChrome();
  preflight.push(check('Chrome/Chromium available', Boolean(chromePath), chromePath ?? '设置 CHROME_PATH'));
  if (preflight.some((value) => value !== true)) {
    console.log('\n前置条件不满足，未启动任何场景。');
    return 1;
  }

  const rootInfo = await prepareRoot(rootRequest);
  const root = rootInfo.dir;
  const packDir = join(root, 'pack');
  const dshInstall = join(root, 'dsh-install');
  await mkdir(packDir, { recursive: true });
  console.log(`临时根目录：${root}${rootInfo.explicit ? '（显式 --root / MEBULAR_DSH_E2E_ROOT）' : ''}`);

  let exitCode = 0;
  try {
    console.log('\n→ 打包 @mebular/dsh-plugin 与 probe（一次，供所有场景使用）');
    let pluginTarball;
    if (pluginTarballOverride !== null) {
      pluginTarball = pluginTarballOverride;
      console.log(`  ↳ 使用 --plugin-tarball 覆盖：${pluginTarball.path}`);
      requireCheck('使用 --plugin-tarball 覆盖插件包', pluginTarball.size > 0, `${pluginTarball.filename} (${pluginTarball.size}B)`);
    } else {
      pluginTarball = await packPackage(pluginDir, packDir, '@mebular/dsh-plugin');
      requireCheck('npm pack @mebular/dsh-plugin', pluginTarball.size > 0, `${pluginTarball.filename} (${pluginTarball.size}B)`);
    }
    const probeTarball = await packPackage(probeDir, packDir, '@mebular/dsh-e2e-probe');
    requireCheck('npm pack probe（测试专用）', probeTarball.size > 0, `${probeTarball.filename} (${probeTarball.size}B)`);

    console.log(`\n→ 安装真实 @deepseek-ai/dsh@${dshVersion} 到临时 prefix（一次）`);
    const install = await runCommand('npm install dsh', 'npm', [
      'install', '--prefix', dshInstall,
      '--no-audit', '--no-fund', '--prefer-offline',
      `@deepseek-ai/dsh@${dshVersion}`,
    ], { timeoutMs: 900000 });
    const installOk = check(
      `npm install @deepseek-ai/dsh@${dshVersion}`,
      install.code === 0,
      install.code === 0 ? `${Math.round(install.elapsedMs / 1000)}s` : tail(install.stderr, 900),
    );
    if (!installOk) {
      console.log(`\nDSH 安装失败，临时根目录保留：${root}`);
      return 1;
    }
    const dshBin = join(dshInstall, 'node_modules', '.bin', 'dsh');
    const binOk = check('dsh binary present', existsSync(dshBin), dshBin);
    if (!binOk) {
      console.log(`\ndsh binary 缺失，临时根目录保留：${root}`);
      return 1;
    }

    const context = {
      root,
      repoRoot,
      dshBin,
      dshInstall,
      dshVersion,
      chromePath,
      keep: options.keep,
      pluginTarball,
      probeTarball,
    };

    const results = [];
    for (const scenario of selected) {
      results.push(await runScenario(scenario, context));
    }

    console.log('\n========================================');
    console.log('场景汇总：');
    for (const result of results) {
      console.log(`  ${result.ok ? '✓' : '✗'} ${result.name}: ${result.passed} passed, ${result.failed} failed${result.failure ? `（${result.failure}）` : ''}`);
    }
    const scenarioFailures = results.filter((result) => !result.ok).length;
    console.log(`${scenarioFailures === 0 ? '✓' : '✗'} DSH E2E：${passed} passed, ${failed} failed；场景 ${results.length - scenarioFailures}/${results.length} 通过`);

    const keepRoot = options.keep || scenarioFailures > 0;
    if (!keepRoot) {
      const cleaned = await cleanupRoot(rootInfo, { keep: false });
      console.log(cleaned.removed
        ? `临时根目录已清理：${root}`
        : `临时根目录保留：${root}`);
    } else {
      console.log(`临时根目录保留：${root}`);
    }
    exitCode = scenarioFailures === 0 ? 0 : 1;
  } finally {
    if (exitCode !== 0 && !options.keep) {
      // Keep a failed root for debugging; success removed above.
      console.log(`若需清理失败现场：rm -rf ${root}`);
    }
  }
  return exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ DSH E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
