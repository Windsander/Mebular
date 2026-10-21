// Mebular 门面：cloud_name / device_name 写入与查询（无网络）。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { POLICY_NAMESPACE } from '../../src/sync/grantPolicy.js';

describe('Mebular 展示名事件', () => {
  let dir: string;
  let app: Mebular;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-names-'));
    master = await new IdentityManager().generateUserMasterKey();
    app = new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-A',
      deviceName: '旧设备名',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });
    await app.initialize();
  });

  afterEach(async () => {
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('setCloudName 写 cloud_name 事件；getCloudName 读派生结果', async () => {
    await app.setCloudName({ name: ' 工作室 ' });
    const events = await app.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    const nameEvent = events.find((event) => event.type === 'cloud_name');
    expect(nameEvent?.data.cloudName).toMatchObject({ v: 1, name: '工作室' });
    expect(await app.getCloudName()).toMatchObject({ name: '工作室', author: 'device-A' });
  });

  it('setDeviceName 写自签名 device_name；getDeviceName / getDeviceNames 读最新值', async () => {
    await app.setDeviceName({ name: '主控笔记本' });
    const events = await app.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    const nameEvent = events.find((event) => event.type === 'device_name');
    expect(nameEvent?.data.deviceName).toMatchObject({
      v: 1, subject: 'device-A', name: '主控笔记本',
    });
    expect(await app.getDeviceName('device-A')).toMatchObject({ name: '主控笔记本' });
    expect(await app.getDeviceNames()).toMatchObject({ 'device-A': { name: '主控笔记本' } });
  });

  it('非法名称拒绝写入；旧事件仍可读', async () => {
    for (const bad of ['', 'a/b', 'a\\b', 'a..b', '忆'.repeat(25)]) {
      await expect(app.setCloudName({ name: bad })).rejects.toMatchObject({
        code: 'VALIDATION_INVALID_ARGUMENT',
      });
      await expect(app.setDeviceName({ name: bad })).rejects.toMatchObject({
        code: 'VALIDATION_INVALID_ARGUMENT',
      });
    }
    expect(await app.getCloudName()).toBeNull();
    expect(await app.getDeviceName('device-A')).toBeNull();
  });
});
