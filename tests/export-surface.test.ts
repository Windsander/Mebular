// 公共导出表面锁定（Phase 6.0）：防 D11 死代码回流、防核心出口误删、
// 锁定 ErrorCodes 注册完整性（新码一律入册，不再产生裸字符串）。

import * as MebularModule from '../src/index.js';
import { ErrorCodes } from '../src/errors.js';

const surface = MebularModule as Record<string, unknown>;

describe('公共导出表面', () => {
  it('D11 废弃的死代码不再导出', () => {
    expect(surface['SignatureManager']).toBeUndefined();
    expect(surface['EncryptionManager']).toBeUndefined();
  });

  it('核心出口保持稳定', () => {
    const core = [
      'Mebular',
      'GraphStore',
      'MemoryStorage',
      'JsonFileStorage',
      'EventLog',
      'SyncManager',
      'VectorClock',
      'IdentityManager',
      'MemoryStore',
      'HermesMemoryProvider',
      'MebularError',
      'ErrorCodes',
    ];
    for (const key of core) {
      expect(surface[key]).toBeDefined();
    }
  });

  it('Phase 5 遗留裸字符串错误码全部入册', () => {
    const phase5Codes = [
      'NETWORK_LIBP2P_NOT_AVAILABLE',
      'NETWORK_FRAME_TOO_LARGE',
      'NETWORK_PEER_IDENTITY_UNSUPPORTED',
      'CMF_FORMAT_INVALID',
      'CMF_VERSION_UNSUPPORTED',
      'ADAPTER_DUPLICATE',
      'ADAPTER_NOT_FOUND',
      'MEBULAR_NOT_INITIALIZED',
    ] as const;
    for (const code of phase5Codes) {
      expect(ErrorCodes[code as keyof typeof ErrorCodes]).toBe(code);
    }
  });

  it('GraphStore 不再暴露 signatureManager 缝隙与 snapshot/merge 遗留', () => {
    const proto: object = MebularModule.GraphStore.prototype;
    expect('snapshot' in proto).toBe(false);
    expect('merge' in proto).toBe(false);
    // 配置接口不再接受 signatureManager（运行时鸭子类型检查：
    // 传入多余字段不报错，但实现内不得读取——由源码审查与类型层保证）
  });
});
