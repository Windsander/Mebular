// 共享 service 加载器：bare `@mebular/service` 优先，安装布局下回退到 core tarball 内的
// `packages/service/dist/index.js`。
//
// 背景（Phase 4a blocker）：
//   `@mebular/core` 的 package.json 不依赖 `@mebular/service`，但 core tarball 实际包含
//   `packages/service/dist`。共享 runtime 安装到 `<cloudRoot>/runtime/<version>/node_modules/
//   @mebular/core/...` 后，bare import 解析不到独立包；若不回退，`runtime resolve` 的
//   service 状态会变成 `service_unknown`，plugin-only 首次启动会被阻断。
//
// 决策：不新增 npm 依赖、不改发布依赖；由本 loader 统一 bare → bundled dist。
// App 仍可注入自己的 service adapter（cloud-switch 的 `deps` / supervisor 的注入点），
// 本 loader 只服务“默认共享 core/CLI”路径。
//
// 约束：
//   - 只接受 bare 包名或本文件相对定位的 bundled dist，不加载任意 URL/路径；
//   - 只缓存成功结果；失败不缓存，便于用户修复安装后重试；
//   - 失败抛 `SERVICE_MODULE_UNAVAILABLE`，保留 bare/bundled 两个 cause 供诊断（不含密钥）。

const BUNDLED_SERVICE_URL = new URL('../../service/dist/index.js', import.meta.url);

const importBareService = () => import('@mebular/service');
const importBundledService = () => import(BUNDLED_SERVICE_URL.href);

let cachedModule = null;
let cachedPromise = null;

/** 本 loader 在安装布局中定位到的 service dist（测试/诊断用；不返回文件内容）。 */
export function bundledServiceModuleUrl() {
  return BUNDLED_SERVICE_URL;
}

/** 清空缓存（测试或修复安装后显式重试）。 */
export function resetServiceModuleCache() {
  cachedModule = null;
  cachedPromise = null;
}

/**
 * 加载 service 模块。
 *
 * `importBare` / `importBundled` 可注入，便于离线测试安装布局；生产调用无需传参。
 * 返回 ES module namespace，与 `import('@mebular/service')` 形状一致。
 */
export async function loadServiceModule({
  importBare = importBareService,
  importBundled = importBundledService,
  cache = true,
} = {}) {
  if (cache && cachedModule !== null) return cachedModule;
  if (cache && cachedPromise !== null) return cachedPromise;

  const load = async () => {
    try {
      return await importBare();
    } catch (bareError) {
      try {
        return await importBundled();
      } catch (bundledError) {
        const error = new Error(
          '无法加载 @mebular/service：bare 包与 core 内置 packages/service/dist 均不可用',
        );
        error.code = 'SERVICE_MODULE_UNAVAILABLE';
        error.cause = bareError;
        error.bareError = bareError;
        error.bundledError = bundledError;
        throw error;
      }
    }
  };

  const pending = load();
  if (cache) cachedPromise = pending;
  try {
    const module = await pending;
    if (cache) {
      cachedModule = module;
      cachedPromise = null;
    }
    return module;
  } catch (error) {
    if (cache) cachedPromise = null;
    throw error;
  }
}
