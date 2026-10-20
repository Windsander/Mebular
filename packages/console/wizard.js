// 手动连接向导状态机（纯函数，无 DOM 依赖）
//
// E1：入口从顶栏迁到「诊断 / 设备卡 · 连不上」语境。此向导只做**网内传输修复**：
// ① 粘贴对端 deviceId/multiaddr → ② connectToPeer；不再包含「选择共享域 / 旧策略声明」
// （v4：订阅自主，自动声明；共享域选择属旧模型，已退役）。
//
// 由 console.js 渲染，由 scripts/verify-console.mjs 做状态机断言（无需起服务）。

export const WIZARD_STEPS = ['local', 'connect'];

export function createWizardState() {
  return {
    step: 'local',
    deviceId: '',
    address: '',
    connection: 'idle', // idle | connecting | connected | failed
    error: null,
  };
}

export function wizardReduce(state, action) {
  switch (action?.type) {
    case 'PEER_INPUT':
      return {
        ...state,
        deviceId: typeof action.deviceId === 'string' ? action.deviceId : state.deviceId,
        address: typeof action.address === 'string' ? action.address : state.address,
        error: null,
      };
    case 'GO_CONNECT':
      if (state.deviceId.trim().length === 0 || state.address.trim().length === 0) {
        return { ...state, error: '请填写对方 deviceId 与 multiaddr' };
      }
      return { ...state, step: 'connect', connection: 'connecting', error: null };
    case 'CONNECT_SUCCESS':
      return { ...state, connection: 'connected', error: null };
    case 'CONNECT_FAILURE':
      return { ...state, connection: 'failed', error: action.message ?? '连接失败' };
    case 'BACK':
      if (state.step === 'connect') return { ...state, step: 'local', connection: 'idle', error: null };
      return state;
    case 'RESET':
      return createWizardState();
    default:
      return state;
  }
}
