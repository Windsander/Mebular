#!/usr/bin/env node
/**
 * Deterministic contract checks for packages/dsh-plugin.
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
check('version is 0.1.0', pkg.version === '0.1.0', String(pkg.version));
check(
  'description is present',
  pkg.description === 'Mebular memory and task graph for DeepSeek Harness',
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
  'exports["./client"] points at ./client/index.cjs',
  pkg.exports?.['./client'] === './client/index.cjs',
  JSON.stringify(pkg.exports?.['./client']),
);
check(
  'exports["./package.json"] points at ./package.json',
  pkg.exports?.['./package.json'] === './package.json',
  JSON.stringify(pkg.exports?.['./package.json']),
);

const expectedFiles = ['index.js', 'cordis.patch.yml', 'client', 'README.md', 'LICENSE'];
for (const entry of expectedFiles) {
  check(`files includes ${entry}`, Array.isArray(pkg.files) && pkg.files.includes(entry));
}

check(
  'repository.url points at Windsander/Mebular',
  pkg.repository?.url === 'https://github.com/Windsander/Mebular.git',
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
  pkg.dsh?.client?.platform === 'web' && Array.isArray(pkg.dsh?.client?.inject),
  JSON.stringify(pkg.dsh?.client),
);

// The root manifest must stay untouched: no `dsh` field on @mebular/core.
const rootPkg = readJson(join(repoRoot, 'package.json'));
check('root @mebular/core has no dsh field', rootPkg.dsh === undefined);

// ---------------------------------------------------------------------------
// cordis.patch.yml contract
// ---------------------------------------------------------------------------

const patchPath = join(pkgDir, 'cordis.patch.yml');
check('cordis.patch.yml exists', existsSync(patchPath));
const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';

check(
  'patch uses @deepseek-ai/dsh-mcp-client',
  /name:\s*'@deepseek-ai\/dsh-mcp-client'/.test(patch),
);
check(
  "patch mounts the plugin's own host entry",
  /name:\s*'@mebular\/dsh-plugin'/.test(patch),
);
check('patch uses id: mebular for the host entry', /- id:\s*mebular\b/.test(patch));
check('patch uses id: mcp-mebular for the MCP client', /- id:\s*mcp-mebular\b/.test(patch));
const hostEntryAt = patch.indexOf("name: '@mebular/dsh-plugin'");
const mcpClientAt = patch.indexOf("name: '@deepseek-ai/dsh-mcp-client'");
check(
  'patch mounts the host entry before the MCP client',
  hostEntryAt !== -1 && mcpClientAt !== -1 && hostEntryAt < mcpClientAt,
);
check('patch uses streamable-http', /transport:\s*streamable-http/.test(patch));
check('patch registers serverName: mebular', /serverName:\s*mebular\b/.test(patch));
check('patch targets default 127.0.0.1:7331/mcp', /url:\s*http:\/\/127\.0\.0\.1:7331\/mcp/.test(patch));
check('patch does not use stdio transport', !/transport:\s*stdio/.test(patch));
check('patch does not spawn a command', !/^\s*command:\s*/m.test(patch));

// The host entry must be a callable plugin, otherwise the bundle cannot mount.
let pluginModule = {};
try {
  pluginModule = await import(pathToFileURL(join(pkgDir, 'index.js')).href);
} catch (error) {
  check('index.js imports cleanly', false, error.message);
}
check('index.js exports apply()', typeof pluginModule.apply === 'function');

// ---------------------------------------------------------------------------
// Imports: public HTTP only, no workspace coupling
// ---------------------------------------------------------------------------

const codeFiles = walkFiles(pkgDir).filter((file) => /\.(?:js|cjs|mjs)$/.test(file));
check('found plugin code files', codeFiles.length > 0, `${codeFiles.length} files`);

const importPattern = /(?:from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
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

// ---------------------------------------------------------------------------
// README contract (install / verify / port / app independence)
// ---------------------------------------------------------------------------

const readmePath = join(pkgDir, 'README.md');
check('README.md exists', existsSync(readmePath));
const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
check(
  'README documents dsh plugin --profile web add',
  readme.includes('dsh plugin --profile web add @mebular/dsh-plugin'),
);
check('README documents mcp__mebular__* tools', readme.includes('mcp__mebular__*'));
check('README documents default port 7331', readme.includes('7331'));
check('README documents custom URL override', /自定义端口|url:/.test(readme));
check('README states the App keeps running', /App 不会因为安装插件而退出|App 同时保持运行/.test(readme));

// ---------------------------------------------------------------------------
// Publish payload: required files plus an actual npm pack dry run
// ---------------------------------------------------------------------------

const requiredArtifacts = [
  'package.json',
  'index.js',
  'cordis.patch.yml',
  'client/index.cjs',
  'README.md',
  'LICENSE',
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
  for (const artifact of requiredArtifacts) {
    check(
      `tarball contains ${artifact}`,
      packedPaths.some((path) => path === artifact || path === `package/${artifact}`),
      packedPaths.join(', '),
    );
  }
  const unexpected = packedPaths.filter((path) => !requiredArtifacts.includes(path.replace(/^package\//, '')));
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
