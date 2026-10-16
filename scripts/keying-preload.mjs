// P1·A1 分层探针（preload）——**不改产品代码**：通过 NODE_OPTIONS=--import 注入守护进程，
// 包住 dist 中各类原型方法，把「身份解析 / 会话角色 / nudge / 帧路由 / 信任判定」逐层打点。
// 输出到 stderr，单行 JSON，前缀 [KP][side][t+ms]。
// 用法：MEBULAR_KEYING_SIDE=A NODE_OPTIONS="--import <abs path>/keying-preload.mjs" node ...serve

const dist = new URL('../dist/', import.meta.url);

const syncmgr = await import(new URL('sync/syncmgr/SyncManager.js', dist).href);
const p2p = await import(new URL('p2p/P2PNetwork.js', dist).href);
const handshake = await import(new URL('p2p/handshake/AuthenticationHandshake.js', dist).href);
const connmgr = await import(new URL('p2p/connection/ConnectionManager.js', dist).href);
const peerframes = await import(new URL('sync/syncmgr/PeerFrames.js', dist).href);

const side = process.env.MEBULAR_KEYING_SIDE ?? '?';
const t0 = Date.now();
function log(tag, data) {
  try {
    console.error(`[KP][${side}][${Date.now() - t0}ms] ${tag} ${data === undefined ? '' : JSON.stringify(data)}`);
  } catch { /* ignore */ }
}
const brief = (id) => (typeof id === 'string' ? (id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id) : id);
const connTags = new WeakMap();
let connCounter = 0;
const tagConn = (conn) => {
  if (!conn || typeof conn !== 'object') return null;
  if (!connTags.has(conn)) connTags.set(conn, ++connCounter);
  return connTags.get(conn);
};
const framesTags = new WeakMap();
let framesCounter = 0;
const tagFrames = (frames) => {
  if (!frames || typeof frames !== 'object') return null;
  if (!framesTags.has(frames)) framesTags.set(frames, ++framesCounter);
  return framesTags.get(frames);
};

function wrap(proto, name, before, after) {
  const orig = proto[name];
  if (typeof orig !== 'function') {
    log('wrap-miss', { name });
    return;
  }
  proto[name] = function patched(...args) {
    let ctx;
    try {
      ctx = before ? before.apply(this, args) : undefined;
    } catch (e) {
      ctx = { beforeError: String(e?.message ?? e) };
    }
    let out;
    try {
      out = orig.apply(this, args);
    } catch (e) {
      try { after?.apply(this, [ctx, undefined, e]); } catch { /* ignore */ }
      throw e;
    }
    if (out && typeof out.then === 'function') {
      return out.then(
        (v) => { try { after?.apply(this, [ctx, v, null]); } catch { /* ignore */ } return v; },
        (e) => { try { after?.apply(this, [ctx, undefined, e]); } catch { /* ignore */ } throw e; },
      );
    }
    try { after?.apply(this, [ctx, out, null]); } catch { /* ignore */ }
    return out;
  };
}
const err = (e) => (e ? String(e?.message ?? e) : undefined);

// ---------- L1 连接/握手层 ----------
wrap(handshake.AuthenticationHandshake.prototype, 'initiateAuth', (conn) => ({ peer: brief(conn?.peerId?.id), as: 'initiator', connTag: tagConn(conn) }), (ctx, session) =>
  log('auth.initiate', { ...ctx, state: session?.state, certDeviceId: session?.certificate?.deviceId }));
wrap(handshake.AuthenticationHandshake.prototype, 'acceptAuth', (conn) => ({ peer: brief(conn?.peerId?.id), as: 'acceptor', connTag: tagConn(conn) }), (ctx, session) =>
  log('auth.accept', { ...ctx, state: session?.state, certDeviceId: session?.certificate?.deviceId }));
{
  const origEmit = handshake.AuthenticationHandshake.prototype.emit;
  handshake.AuthenticationHandshake.prototype.emit = function patchedEmit(event, ...args) {
    if (event === 'authenticated') {
      const s = args[0];
      log('auth.authenticated.emit', {
        peer: brief(s?.peerId?.id), certDeviceId: s?.certificate?.deviceId, state: s?.state,
      });
    } else if (event === 'auth-failed') {
      log('auth.failed', { peer: brief(args[0]?.id ?? args[0]), error: err(args[1]) });
    }
    return origEmit.apply(this, [event, ...args]);
  };
}
wrap(p2p.P2PNode.prototype, 'connectToPeer', (peerId, address) => ({ peer: brief(peerId?.id), dialTo: address?.slice(0, 60) }), (ctx, conn) =>
  log('p2p.connectToPeer', { ...ctx, ok: Boolean(conn), connTag: tagConn(conn) }),);
wrap(p2p.P2PNode.prototype, 'authenticatePeer', (conn) => ({ peer: brief(conn?.peerId?.id), connTag: tagConn(conn) }), (ctx, ok) =>
  log('p2p.authenticatePeer', { ...ctx, ok }));
wrap(p2p.P2PNode.prototype, 'handleIncomingConnection', function (conn) {
  const ctx = { key: brief(conn?.peerId?.id), connTag: tagConn(conn), channelsHas: this?.channels?.has?.(conn?.peerId?.id) };
  log('p2p.handleIncomingConnection.enter', ctx);
  return ctx;
}, function (ctx) {
  log('p2p.handleIncomingConnection.done', ctx);
});
wrap(p2p.P2PNode.prototype, 'prepareChannel', function (conn) {
  const key = conn?.peerId?.id;
  return { peer: brief(key), keyRaw: key, connTag: tagConn(conn), hadChannel: this?.channels?.has?.(key) };
}, function (ctx) {
  log('p2p.prepareChannel', { peer: ctx?.peer, connTag: ctx?.connTag, hadChannel: ctx?.hadChannel, nowHas: this?.channels?.has?.(ctx?.keyRaw) ?? null, size: this?.channels?.size ?? null });
});
wrap(p2p.P2PNode.prototype, 'getChannel', (peerId) => ({ peer: brief(peerId?.id) }), (ctx, chan) =>
  log('p2p.getChannel', { ...ctx, got: Boolean(chan), connTag: tagConn(chan?.connection) }));
wrap(connmgr.ConnectionManager.prototype, 'connect', (peerId, address) => ({ key: brief(peerId?.id), dialTo: address?.slice(0, 60) }), (ctx, conn) =>
  log('connmgr.connect', { ...ctx, ok: Boolean(conn) }));
wrap(connmgr.ConnectionManager.prototype, 'setConnection', (peerId, connection) => ({ key: brief(peerId?.id), connTag: tagConn(connection) }), (ctx) =>
  log('connmgr.setConnection', ctx));

// ---------- L2 会话/nudge 层（SyncManager） ----------
const SM = syncmgr.SyncManager.prototype;
const transportTag = (t) => {
  try { return tagConn(t?.channel?.connection); } catch { return null; }
};
wrap(SM, 'syncWithDevice', function (transport, peer) { return { role: 'initiator', peerDeviceId: peer?.deviceId, connTag: transportTag(transport) }; }, (ctx, result) =>
  log('sm.syncWithDevice', { ...ctx, sent: result?.sentEvents, received: result?.receivedEvents, denied: result?.denied }));
wrap(SM, 'acceptSync', function (transport, peer) { return { role: 'responder', peerDeviceId: peer?.deviceId, connTag: transportTag(transport) }; }, (ctx, result) =>
  log('sm.acceptSync', { ...ctx, sent: result?.sentEvents, received: result?.receivedEvents, denied: result?.denied }));
wrap(SM, 'runResponderLoop', function (transport, entry) { return { peerDeviceId: entry?.peer?.deviceId, key: brief(entry?.peerId?.id), initiate: entry?.initiate, connTag: transportTag(transport) }; }, (ctx) =>
  log('sm.runResponderLoop.enter', ctx));
wrap(SM, 'runInitiatorLoop', function (transport, entry) { return { peerDeviceId: entry?.peer?.deviceId, key: brief(entry?.peerId?.id), initiate: entry?.initiate, connTag: transportTag(transport) }; }, (ctx) =>
  log('sm.runInitiatorLoop.enter', ctx));
wrap(SM, 'scheduleSyncTrigger', function (entry) { return { peerDeviceId: entry?.peer?.deviceId, key: brief(entry?.peerId?.id), initiate: entry?.initiate, hasTransport: Boolean(entry?.transport), connTag: transportTag(entry?.transport), current: this?.onlinePeers?.get?.(entry?.peerId?.id) === entry }; }, (ctx) =>
  log('sm.scheduleSyncTrigger', ctx));
wrap(SM, 'deliverTrigger', function (entry) { return { peerDeviceId: entry?.peer?.deviceId, initiate: entry?.initiate, connTag: transportTag(entry?.transport), current: this?.onlinePeers?.get?.(entry?.peerId?.id) === entry }; }, (ctx) =>
  log('sm.deliverTrigger', ctx));
wrap(SM, 'onPeerNudge', function (entry) { return { peerDeviceId: entry?.peer?.deviceId, key: brief(entry?.peerId?.id), initiate: entry?.initiate, current: this?.onlinePeers?.get?.(entry?.peerId?.id) === entry }; }, (ctx) =>
  log('sm.onPeerNudge', ctx));
wrap(SM, 'wakeInitiator', function (entry) { return { peerDeviceId: entry?.peer?.deviceId }; }, (ctx) =>
  log('sm.wakeInitiator', ctx));
wrap(SM, 'removeOnlinePeer', function (peerId) { return { key: brief(peerId?.id) }; }, (ctx) =>
  log('sm.removeOnlinePeer', ctx));
wrap(SM, 'recordPeerHello', function (peerDeviceId, hello) { return { peerDeviceId, namespaces: hello?.namespaces, subscribeAll: hello?.subscribeAll }; }, (ctx) =>
  log('sm.recordPeerHello', ctx));
wrap(SM, 'markEventsSynced', function (peerDeviceId, ids) { return { peerDeviceId, count: ids?.length }; }, (ctx) =>
  log('sm.markEventsSynced', ctx));
wrap(SM, 'verifyEventTrust', function (event, peer) { return { author: event?.author, peerDeviceId: peer?.deviceId, eventId: brief(event?.id) }; }, (ctx, ok) =>
  log('sm.verifyEventTrust', { ...ctx, ok }));
wrap(SM, 'applyOffer', function (events, peer) { return { peerDeviceId: peer?.deviceId, count: events?.length, authors: [...new Set((events ?? []).map((e) => e.author))] }; }, (ctx, result) =>
  log('sm.applyOffer', { ...ctx, received: result?.received, duplicates: result?.duplicates, acked: result?.ackedIds?.length }));
wrap(SM, 'resolveOutgoingAllowList', function (peer) { return { peerDeviceId: peer?.deviceId }; }, function (ctx, allow) {
  log('sm.resolveOutgoingAllowList', { ...ctx, allow });
});
// 会话串行化探针：enqueue 挂起点与 runSession 实际启动的等待时长（活锁可视化）
let kpLastEnqueueAt = 0;
wrap(SM, 'enqueue', function () { kpLastEnqueueAt = Date.now(); return { at: kpLastEnqueueAt }; }, function (ctx, out, e) {
  log('sm.enqueue.settled', { waitedMs: Date.now() - ctx.at, error: err(e) });
});
wrap(SM, 'runSession', function (peer) { return { peerDeviceId: peer?.deviceId, enqueueWaitMs: Date.now() - kpLastEnqueueAt }; }, (ctx) =>
  log('sm.runSession.start', ctx));
wrap(SM, 'runResponder', function (transport, peer, iterator, firstHelloTimeout) { return { peerDeviceId: peer?.deviceId, firstHelloTimeout, connTag: transportTag(transport) }; }, (ctx, out, e) =>
  log('sm.runResponder.start', { ...ctx, error: err(e) }));

// ---------- L3 帧路由层（PeerFrames） ----------
wrap(peerframes.PeerFrames.prototype, 'readerNext', function () { return { ftag: tagFrames(this) }; }, (ctx, result) =>
  log('frames.readerNext', { ...ctx, msg: result?.value?.type, done: result?.done }));
wrap(peerframes.PeerFrames.prototype, 'setSessionActive', function (active) { return { ftag: tagFrames(this), active }; }, (ctx) =>
  log('frames.setSessionActive', ctx));
wrap(peerframes.PeerFrames.prototype, 'pump', function () { return { ftag: tagFrames(this) }; }, (ctx) =>
  log('frames.pump.ended', ctx));

// ---------- L1b 安全信道（连接→信道）----------
const secure = await import(new URL('p2p/secure/SecureChannelImpl.js', dist).href);
wrap(secure.SecureChannelImpl.prototype, 'start', function () { return { chanTag: tagConn(this), connTag: tagConn(this?.connection) }; }, (ctx, out, e) =>
  log('secure.start', { ...ctx, ready: Boolean(out), error: err(e) }));
wrap(secure.SecureChannelImpl.prototype, 'send', function (msg) { return { connTag: tagConn(this?.connection), len: msg?.length }; }, function (ctx, out, e) {
  log('secure.send', { ...ctx, ok: !e, error: err(e) });
});
wrap(secure.SecureChannelImpl.prototype, 'handleKeyExchange', function (frame) { return { connTag: tagConn(this?.connection), len: frame?.length }; }, function (ctx, out, e) {
  log('secure.keyExchange', { ...ctx, ok: !e, error: err(e) });
});
wrap(secure.SecureChannelImpl.prototype, 'decryptFrame', function (frame) { return { connTag: tagConn(this?.connection), len: frame?.length }; }, function (ctx, out, e) {
  log('secure.decryptFrame', { ...ctx, ok: !e, plainLen: out?.length, error: err(e) });
});
wrap(secure.SecureChannelImpl.prototype, 'startPump', function () { return { connTag: tagConn(this?.connection) }; }, (ctx) =>
  log('secure.startPump', ctx));
wrap(secure.SecureChannelImpl.prototype, 'receive', function () { return { chanRef: tagConn(this), connTag: tagConn(this?.connection), qtag: tagConn(this?.plaintextQueue) }; }, (ctx) =>
  log('secure.receive', ctx));
const protocolMod = await import(new URL('sync/protocol.js', dist).href);
wrap(protocolMod.SecureChannelSyncTransport.prototype, 'receive', function () { return { tRef: tagConn(this), chanRef: tagConn(this?.channel), connTag: tagConn(this?.channel?.connection) }; }, (ctx) =>
  log('transport.receive', ctx));

// ---------- L1c 传输连接（libp2p 流）----------
const libp2pTransport = await import(new URL('p2p/transport/Libp2pProvider.js', dist).href);
wrap(libp2pTransport.Libp2pConnection.prototype, 'send', function (data) { return { connTag: tagConn(this), len: data?.length }; }, function (ctx, out, e) {
  log('libp2pConn.send', { ...ctx, ok: !e, error: err(e) });
});
wrap(libp2pTransport.Libp2pConnection.prototype, 'receive', function () { return { connTag: tagConn(this) }; }, (ctx) =>
  log('libp2pConn.receive', ctx));
wrap(libp2pTransport.Libp2pConnection.prototype, 'pumpIncoming', function () { return { connTag: tagConn(this) }; }, (ctx, out, e) =>
  log('libp2pConn.pumpIncoming.end', { ...ctx, error: err(e) }));
{
  const origClose = libp2pTransport.Libp2pConnection.prototype.close;
  libp2pTransport.Libp2pConnection.prototype.close = function patchedClose(...args) {
    log('libp2pConn.close', { connTag: tagConn(this), stack: (new Error().stack ?? '').split('\n').slice(1, 6).map((l) => l.trim().slice(0, 90)) });
    return origClose.apply(this, args);
  };
}
const frameDecoder = libp2pTransport.FrameDecoder.prototype;
wrap(frameDecoder, 'push', function (bytes) { return { dtag: tagConn(this), bytes: bytes?.length }; }, function (ctx, out) {
  log('frameDecoder.push', { ...ctx, frames: (out ?? []).map((f) => f?.length) });
});

// ---------- L0b 队列层（MessageQueue 消费可视化）----------
const memTransport = await import(new URL('p2p/transport/InMemoryTransport.js', dist).href);
{
  const MQ = memTransport.MessageQueue.prototype;
  const origIterate = MQ.iterate;
  const origPush = MQ.push;
  MQ.iterate = function patchedIterate() {
    const qtag = tagConn(this);
    const owner = (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().slice(0, 70));
    log('mq.iterate', { qtag, owner });
    const inner = origIterate.call(this);
    return (async function* () {
      for (;;) {
        const r = await inner.next();
        if (r.done) return;
        log('mq.yield', { qtag, len: r.value?.length });
        yield r.value;
      }
    })();
  };
  MQ.push = function patchedPush(item) {
    log('mq.push', { qtag: tagConn(this), len: item?.length, waiters: this.waiters.length });
    return origPush.call(this, item);
  };
}

log('preload-ready', { pid: process.pid, dist: dist.pathname });
