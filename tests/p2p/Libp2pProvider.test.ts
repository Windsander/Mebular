// libp2p 传输适配器测试
//
// 分层：
// 1. 帧编解码——纯函数，不依赖 libp2p 包
// 2. 模块加载——注入失败 importer 验证缺包时的诚实报错
// 3. 身份映射与真实集成——需要可选依赖；缺失时自动跳过

import { existsSync } from 'fs';
import { join } from 'path';
import { MebularError } from '../../src/errors.js';
import {
  FrameDecoder,
  Libp2pProvider,
  MAX_FRAME_BYTES,
  MEBULAR_PROTOCOL,
  encodeFrame,
  fromLibp2pPeerId,
  loadLibp2pModules,
  peerIdFromDevicePublicKey,
  toLibp2pPeerId,
  type ModuleImporter,
} from '../../src/p2p/transport/Libp2pProvider.js';
import { P2PNode } from '../../src/p2p/P2PNetwork.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from './helpers.js';

// 可选依赖探测（收集期同步判定）：包缺失时集成用例记为 skip，而非静默通过。
// 注意不能用 require.resolve：libp2p 系是纯 ESM 包，exports 不带 require 条件，
// 会误报缺失；这里直接探测 node_modules 目录存在性。
function libp2pPackagesInstalled(): boolean {
  const specs = [
    'libp2p',
    '@libp2p/tcp',
    '@chainsafe/libp2p-noise',
    '@chainsafe/libp2p-yamux',
    '@libp2p/crypto',
    '@libp2p/peer-id',
    '@multiformats/multiaddr',
  ];
  const root = join(process.cwd(), 'node_modules');
  return specs.every((spec) => existsSync(join(root, spec)));
}
const LIBP2P_INSTALLED = libp2pPackagesInstalled();
const itIfAvailable = LIBP2P_INSTALLED ? it : it.skip;

// ---------- 帧编解码（纯函数） ----------

describe('长度前缀帧编解码', () => {
  it('encodeFrame 生成 4 字节大端长度前缀 + 载荷', () => {
    const payload = new TextEncoder().encode('hello');
    const frame = encodeFrame(payload);
    expect(frame.byteLength).toBe(4 + 5);
    expect(new DataView(frame.buffer).getUint32(0, false)).toBe(5);
    expect(new TextDecoder().decode(frame.slice(4))).toBe('hello');
  });

  it('解码器整块还原单帧', () => {
    const decoder = new FrameDecoder();
    const payload = new TextEncoder().encode('frame-one');
    const frames = decoder.push(encodeFrame(payload));
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0])).toBe('frame-one');
  });

  it('解码器切开粘包的多帧', () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame(new TextEncoder().encode('AAA'));
    const b = encodeFrame(new TextEncoder().encode('BBBB'));
    const merged = new Uint8Array(a.byteLength + b.byteLength);
    merged.set(a, 0);
    merged.set(b, a.byteLength);
    const frames = decoder.push(merged);
    expect(frames.map((f) => new TextDecoder().decode(f))).toEqual(['AAA', 'BBBB']);
  });

  it('解码器缓冲被任意切分的半帧', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(new TextEncoder().encode('split-me-please'));
    expect(decoder.push(frame.slice(0, 3))).toEqual([]); // 长度前缀都没齐
    expect(decoder.push(frame.slice(3, 10))).toEqual([]); // 载荷不齐
    const frames = decoder.push(frame.slice(10));
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0])).toBe('split-me-please');
  });

  it('空载荷帧可以往返', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(new Uint8Array(0)));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.byteLength).toBe(0);
  });

  it('编码侧拒绝超限载荷', () => {
    expect(() => encodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(MebularError);
  });

  it('解码侧拒绝越界长度前缀', () => {
    const decoder = new FrameDecoder();
    const evil = new Uint8Array(4);
    new DataView(evil.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    expect(() => decoder.push(evil)).toThrow(MebularError);
  });
});

// ---------- 模块加载 ----------

describe('可选依赖加载', () => {
  it('任一模块缺失时抛 NETWORK_LIBP2P_NOT_AVAILABLE 并附安装提示', async () => {
    const failingImporter: ModuleImporter = (specifier) => {
      if (specifier === '@libp2p/tcp') {
        return Promise.reject(new Error('Cannot find module'));
      }
      return Promise.resolve({});
    };
    const failure = loadLibp2pModules(failingImporter).then(
      () => null,
      (error: unknown) => error,
    );
    const error = (await failure) as MebularError;
    expect(error).toBeInstanceOf(MebularError);
    expect(error.code).toBe('NETWORK_LIBP2P_NOT_AVAILABLE');
    expect(error.message).toContain('@libp2p/tcp');
  });

  itIfAvailable('真实环境可加载全部模块', async () => {
    const modules = await loadLibp2pModules();
    expect(typeof modules.createLibp2p).toBe('function');
    expect(typeof modules.generateKeyPairFromSeed).toBe('function');
  }, 30000);
});

// ---------- 身份映射 ----------

describe('PeerId 映射', () => {
  it('peerIdFromDevicePublicKey 与测试辅助的派生算法一致', async () => {
    const { peerId, identity } = await createTestIdentity('device-map');
    const derived = peerIdFromDevicePublicKey(identity.devicePublicKey);
    expect(derived.id).toBe(peerId.id);
    expect(Buffer.from(derived.pubKey).equals(Buffer.from(identity.devicePublicKey))).toBe(true);
  });

  itIfAvailable('我方 PeerId ↔ libp2p PeerId 往返一致', async () => {
    const modules = await loadLibp2pModules();
    const { peerId } = await createTestIdentity('device-roundtrip');
    const libp2pPeerId = toLibp2pPeerId(peerId, modules);
    expect(libp2pPeerId.toString()).toMatch(/^12D3KooW/); // Ed25519 identity peer id 前缀
    const back = fromLibp2pPeerId(libp2pPeerId);
    expect(back.id).toBe(peerId.id);
  }, 30000);

  it('拒绝未内嵌 Ed25519 公钥的 peer id', () => {
    const foreign = {
      toString: () => 'fake-peer',
      publicKey: { type: 'secp256k1', raw: new Uint8Array(33) },
    };
    expect(() => fromLibp2pPeerId(foreign)).toThrow(MebularError);
    expect(() => fromLibp2pPeerId(foreign)).toThrow(
      expect.objectContaining({ code: 'NETWORK_PEER_IDENTITY_UNSUPPORTED' }),
    );
  });
});

// ---------- 真实 loopback 集成 ----------

describe('Libp2pProvider 双节点集成（真实 TCP）', () => {
  itIfAvailable('显式 multiaddr 直连，双向收发，帧边界完整', async () => {
    const identityA = await createTestIdentity('device-a');
    const identityB = await createTestIdentity('device-b');
    const providerA = await Libp2pProvider.create({
      deviceKey: { publicKey: identityA.identity.devicePublicKey, privateKey: identityA.identity.devicePrivateKey },
      listen: ['/ip4/127.0.0.1/tcp/0'],
    });
    const providerB = await Libp2pProvider.create({
      deviceKey: { publicKey: identityB.identity.devicePublicKey, privateKey: identityB.identity.devicePrivateKey },
      listen: ['/ip4/127.0.0.1/tcp/0'],
    });

    try {
      await providerA.start();
      await providerB.start();

      // 本机身份与监听地址
      expect(providerA.getLocalPeerId().id).toBe(identityA.peerId.id);
      const addrsB = providerB.getMultiaddrs();
      expect(addrsB.length).toBeGreaterThan(0);
      expect(addrsB[0]).toContain('/p2p/');
      expect(providerB.getLibp2pPeerIdString()).toMatch(/^12D3KooW/);

      // B 侧接听：回显收到的一切
      const receivedByB: Uint8Array[] = [];
      const gotIncoming = new Promise<void>((resolve) => {
        providerB.onIncomingConnection((conn) => {
          expect(conn.peerId.id).toBe(identityA.peerId.id);
          void (async () => {
            for await (const message of conn.receive()) {
              receivedByB.push(message);
              await conn.send(new TextEncoder().encode(`echo:${message.byteLength}`));
              if (receivedByB.length === 2) resolve();
            }
          })();
        });
      });

      // A 侧拨号：一条 256KB 大载荷 + 一条小载荷
      const conn = await providerA.dial(identityB.peerId, addrsB[0]);
      expect(conn.state).toBe('connected');
      const big = new Uint8Array(256 * 1024);
      crypto.getRandomValues(big.subarray(0, 4096)); // 部分内容随机，其余为 0
      await conn.send(big);
      await conn.send(new TextEncoder().encode('small-one'));

      const replies: string[] = [];
      const iter = conn.receive()[Symbol.asyncIterator]();
      await gotIncoming;
      for (let i = 0; i < 2; i++) {
        const next = await iter.next();
        expect(next.done).toBe(false);
        replies.push(new TextDecoder().decode(next.value));
      }

      // 帧边界：B 收到的两条与发送一致（大载荷未被切分粘连）
      expect(receivedByB).toHaveLength(2);
      expect(receivedByB[0]!.byteLength).toBe(big.byteLength);
      expect(Buffer.from(receivedByB[0]!).equals(Buffer.from(big))).toBe(true);
      expect(new TextDecoder().decode(receivedByB[1]!)).toBe('small-one');
      expect(replies).toEqual([`echo:${big.byteLength}`, 'echo:9']);

      // 关闭后 receive 迭代结束
      await conn.close();
      const tail = await iter.next();
      expect(tail.done).toBe(true);
    } finally {
      await providerA.stop();
      await providerB.stop();
    }
  }, 30000);

  itIfAvailable('未启动时拨号诚实报错；重复启动抛错', async () => {
    const identity = await createTestIdentity('device-lifecycle');
    const provider = await Libp2pProvider.create({
      deviceKey: { publicKey: identity.identity.devicePublicKey, privateKey: identity.identity.devicePrivateKey },
    });
    const other = await createTestIdentity('device-lifecycle-peer');
    await expect(provider.dial(other.peerId)).rejects.toThrow('not running');
    await provider.start();
    await expect(provider.start()).rejects.toThrow('already running');
    await provider.stop();
    await provider.stop(); // 幂等
  }, 30000);

  itIfAvailable('P2PNode 全链路 over libp2p：认证 + 加密信道收发', async () => {
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);
    const a = await createTestIdentity('device-pa');
    const b = await createTestIdentity('device-pb');
    await issueCertificate(master.privateKey, a);
    await issueCertificate(master.privateKey, b);

    const providerA = await Libp2pProvider.create({
      deviceKey: { publicKey: a.identity.devicePublicKey, privateKey: a.identity.devicePrivateKey },
      listen: ['/ip4/127.0.0.1/tcp/0'],
    });
    const providerB = await Libp2pProvider.create({
      deviceKey: { publicKey: b.identity.devicePublicKey, privateKey: b.identity.devicePrivateKey },
      listen: ['/ip4/127.0.0.1/tcp/0'],
    });
    await providerA.start();
    await providerB.start();

    const nodeA = new P2PNode({
      identity: { ...a.identity, certificate: a.identity.certificate! },
      userMasterPublicKey: masterPub,
      provider: providerA,
    });
    const nodeB = new P2PNode({
      identity: { ...b.identity, certificate: b.identity.certificate! },
      userMasterPublicKey: masterPub,
      provider: providerB,
    });

    try {
      await nodeA.start();
      await nodeB.start();
      expect(nodeA.peerId.id).toBe(a.peerId.id); // 节点身份与 provider 一致

      // A 主动连接（显式地址代替发现层）并认证
      const addrB = providerB.getMultiaddrs()[0]!;
      const conn = await nodeA.getConnectionManager().connect(b.peerId, addrB);
      const ok = await nodeA.authenticatePeer(conn);
      expect(ok).toBe(true);
      expect(conn.isAuthenticated()).toBe(true);

      // 双方信道就绪后，A 发密文消息，B 解密收到
      const channelB = await nodeB.getChannel(a.peerId, 10000);
      expect(channelB).not.toBeNull();
      const receivedPromise = (async () => {
        for await (const message of channelB!.receive()) {
          return message;
        }
        return null;
      })();
      await nodeA.sendMessage(conn, new TextEncoder().encode('hello over real tcp'));
      const received = await receivedPromise;
      expect(new TextDecoder().decode(received!)).toBe('hello over real tcp');
    } finally {
      if (nodeA.isRunning()) await nodeA.stop();
      if (nodeB.isRunning()) await nodeB.stop();
      await providerA.stop();
      await providerB.stop();
    }
  }, 30000);
});

// ---------- 门面接线 ----------

describe('门面 libp2p 装配', () => {
  itIfAvailable('network.libp2p 配置驱动真实装配，shutdown 完整收拢', async () => {
    const { Mebular } = await import('../../src/mebular.js');
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);
    const storagePath = `.tmp-test-facade-libp2p-${Date.now()}.jsonl`;
    const app = new Mebular({
      storagePath,
      deviceId: 'device-facade-libp2p',
      encryption: { userMasterKey: masterPub, userMasterPrivateKey: master.privateKey },
      network: {
        enabled: true,
        libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'], protocol: MEBULAR_PROTOCOL },
      },
      sync: { autoSync: false },
    });
    try {
      await app.initialize();
      const node = app.node;
      expect(node).not.toBeNull();
      expect(node!.isRunning()).toBe(true);
    } finally {
      await app.shutdown();
      const { rm } = await import('fs/promises');
      await rm(storagePath, { force: true });
      await rm(`${storagePath}.identity.json`, { force: true });
    }
    expect(app.node).toBeNull();
  }, 30000);
});
