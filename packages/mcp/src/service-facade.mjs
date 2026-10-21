// MCP 服务代理：允许 HTTP /mcp 在 UNINITIALIZED 就先装配（initialize / tools/list / prompts/list），
// 热初始化完成后把同一代理的目标切到真实 MemoryService——同一 session / 同一 server 不需要重连。
//
// 代理只在调用发生时解析目标；未就绪时抛 NOT_INITIALIZED，由 registerTools 的统一 guard
// 转成稳定的业务错误信封（不返回 HTTP 409/500）。

export const NOT_INITIALIZED_CODE = 'NOT_INITIALIZED';
export const NOT_INITIALIZED_MESSAGE = '请先新建或加入忆云';

export function notInitializedError() {
  const error = new Error(NOT_INITIALIZED_MESSAGE);
  error.code = NOT_INITIALIZED_CODE;
  return error;
}

/**
 * @param {{ getService?: () => unknown, isReady?: () => boolean }} options
 * @returns 透明转发到当前 MemoryService 的代理；未就绪时所有方法调用都抛 NOT_INITIALIZED。
 */
export function createServiceFacade({ getService, isReady } = {}) {
  const resolve = () => {
    if (typeof isReady === 'function' && !isReady()) throw notInitializedError();
    const service = typeof getService === 'function' ? getService() : null;
    if (!service) throw notInitializedError();
    return service;
  };
  return new Proxy({}, {
    get(_target, property) {
      // 防止 Promise 解析把代理当 thenable 调用。
      if (property === 'then') return undefined;
      return (...args) => {
        const service = resolve();
        const method = service[property];
        if (typeof method !== 'function') {
          const error = new Error(`MemoryService 不支持 ${String(property)}`);
          error.code = 'E_INTERNAL';
          throw error;
        }
        return method.apply(service, args);
      };
    },
  });
}
