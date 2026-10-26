#!/usr/bin/env node
/**
 * Deterministic contract checks for packages/dsh-plugin.
 *
 * The plugin is a zero-build DSH bundle that:
 *   - mounts one `mebular` host row;
 *   - discovers the daemon at runtime (no daemonUrl in the patch);
 *   - dynamically mounts the official @deepseek-ai/dsh-mcp-client peer;
 *   - embeds the shared Mebular Console through GET /mebular/embed-info.
 *
 * Uses Node standard library only (plus the locally installed `npm` binary for
 * a dry-run tarball listing). Never touches the network and never writes files.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(repoRoot, 'packages', 'dsh-plugin');
const pkgJsonPath = join(pkgDir, 'package.json');

const failures = [];
let passed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`ok   ${label}`);
    return;
  }
  failures.push(detail ? `${label}: ${detail}` : label);
  console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// package.json contract
// ---------------------------------------------------------------------------

check('packages/dsh-plugin/package.json exists', existsSync(pkgJsonPath));

let pkg = {};
if (existsSync(pkgJsonPath)) {
  try {
    pkg = readJson(pkgJsonPath);
  } catch (error) {
    check('package.json is valid JSON', false, error.message);
  }
}

check('name is @mebular/dsh-plugin', pkg.name === '@mebular/dsh-plugin', String(pkg.name));
check('version is a semver string', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(pkg.version)), String(pkg.version));
check(
  'description is present',
  typeof pkg.description === 'string' && pkg.description.length > 0,
  String(pkg.description),
);
check('license is MIT', pkg.license === 'MIT', String(pkg.license));
check('type is module', pkg.type === 'module', String(pkg.type));
check('main is index.js', pkg.main === 'index.js', String(pkg.main));
check('no install/build scripts', pkg.scripts === undefined, JSON.stringify(pkg.scripts));

check(
  'exports["."] points at ./index.js',
  pkg.exports?.['.'] === './index.js',
  JSON.stringify(pkg.exports?.['.']),
);
check(
  'exports["./client"] points at ./client.js',
  pkg.exports?.['./client'] === './client.js',
  JSON.stringify(pkg.exports?.['./client']),
);
check(
  'exports["./package.json"] points at ./package.json',
  pkg.exports?.['./package.json'] === './package.json',
  JSON.stringify(pkg.exports?.['./package.json']),
);
check(
  'exports["./locale/*"] points at ./locale/*',
  pkg.exports?.['./locale/*'] === './locale/*',
  JSON.stringify(pkg.exports?.['./locale/*']),
);

const expectedFiles = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'locale',
  'README.md',
  'LICENSE',
  'icon.svg',
  'screenshots.json',
  'assets',
];
for (const entry of expectedFiles) {
  check(`files includes ${entry}`, Array.isArray(pkg.files) && pkg.files.includes(entry));
}

check(
  'repository.url points at Windsander/Mebular',
  pkg.repository?.url === 'git+https://github.com/Windsander/Mebular.git',
  String(pkg.repository?.url),
);
check(
  'repository.directory is packages/dsh-plugin',
  pkg.repository?.directory === 'packages/dsh-plugin',
  String(pkg.repository?.directory),
);
check('publishConfig.access is public', pkg.publishConfig?.access === 'public');

const expectedKeywords = ['dsh-plugin', 'deepseek-harness', 'mebular', 'mcp', 'agent-memory'];
check(
  'keywords contain the DSH discovery terms',
  Array.isArray(pkg.keywords) && expectedKeywords.every((word) => pkg.keywords.includes(word)),
  JSON.stringify(pkg.keywords),
);

check(
  'dsh.bundle.patch is ./cordis.patch.yml',
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  String(pkg.dsh?.bundle?.patch),
);
check(
  'dsh.client is the safe web placeholder',
  pkg.dsh?.client?.platform === 'web'
    && Array.isArray(pkg.dsh?.client?.inject)
    && pkg.dsh.client.inject.length === 0,
  JSON.stringify(pkg.dsh?.client),
);

check(
  'engines.node is >=22.19',
  pkg.engines?.node === '>=22.19',
  String(pkg.engines?.node),
);
check(
  'engines.dsh is >=0.2.1-rc.2 <0.3.0',
  pkg.engines?.dsh === '>=0.2.1-rc.2 <0.3.0',
  String(pkg.engines?.dsh),
);

const expectedPeer = {
  '@deepseek-ai/dsh-mcp-client': '>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0',
};
check(
  'only the official MCP client is a peer',
  JSON.stringify(pkg.peerDependencies ?? {}) === JSON.stringify(expectedPeer),
  JSON.stringify(pkg.peerDependencies),
);
check('no dependencies', Object.keys(pkg.dependencies ?? {}).length === 0, JSON.stringify(pkg.dependencies));
check(
  'no optional dependencies',
  Object.keys(pkg.optionalDependencies ?? {}).length === 0,
  JSON.stringify(pkg.optionalDependencies),
);
check('no dev dependencies', Object.keys(pkg.devDependencies ?? {}).length === 0, JSON.stringify(pkg.devDependencies));
check('peerDependenciesMeta is absent', pkg.peerDependenciesMeta === undefined);

// The root manifest must stay untouched: no `dsh` field on @mebular/core.
const rootPkg = readJson(join(repoRoot, 'package.json'));
check('root @mebular/core has no dsh field', rootPkg.dsh === undefined);

// ---------------------------------------------------------------------------
// cordis.patch.yml contract
// ---------------------------------------------------------------------------

const patchPath = join(pkgDir, 'cordis.patch.yml');
check('cordis.patch.yml exists', existsSync(patchPath));
const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';

check('patch inserts a plugin row', /^-\s+insert:/m.test(patch));
check("patch mounts the plugin's host entry", /name:\s*'@mebular\/dsh-plugin'/.test(patch));
check('patch uses id: mebular for the host entry', /- id:\s*mebular\b/.test(patch));
check('patch uses lifecycle: attach', /lifecycle:\s*attach/.test(patch));
check('patch uses panel: true', /panel:\s*true/.test(patch));
// The MCP client is mounted by the host at apply time from the discovered URL.
// A static row or a URL here would let the panel and the bridge disagree.
check('patch does not mount @deepseek-ai/dsh-mcp-client statically', !patch.includes('@deepseek-ai/dsh-mcp-client'));
check('patch has no MCP row id', !/id:\s*mcp-mebular\b/.test(patch));
check('patch has no daemonUrl config', !/daemonUrl\s*:/.test(patch));
check('patch has no url config', !/^\s*url\s*:/m.test(patch));
check('patch has no serverName/transport', !/serverName:|transport:/.test(patch));
check('patch does not use stdio transport', !/transport:\s*stdio/.test(patch));
check('patch does not spawn a command', !/^\s*command:\s*/m.test(patch));
check('patch does not use dynamic !!js values', !/!!js/.test(patch));
check('patch contains no store/auth/secret settings', !/store\.jsonl|auth|token|secret/i.test(patch));

// The host entry must be a callable plugin, otherwise the bundle cannot mount.
let pluginModule = {};
try {
  pluginModule = await import(pathToFileURL(join(pkgDir, 'index.js')).href);
} catch (error) {
  check('index.js imports cleanly', false, error.message);
}
check('index.js exports name', pluginModule.name === '@mebular/dsh-plugin', String(pluginModule.name));
check('index.js exports apply()', typeof pluginModule.apply === 'function');
check('index.js exports mountMcp()', typeof pluginModule.mountMcp === 'function');
check('index.js exports resolveConfig()', typeof pluginModule.resolveConfig === 'function');
check('index.js exports createDaemonLifecycle()', typeof pluginModule.createDaemonLifecycle === 'function');
check('index.js exports createEmbedInfoHandler()', typeof pluginModule.createEmbedInfoHandler === 'function');
check('index.js exports createRuntimeInstallManager()', typeof pluginModule.createRuntimeInstallManager === 'function');
check('index.js exports createRuntimeInstallHandler()', typeof pluginModule.createRuntimeInstallHandler === 'function');
check('index.js exports detectRegisteredRuntimeService()', typeof pluginModule.detectRegisteredRuntimeService === 'function');
check('index.js exports sanitizeRuntimeInstallState()', typeof pluginModule.sanitizeRuntimeInstallState === 'function');
check(
  'index.js pinned runtime version tracks the plugin version',
  pluginModule.RUNTIME_INSTALL_VERSION === pkg.version,
  `${String(pluginModule.RUNTIME_INSTALL_VERSION)} != ${String(pkg.version)}`,
);
check(
  'index.js exposes the loopback install route',
  pluginModule.RUNTIME_INSTALL_PATH === '/mebular/runtime/install',
  String(pluginModule.RUNTIME_INSTALL_PATH),
);
check('index.js exports agentStatusText()', typeof pluginModule.agentStatusText === 'function');
check('index.js exports createAgentStatus()', typeof pluginModule.createAgentStatus === 'function');

// ---------------------------------------------------------------------------
// Imports: public HTTP only, no workspace coupling
// ---------------------------------------------------------------------------

const codeFiles = walkFiles(pkgDir).filter((file) => /\.(?:js|cjs|mjs)$/.test(file));
check('found plugin code files', codeFiles.length > 0, `${codeFiles.length} files`);

const importPattern = /(?:from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
const staticImportPattern = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
for (const file of codeFiles) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(repoRoot, file);
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    check(`${rel} does not import @mebular/*`, !specifier.startsWith('@mebular/'), specifier);
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      const insidePlugin = target === pkgDir || target.startsWith(`${pkgDir}${sep}`);
      check(`${rel} stays inside packages/dsh-plugin`, insidePlugin, specifier);
      check(`${rel} does not climb two levels`, !specifier.startsWith('../..'), specifier);
    }
  }
}

const hostSource = readFileSync(join(pkgDir, 'index.js'), 'utf8');
check(
  'host registers the mebular:status prompt section',
  hostSource.includes("AGENT_STATUS_SECTION = 'mebular:status'"),
);
check('host feature-detects the optional systemPrompt service', /ctx\.systemPrompt/.test(hostSource));
check(
  "host injects the optional systemPrompt service",
  /ctx\.inject\(\['systemPrompt'\]/.test(hostSource),
);
check('host notifies system-prompt/change', hostSource.includes("'system-prompt/change'"));
check('host adds no mebular_status MCP tool', !hostSource.includes('mebular_status'));
const staticHostImports = [...hostSource.matchAll(staticImportPattern)].map((match) => match[1]);
check(
  'host static imports are Node builtins only',
  staticHostImports.length > 0 && staticHostImports.every((specifier) => specifier.startsWith('node:')),
  staticHostImports.join(', '),
);
const dynamicHostImports = [...hostSource.matchAll(/await import\(\s*['"]([^'"]+)['"]\s*\)/g)]
  .map((match) => match[1]);
check(
  'host dynamically imports only the official MCP client',
  dynamicHostImports.length === 1 && dynamicHostImports[0] === '@deepseek-ai/dsh-mcp-client',
  dynamicHostImports.join(', '),
);

// ---------------------------------------------------------------------------
// client.js contract
// ---------------------------------------------------------------------------

const clientPath = join(pkgDir, 'client.js');
check('client.js exists', existsSync(clientPath));
const clientSource = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : '';
check('client uses window.__ModuleLoader__.load', clientSource.includes('window.__ModuleLoader__.load({'));
check(
  "client registers the package id '@mebular/dsh-plugin'",
  /id:\s*'@mebular\/dsh-plugin'/.test(clientSource),
);
check('client has a factory(require) wrapper', /factory:\s*\(require\)\s*=>/.test(clientSource));
check('client registers sidebar.panellist', clientSource.includes("ctx.slots.inject('sidebar.panellist'"));
check('client registers main', clientSource.includes("ctx.slots.inject('main'"));
check('client uses sidebar id mebular', /id:\s*'mebular'/.test(clientSource));
check('client uses main key mebular', /key:\s*'mebular'/.test(clientSource));
check('client reads /mebular/embed-info', clientSource.includes('/mebular/embed-info'));
check('client embeds the shared Console (?embed=dsh)', clientSource.includes('?embed=dsh'));
check('client uses a sandboxed iframe', clientSource.includes("sandbox: 'allow-scripts allow-same-origin allow-forms'"));
check('client honours panel:false', clientSource.includes('__MEBULAR_DSH__') && /panel\s*===\s*false/.test(clientSource));
check('client handles managed start states', clientSource.includes('managed_cli_missing') && clientSource.includes('managed_start_failed'));
check('client offers the plugin-only install action', clientSource.includes("'/mebular/runtime/install'"));
check('client posts only the install action', /body:\s*JSON\.stringify\(\{\s*action\s*\}\)/.test(clientSource));
check('client has exactly one POST method', (clientSource.match(/method:\s*'POST'/g) ?? []).length === 1);
check('client has no other write methods', !/method:\s*'(?:PUT|PATCH|DELETE)'/.test(clientSource));
check('client shows install/retry/reinstall/copy/redetect actions', [
  'installTitle', 'installingTitle', 'installFailedTitle', 'installAction', 'installRetry',
  'installReinstall', 'installCopy', 'installRedetect', 'installManualHint', 'installReadme',
].every((key) => clientSource.includes(key)));
check('client copies the manual command locally', clientSource.includes('navigator?.clipboard?.writeText'));
check(
  'client never triggers install from the poll timer',
  !/setInterval\([\s\S]{0,120}install\(/.test(clientSource),
);
check('client does not post write requests through DSH', !clientSource.includes('mebular:request') && !clientSource.includes('postMessage'));

const clientRequires = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)]
  .map((match) => match[1]);
check('client requires only react', clientRequires.length === 1 && clientRequires[0] === 'react', clientRequires.join(', '));
check('client has no JSX build dependency', !clientSource.includes('react/jsx-runtime') && !clientSource.includes('from \'react\''));

// ---------------------------------------------------------------------------
// README contract (install / verify / tools / shared Console / port / lifecycle)
// ---------------------------------------------------------------------------

const readmePath = join(pkgDir, 'README.md');
check('README.md exists', existsSync(readmePath));
const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
check(
  'README documents local install from ./packages/dsh-plugin',
  readme.includes('dsh plugin --profile web add ./packages/dsh-plugin'),
);
check('README documents the npm name', readme.includes('@mebular/dsh-plugin'));
check(
  'README documents npm install',
  /dsh plugin --profile web add @mebular\/dsh-plugin@\d+\.\d+\.\d+/.test(readme),
);
check(
  'README does not claim the npm package is unpublished',
  !readme
    .split(/\n\s*\n/)
    .some((paragraph) => /@mebular\/dsh-plugin/.test(paragraph) && /未发布|not published/i.test(paragraph)),
);
check('README documents mcp__mebular__* tools', readme.includes('mcp__mebular__*'));
check('README documents the shared Console', /共享.*Console|Console.*同一/.test(readme));
check('README documents app independence', /App.*(继续|独立)|Mebular daemon.*(继续|独立)/.test(readme));
check('README documents default port 7331', readme.includes('7331'));
check('README documents runtime discovery', readme.includes('runtime.json'));
check('README documents MEBULAR_HTTP_PORT', readme.includes('MEBULAR_HTTP_PORT'));
check('README documents attach and managed', /attach/.test(readme) && /managed/.test(readme));
check('README documents panel:false', /panel\s*:\s*false|panel:false/.test(readme));
check('README documents uninstall', readme.includes('dsh plugin --profile web remove'));

// ---------------------------------------------------------------------------
// Publish payload: required files plus an actual npm pack dry run
// ---------------------------------------------------------------------------

const requiredArtifacts = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'README.md',
  'LICENSE',
  'icon.svg',
  'screenshots.json',
  'assets/icon-180.png',
  'assets/dsh-panel.jpg',
  'assets/console-starmap.jpg',
];
for (const artifact of requiredArtifacts) {
  check(`artifact ${artifact} exists`, existsSync(join(pkgDir, artifact)));
}

const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: pkgDir,
  encoding: 'utf8',
  env: { ...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
});

let packedPaths = null;
if (pack.error) {
  check('npm pack --dry-run runs', false, pack.error.message);
} else if (pack.status !== 0) {
  check('npm pack --dry-run succeeds', false, (pack.stderr || pack.stdout || '').trim());
} else {
  try {
    const result = JSON.parse(pack.stdout);
    const entry = Array.isArray(result) ? result[0] : result;
    packedPaths = entry?.files?.map((file) => file.path);
    check('npm pack --dry-run returns a file list', Array.isArray(packedPaths));
  } catch (error) {
    check('npm pack --dry-run output is valid JSON', false, error.message);
  }
}

if (packedPaths) {
  const normalized = packedPaths.map((path) => path.replace(/^package\//, ''));
  for (const artifact of requiredArtifacts) {
    check(`tarball contains ${artifact}`, normalized.includes(artifact), normalized.join(', '));
  }
  check(
    'tarball does not contain the old client/index.cjs',
    !normalized.includes('client/index.cjs'),
    normalized.join(', '),
  );
  const unexpected = normalized.filter((path) => !requiredArtifacts.includes(path));
  check('tarball contains only declared artifacts', unexpected.length === 0, unexpected.join(', '));
}

// ---------------------------------------------------------------------------

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed, ${passed} passed`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log(`All ${passed} checks passed`);
