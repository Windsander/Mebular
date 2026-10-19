// W2/F-UNI：守护侧加入令牌与 join 服务的**薄 re-export**。
//
// 唯一实现在 `@mebular/fleet`（`packages/fleet/src/jointoken.ts`）：令牌原语（canonical/encode/decode/verify/
// build）· nonce/auto-grant 状态 · `applyJoinGrant`/`sweepAutoGrantRevokes` · inviter join 服务
// （`startJoinService`）· joiner 流程（`joinWithToken`）。本文件**不定义任何业务逻辑**，
// 只做名字映射，避免历史上「两份实现」再次漂移（F-FIN-1 类事故温床）。
//
// 防漂移断言见 `npm run check:surface-parity`：全仓 `encodeJoinToken|verifyJoinToken|applyJoinGrant|sweepAutoGrantRevokes`
// 的定义数必须为 1（多一处即红）。
//
// S2 可选增强（SPEC §7-4）：令牌签发/兑换前查 `app.getRevokedDevices()`——当前实现放在
// `serve.mjs` 的 `/admin/api/invite`（被吊销设备拒签）；兑换侧（fleet startJoinService）本轮
// 不耦合，保持令牌与设备吊销分离的默认语义。若产品决定收紧，在此薄层加统一入口并在
// fleet 侧注入 isRevoked（B 类语义，需混合版本验证）。
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
  DEFAULT_GRANT_TTL_MS,
  tokenGrantsOnJoin,
  tokenGrantTtlMs,
  autoGrantStatePath,
  readAutoGrantState,
  applyJoinGrant,
  sweepAutoGrantRevokes,
  joinNonceStatePath,
  readJoinNonceState,
  writeJoinNonceState,
  requestJoin,
  joinWithToken,
  persistInviterHints,
  startJoinService as createJoinServer,
} from '../../fleet/dist/index.js';
