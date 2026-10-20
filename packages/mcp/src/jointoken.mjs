// W2/F-UNI：守护侧加入令牌与 join 服务的**薄 re-export**。
//
// 唯一实现在 `@mebular/fleet`（`packages/fleet/src/jointoken.ts`）：令牌原语（canonical/encode/decode/verify/
// build）· nonce 状态 · inviter join 服务（`startJoinService`）· joiner 流程（`joinWithToken`）。
// 本文件**不定义任何业务逻辑**，只做名字映射，避免历史上「两份实现」再次漂移。
//
// 防漂移断言见 `npm run check:surface-parity`：全仓 `encodeJoinToken|verifyJoinToken` 的
// 定义数必须为 1（多一处即红）。
//
// 令牌签发前查 `app.getBlockedDevices()`（被移出设备拒签），见 `serve.mjs` 的
// `/admin/api/invite`；兑换侧不耦合，保持令牌与设备移出分离。
export {
  canonicalJoinTokenData,
  decodeJoinToken,
  encodeJoinToken,
  buildJoinToken,
  describeJoinToken,
  verifyJoinToken,
  collectReachableEndpoints,
  collectRelaySeeds,
  isLoopbackAddress,
  chainFingerprint,
  joinNonceStatePath,
  readJoinNonceState,
  writeJoinNonceState,
  activateJoinInvite,
  requestJoin,
  joinWithToken,
  persistInviterHints,
  startJoinService as createJoinServer,
} from '../../fleet/dist/index.js';
