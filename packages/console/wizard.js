// 添加设备向导状态机（纯函数，无 DOM 依赖）
//
// 三步：① 本机信息 + 粘贴对端 deviceId/multiaddr → ② connectToPeer →
// ③ 选共享域（默认全不选）→ 签发 grant → 显示 grantId。
//
// 由 console.js 渲染，由 scripts/verify-console.mjs 做状态机断言（无需起服务）。

export const WIZARD_STEPS = ['local', 'connect', 'domains'];

export function createWizardState() {
  return {
    step: 'local',
    deviceId: '',
    address: '',
    connection: 'idle', // idle | connecting | connected | failed
    error: null,
    selected: [],
    granting: false,
    grantId: null,
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
    case 'GO_DOMAINS':
      if (state.connection !== 'connected') return { ...state, error: '尚未连接成功' };
      return { ...state, step: 'domains', error: null };
    case 'TOGGLE_NAMESPACE': {
      const ns = action.namespace;
      if (typeof ns !== 'string' || ns.length === 0) return state;
      const selected = state.selected.includes(ns)
        ? state.selected.filter((item) => item !== ns)
        : [...state.selected, ns];
      return { ...state, selected, error: null };
    }
    case 'GRANT_START':
      if (state.step !== 'domains' || state.connection !== 'connected') {
        return { ...state, error: '连接尚未就绪' };
      }
      if (state.selected.length === 0) {
        return { ...state, error: '请至少选择一个要共享的域' };
      }
      return { ...state, granting: true, error: null };
    case 'GRANT_SUCCESS':
      return { ...state, granting: false, grantId: action.grantId ?? null, step: 'done', error: null };
    case 'GRANT_FAILURE':
      return { ...state, granting: false, error: action.message ?? '签发授权失败' };
    case 'BACK':
      if (state.step === 'connect') return { ...state, step: 'local', error: null };
      if (state.step === 'domains') return { ...state, step: 'connect', error: null };
      return state;
    case 'RESET':
      return createWizardState();
    default:
      return state;
  }
}

/** 将共享的域的记忆数合计（用于「将共享 N 条记忆」提示） */
export function selectedMemoryCount(namespaces, selected) {
  const counts = new Map((namespaces ?? []).map((entry) => [entry.namespace, entry.count ?? 0]));
  return (selected ?? []).reduce((sum, ns) => sum + (counts.get(ns) ?? 0), 0);
}
