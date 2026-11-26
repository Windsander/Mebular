// DSH adapter (W3): detect / package resolution / official-CLI configure /
// idempotency / unknown profile / forbidden paths / version lockstep /
// rollback / dry-run / connectClient hook.
//
// Hermetic: a temporary HOME, a temporary DSH_HOME and a fake `dsh` CLI. The
// real `~/.dsh` is never read or written. This machine has no `dsh` binary, so
// the evidence layer here is the hermetic CLI; the final report states that
// boundary explicitly.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dshAdapter,
  ensurePackage as ensureDshPackage,
  findDshCli,
  PACKAGE_NAME,
  readProfileInstall,
  resolveProfile,
} from '../../packages/mcp/src/adapters/dsh.mjs';
import {
  dryRun,
  ensureAdapter,
  rollbackAdapter,
} from '../../packages/mcp/src/adapter-provision.mjs';
import { adapterStatePath, loadAdapterState } from '../../packages/mcp/src/adapter-state.mjs';
import { connectClient } from '../../packages/mcp/src/clients.mjs';
import { APP_VERSION } from '../../packages/mcp/src/version.mjs';

jest.setTimeout(process.platform === 'win32' ? 30_000 : 20_000);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const repoDshPlugin = join(repoRoot, 'packages', 'dsh-plugin');
const posixIt = process.platform === 'win32' ? it.skip : it;

const FAKE_CLI = `#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
let profile = 'web';
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--profile') profile = argv[index + 1] ?? 'web';
}
if (process.env.FAKE_DSH_LOG) {
  appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify({ argv, profile }) + '\\n');
}
const profileDir = join(process.env.DSH_HOME ?? '.dsh', 'profiles', profile);
const patchPath = join(profileDir, 'cordis.patch.yml');
const packagePath = join(profileDir, 'package.json');
const dump = argv.includes('--dump-config');
const action = argv.includes('add') ? 'add' : argv.includes('remove') ? 'remove' : null;

if (dump) {
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const present = process.env.FAKE_DSH_DUMP_PRESENT === '1' || patch.includes('@mebular/dsh-plugin');
  process.stdout.write(('plugins:\\n' + (present ? "  - name: '@mebular/dsh-plugin'\\n" : '  - name: other\\n')));
  process.exit(0);
}

if (!action) process.exit(0);
mkdirSync(profileDir, { recursive: true });
const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '# patch\\n[]\\n';
const pkg = existsSync(packagePath)
  ? JSON.parse(readFileSync(packagePath, 'utf8'))
  : { name: 'dsh-profile-' + profile, private: true };

if (action === 'add') {
  const target = argv[argv.length - 1];
  pkg.dependencies = { ...(pkg.dependencies ?? {}), '@mebular/dsh-plugin': 'file:' + target };
  if (!patch.includes('@mebular/dsh-plugin')) {
    writeFileSync(patchPath, patch.trimEnd() + "\\n- id: mebular\\n  name: '@mebular/dsh-plugin'\\n  config:\\n    lifecycle: attach\\n");
  }
} else {
  if (process.env.FAKE_DSH_FAIL_REMOVE === '1') process.exit(3);
  if (pkg.dependencies) delete pkg.dependencies['@mebular/dsh-plugin'];
  const kept = patch.split('\\n').filter((line) => !/mebular|lifecycle: attach|config:/.test(line));
  writeFileSync(patchPath, kept.join('\\n'));
}
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\\n');
chmodSync(packagePath, 0o644);
`;

describe('DSH adapter', () => {
  let root;
  let home;
  let userHome;
  let dshHome;
  let profileDir;
  let binDir;
  let cliPath;
  let logPath;
  let pluginDir;

  const baseEnv = () => ({
    PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    DSH_HOME: dshHome,
    FAKE_DSH_LOG: logPath,
  });

  const opts = (extra = {}) => ({
    home,
    userHome,
    dshHome,
    profile: 'web',
    cwd: profileDir,
    env: baseEnv(),
    adapterPackagePath: pluginDir,
    ...extra,
  });

  async function makePlugin(dir, { name = PACKAGE_NAME, version = APP_VERSION } = {}) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js' }));
    await writeFile(join(dir, 'index.js'), 'export const fixture = true;\n');
    return dir;
  }

  async function writeProfile({ patch = '# patch\n[]\n', packageJson } = {}) {
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'cordis.patch.yml'), patch);
    await writeFile(join(profileDir, 'cordis.yml'), '# root\n[]\n');
    await writeFile(
      join(profileDir, 'package.json'),
      packageJson ?? JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} }, null, 2),
    );
  }

  async function cliCalls() {
    try {
      return (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async function backups() {
    try {
      return (await readdir(join(home, 'adapters', 'backups'))).filter((name) => name.startsWith('dsh-profile-'));
    } catch {
      return [];
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adapter-dsh-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    dshHome = join(userHome, '.dsh');
    profileDir = join(dshHome, 'profiles', 'web');
    binDir = join(root, 'bin');
    cliPath = join(binDir, 'dsh');
    logPath = join(root, 'cli.log');
    pluginDir = join(root, 'dsh-plugin-fixture');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await makePlugin(pluginDir);
    await writeFile(cliPath, FAKE_CLI);
    await chmod(cliPath, 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('detect: CLI + canonical web profile; explicit/env/multiple-profile resolution', async () => {
    await writeProfile();
    const detection = await dshAdapter.detect(opts());
    expect(detection.detected).toBe(true);
    expect(detection.cliPath).toBe(cliPath);
    expect(detection.profile).toBe('web');
    expect(detection.profileSource).toBe('option');
    expect(detection.profileUnknown).toBe(false);
    expect(detection.configPath).toBe(join(profileDir, 'cordis.patch.yml'));
    expect(detection.signals.find((signal) => signal.kind === 'cli')?.hit).toBe(true);

    // No PATH → no CLI. Detection still sees the profile.
    const noCli = await dshAdapter.detect({ ...opts(), profile: undefined, env: { DSH_HOME: dshHome } });
    expect(noCli.cliPath).toBeNull();
    expect(noCli.detected).toBe(true);
    expect(noCli.profile).toBe('web');
    expect(noCli.profileSource).toBe('canonical-web');

    await mkdir(join(dshHome, 'profiles', 'sdk'), { recursive: true });
    const canonical = resolveProfile({ env: { DSH_HOME: dshHome } });
    expect(canonical.id).toBe('web');
    expect(canonical.source).toBe('canonical-web');
  });

  it('profile resolution: canonical web, explicit override, and no-web ambiguity', async () => {
    const multiHome = join(root, 'multi-dsh');
    const multiProfiles = join(multiHome, 'profiles');
    const multiEnv = { DSH_HOME: multiHome };

    // web + headless → canonical web (Mebular's DSH web-host plugin).
    for (const name of ['web', 'headless']) {
      // Directories only: resolution is pure and never needs profile internals.
      await mkdir(join(multiProfiles, name), { recursive: true });
    }
    const canonical = resolveProfile({ env: multiEnv });
    expect(canonical).toMatchObject({ id: 'web', source: 'canonical-web' });

    // Explicit profile wins over canonical web.
    const override = resolveProfile({ profile: 'headless', env: multiEnv });
    expect(override).toMatchObject({ id: 'headless', source: 'option' });

    // headless + sdk without web → still fail closed.
    const noWebHome = join(root, 'no-web-dsh');
    for (const name of ['headless', 'sdk']) {
      await mkdir(join(noWebHome, 'profiles', name), { recursive: true });
    }
    const ambiguous = resolveProfile({ env: { DSH_HOME: noWebHome } });
    expect(ambiguous.id).toBeNull();
    expect(ambiguous.source).toBe('ambiguous');
  });

  it('ensurePackage: repository lockstep, wrong version, missing path, bundled dry-run', async () => {
    const manual = await ensureDshPackage({ adapterPackagePath: pluginDir, env: {} });
    expect(manual).toMatchObject({ ok: true, source: 'manual', version: APP_VERSION });
    expect(manual.path).toBe(pluginDir);

    const old = await makePlugin(join(root, 'old-plugin'), { version: '0.0.0' });
    const mismatch = await ensureDshPackage({ adapterPackagePath: old, env: {} });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.code).toBe('ADAPTER_VERSION_MISMATCH');

    const missing = await ensureDshPackage({ adapterPackagePath: join(root, 'missing'), env: {} });
    expect(missing.code).toBe('ADAPTER_PACKAGE_NOT_FOUND');

    const resources = join(root, 'resources');
    await makePlugin(join(resources, 'adapters', 'dsh-plugin'));
    const planned = await ensureDshPackage({
      adapterPackagePath: undefined,
      resourcesPath: resources,
      home,
      env: {},
      dryRun: true,
    });
    expect(planned.ok).toBe(true);
    expect(planned.source).toBe('managed-dir');
    expect(planned.planned).toBe(true);
    expect(planned.path).toBe(join(home, 'adapters', 'dsh-plugin', APP_VERSION));
    expect(existsSync(join(home, 'adapters'))).toBe(false);
  });

  posixIt('configure: official `dsh plugin add` merge, readback, lockstep state', async () => {
    await writeProfile();
    const result = await ensureAdapter('dsh', opts({ connected: true }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('installed');
    expect(result.changed).toBe(true);
    expect(result.activation).toBe('next-start');
    expect(result.version).toBe(APP_VERSION);
    expect(result.source).toBe('manual');

    const calls = await cliCalls();
    const adds = calls.filter((call) => call.argv.includes('add'));
    expect(adds).toHaveLength(1);
    expect(adds[0].argv).toEqual(['plugin', '--profile', 'web', 'add', pluginDir]);

    const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8');
    expect(patch).toContain(PACKAGE_NAME);
    const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies[PACKAGE_NAME]).toBe(`file:${pluginDir}`);
    expect(readProfileInstall(profileDir).present).toBe(true);

    const state = loadAdapterState({ home });
    expect(state.hosts.dsh).toMatchObject({
      detected: true,
      connected: true,
      adapter: 'installed',
      version: APP_VERSION,
      activation: 'next-start',
      lastError: null,
    });
    expect(state.hosts.dsh.configPath).toBe('~/.dsh/profiles/web/cordis.patch.yml');
  });

  posixIt('bundle: stages into <home>/adapters and the CLI receives the managed absolute path', async () => {
    const resources = join(root, 'resources-bundle');
    const bundled = join(resources, 'adapters', 'dsh-plugin');
    await makePlugin(bundled);
    await writeProfile();
    const result = await ensureAdapter('dsh', opts({ adapterPackagePath: undefined, resourcesPath: resources }));
    expect(result.ok).toBe(true);
    expect(result.source).toBe('managed-dir');
    const managed = join(home, 'adapters', 'dsh-plugin', APP_VERSION);
    expect(existsSync(join(managed, 'package.json'))).toBe(true);
    const add = (await cliCalls()).find((call) => call.argv.includes('add'));
    expect(add?.argv.at(-1)).toBe(managed);
    const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies[PACKAGE_NAME]).toBe(`file:${managed}`);

    const second = await ensureAdapter('dsh', opts({ adapterPackagePath: undefined, resourcesPath: resources }));
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.source).toBe('managed-dir');
  });

  posixIt('idempotent: a second ensure does not call the CLI or add a backup', async () => {
    await writeProfile();
    const first = await ensureAdapter('dsh', opts());
    expect(first.changed).toBe(true);
    expect(await backups()).toHaveLength(1);

    const second = await ensureAdapter('dsh', opts());
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect((await cliCalls()).filter((call) => call.argv.includes('add'))).toHaveLength(1);
    expect(await backups()).toHaveLength(1);
  });

  posixIt('unknown profile / missing CLI / unknown structure fail with stable codes', async () => {
    // No profile at all: never guess one.
    const emptyDshHome = join(root, 'empty-dsh');
    const noProfile = await ensureAdapter('dsh', opts({
      profile: undefined,
      dshHome: emptyDshHome,
      connected: true,
      env: { DSH_HOME: emptyDshHome },
    }));
    expect(noProfile.ok).toBe(false);
    expect(noProfile.code).toBe('DSH_PROFILE_UNKNOWN');

    await writeProfile();
    const noCli = await ensureAdapter('dsh', opts({ env: { DSH_HOME: dshHome } }));
    expect(noCli.ok).toBe(false);
    expect(noCli.code).toBe('DSH_CLI_NOT_FOUND');
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8')).not.toContain(PACKAGE_NAME);

    const bare = join(dshHome, 'profiles', 'bare');
    await mkdir(bare, { recursive: true });
    const unknown = await ensureAdapter('dsh', opts({ profileDir: bare, profile: 'bare', connected: true }));
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe('DSH_PROFILE_UNKNOWN');
  });

  posixIt('forbidden path: refuses DSH session storage and never invokes the CLI', async () => {
    const forbidden = join(profileDir, 'sessions');
    await mkdir(forbidden, { recursive: true });
    await writeFile(join(forbidden, 'cordis.patch.yml'), '[]\n');
    await writeFile(join(forbidden, 'package.json'), '{"name":"sessions"}');
    const result = await ensureAdapter('dsh', opts({ profileDir: forbidden, profile: 'sessions', connected: true }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FORBIDDEN_PATH');
    expect(await cliCalls()).toHaveLength(0);
    expect(loadAdapterState({ home }).hosts.dsh).toMatchObject({
      adapter: 'degraded',
      lastError: 'FORBIDDEN_PATH',
    });
  });

  it('version mismatch: old profile dependency is reported, not silently accepted', async () => {
    await writeProfile({
      packageJson: JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { [PACKAGE_NAME]: '0.0.1' },
      }, null, 2),
    });
    const patch = '# patch\n[]\n- id: mebular\n  name: \'@mebular/dsh-plugin\'\n';
    await writeFile(join(profileDir, 'cordis.patch.yml'), patch);
    const verified = await dshAdapter.verify({
      ...opts(),
      packageInfo: { ok: true, path: pluginDir, version: APP_VERSION, source: 'manual' },
    });
    expect(verified.ok).toBe(false);
    expect(verified.code).toBe('VERIFY_VERSION_MISMATCH');
    expect(verified.checks.find((check) => check.name === 'version-lockstep')?.ok).toBe(false);
  });

  posixIt('verify: official `--dump-config` readback is authoritative when the CLI exists', async () => {
    await writeProfile();
    const verified = await dshAdapter.verify({
      ...opts({ env: { ...baseEnv(), FAKE_DSH_DUMP_PRESENT: '1' } }),
      packageInfo: { ok: true, path: pluginDir, version: APP_VERSION, source: 'manual' },
    });
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === 'entry-present')).toMatchObject({ ok: true, source: 'cli' });
  });

  posixIt('rollback: official `dsh plugin remove` when available', async () => {
    await writeProfile();
    const added = await ensureAdapter('dsh', opts());
    expect(added.ok).toBe(true);
    const result = await rollbackAdapter('dsh', opts());
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.status).toBe('absent');
    expect((await cliCalls()).some((call) => call.argv.includes('remove'))).toBe(true);
    const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8');
    expect(patch).not.toContain(PACKAGE_NAME);
    expect(loadAdapterState({ home }).hosts.dsh.adapter).toBe('absent');
  });

  posixIt('rollback: profile backup restores exact bytes when the CLI is gone', async () => {
    await writeProfile();
    const patchBefore = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8');
    const pkgBefore = await readFile(join(profileDir, 'package.json'), 'utf-8');
    const added = await ensureAdapter('dsh', opts());
    expect(added.ok).toBe(true);
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8')).not.toBe(patchBefore);

    const noCli = opts({ env: { DSH_HOME: dshHome }, dshCliPath: undefined });
    const result = await rollbackAdapter('dsh', noCli);
    expect(result.ok).toBe(true);
    expect(result.restoredFrom).toBe('backup');
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8')).toBe(patchBefore);
    expect(await readFile(join(profileDir, 'package.json'), 'utf-8')).toBe(pkgBefore);
  });

  posixIt('dry-run: plans the CLI command but writes no profile, backup, state or log', async () => {
    await writeProfile();
    const patchBefore = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8');
    const result = await dryRun('dsh', opts());
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('planned');
    expect(result.changed).toBe(true);
    expect(result.preview).toContain(`dsh plugin --profile web add ${pluginDir}`);
    expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8')).toBe(patchBefore);
    expect(await backups()).toHaveLength(0);
    expect(existsSync(adapterStatePath(home))).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });

  posixIt('connectClient(dsh): additive adapter field; MCP connect survives adapter failure', async () => {
    await writeProfile();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const mcpPath = join(workspace, '.dsh', 'cordis.yml');
    const base = {
      home,
      userHome,
      cwd: workspace,
      env: baseEnv(),
      skipSkills: true,
      mcpUrl: 'http://127.0.0.1:7331/mcp',
    };
    const ok = await connectClient('dsh', { ...base, adapterPackagePath: pluginDir });
    expect(ok.ok).toBe(true);
    expect(ok.adapter?.ok).toBe(true);
    expect(await readFile(mcpPath, 'utf-8')).toContain('serverName: mebular');
    expect((await readFile(join(profileDir, 'cordis.patch.yml'), 'utf-8'))).toContain(PACKAGE_NAME);

    const failed = await connectClient('dsh', { ...base, adapterPackagePath: join(root, 'missing-plugin') });
    expect(failed.ok).toBe(true);
    expect(failed.adapter?.ok).toBe(false);
    expect(failed.adapter?.code).toBe('ADAPTER_PACKAGE_NOT_FOUND');
    expect(loadAdapterState({ home }).hosts.dsh).toMatchObject({
      connected: true,
      adapter: 'degraded',
      lastError: 'ADAPTER_PACKAGE_NOT_FOUND',
    });
  });

  it('hermetic boundary: injected env without PATH never discovers the real CLI', () => {
    expect(findDshCli({ env: {} })).toBeNull();
  });

  it('real @mebular/dsh-plugin: lockstep manifest resolves from this repository', async () => {
    const result = await ensureDshPackage({ adapterPackagePath: repoDshPlugin, env: {} });
    expect(result.ok).toBe(true);
    const manifest = JSON.parse(await readFile(join(repoDshPlugin, 'package.json'), 'utf-8'));
    expect(manifest.name).toBe(PACKAGE_NAME);
    expect(manifest.version).toBe(APP_VERSION);
  });
});
