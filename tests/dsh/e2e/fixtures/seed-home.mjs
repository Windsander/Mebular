// Seed an initialized, disposable Mebular home for the real DSH E2E.
//
// Everything is written under the caller-supplied directory: identity, config,
// one default 忆云 registry entry, one namespace, and one memory whose content
// contains a per-run token. The harness asserts that the token comes back
// through a real DSH tool invocation, not from a fixture served to the browser.
//
// Usage:
//   node tests/dsh/e2e/fixtures/seed-home.mjs <home>
//
// The JSON result is printed to stdout; all Mebular paths use the explicit
// home, so the script never reads the developer's ~/.mebular.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CLOUD_NAME = 'DSH E2E 忆云';
const DEFAULT_NAMESPACE = 'dsh-e2e';

export async function seedHome(home, options = {}) {
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('seedHome requires an absolute home directory');
  }
  const namespace = typeof options.namespace === 'string' && options.namespace.length > 0
    ? options.namespace
    : DEFAULT_NAMESPACE;
  const cloudName = typeof options.cloudName === 'string' && options.cloudName.length > 0
    ? options.cloudName
    : DEFAULT_CLOUD_NAME;
  const memoryToken = typeof options.memoryToken === 'string' && options.memoryToken.length > 0
    ? options.memoryToken
    : `dsh-e2e-seed-${randomUUID()}`;
  const memoryContent = `DSH E2E seed memory ${memoryToken}`;

  await mkdir(home, { recursive: true });

  const { Mebular, IdentityManager, MemoryService } = await import('@mebular/core');

  const master = await new IdentityManager().generateUserMasterKey();
  const publicKeyBase64 = Buffer.from(master.publicKey).toString('base64');
  const masterFingerprint = `sha256:${createHash('sha256').update(Buffer.from(master.publicKey)).digest('hex').slice(0, 12)}`;
  const keyFile = join(home, 'user-master-key.json');
  await writeFile(keyFile, JSON.stringify({
    publicKey: publicKeyBase64,
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  const storagePath = join(home, 'store.jsonl');
  const deviceId = 'device-dsh-e2e';
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath,
    storageAdapter: 'json',
    deviceId,
    encryption: { level: 'none', keyFile },
    network: { enabled: false, libp2p: { listen: [], relayServers: [], relayUnlimited: false } },
    sync: { autoSync: false, pushOnWrite: false, antiEntropy: { enabled: false } },
    semantic: { enabled: false, minScore: 0.2 },
    mcp: {
      http: {
        host: '127.0.0.1',
        // The harness passes --port with a free port; runtime.json carries the
        // actual value the plugin must discover.
        port: 0,
        auth: 'none',
        tls: false,
        tokensFile: join(home, 'auth', 'tokens.json'),
      },
    },
    joinService: { enabled: false },
  }, null, 2), 'utf-8');

  const app = new Mebular({
    storagePath,
    deviceId,
    encryption: {
      level: 'none',
      userMasterKey: master.publicKey,
      userMasterPrivateKey: master.privateKey,
    },
    network: { enabled: false },
    sync: { autoSync: false, namespaces: [namespace] },
  });

  let stored = null;
  let cloudNameWritten = false;
  try {
    await app.initialize();
    await app.declareNamespace({ namespace, note: 'DSH E2E fixture namespace' });
    await app.subscribeNamespace(namespace);
    try {
      await app.setCloudName({ name: cloudName });
      cloudNameWritten = true;
    } catch {
      // Naming is cosmetic for the fixture; the memory/tool path is what matters.
    }
    stored = await new MemoryService(app).write([{
      type: 'fact',
      content: memoryContent,
      metadata: { tags: ['dsh-e2e'], namespace },
    }]);
  } finally {
    await app.shutdown().catch(() => undefined);
  }

  const memory = Array.isArray(stored) && stored.length > 0 ? stored[0] : null;
  if (memory === null || typeof memory.id !== 'string') {
    throw new Error('seedHome: memory write did not return a stored node');
  }

  const now = new Date().toISOString();
  await writeFile(join(home, 'profiles.json'), JSON.stringify({
    v: 1,
    current: 'default',
    profiles: [{
      id: 'default',
      name: cloudName,
      home: '.',
      kind: 'root',
      createdAt: now,
      lastUsedAt: now,
      masterFingerprint,
      deviceId,
    }],
  }, null, 2), 'utf-8');

  return {
    home,
    storagePath,
    deviceId,
    namespace,
    cloudName,
    cloudNameWritten,
    masterFingerprint,
    memoryId: memory.id,
    memoryToken,
    memoryContent,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = process.argv[2];
  if (!home) {
    console.error('用法：node tests/dsh/e2e/fixtures/seed-home.mjs <home>');
    process.exit(2);
  }
  const result = await seedHome(home);
  console.log(JSON.stringify(result, null, 2));
}
