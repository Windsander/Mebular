// W2 夹具：一机一节点（identity/store 模式字段先行）。
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('W2 daemon-home 夹具', () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'packages/fleet/protocol/daemon-home.example.json'), 'utf-8')) as Record<string, any>;

  it('identity/store 模式取值受控，守护/客户端字段齐备', () => {
    expect(fixture.modes.identity).toEqual(['root', 'delegated']);
    expect(fixture.modes.store).toEqual(['daemon', 'embedded']);
    expect(fixture.daemonConfig.identity.mode).toBe('root');
    expect(fixture.daemonConfig.joinService.enabled).toBe(true);
    expect(Array.isArray(fixture.daemonConfig.sync.policyIssuers)).toBe(true);
    expect(fixture.delegatedDaemonConfig.identity.mode).toBe('delegated');
    expect(fixture.delegatedDaemonConfig.encryption.userMasterPublicKeyFile).toBeTruthy();
    expect(fixture.fleetClientConfig.store).toBe('daemon');
    expect(fixture.fleetClientConfig.daemon.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});
