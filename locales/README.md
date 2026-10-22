# Locale packs

应用代码只依赖 **manifest + `t()`**；所有 locale 文案是独立数据包，不进入业务代码。

```text
locales/
  manifest.json          # 唯一注册表（supported locale / native name / fallback / pack 路径）
  zh-CN/
    console.json         # 控制台文案
    desktop.json         # 桌面壳预留（本阶段为空结构）
    errors.json          # 错误文案预留（本阶段为空结构）
  en-US/
    console.json
    desktop.json
    errors.json
```

## manifest.json

```json
{
  "schemaVersion": 1,
  "defaultLocale": "zh-CN",
  "fallbackLocale": "zh-CN",
  "packs": ["console", "desktop", "errors"],
  "locales": [
    {
      "locale": "zh-CN",
      "nativeName": "简体中文",
      "files": {
        "console": "zh-CN/console.json",
        "desktop": "zh-CN/desktop.json",
        "errors": "zh-CN/errors.json"
      }
    }
  ]
}
```

- `schemaVersion`、`defaultLocale`、`fallbackLocale` 是必填元数据。
- `locale` 使用 BCP 47 标签；`nativeName` 用该语言自身写法。
- 文件路径相对 `locales/`，只能是相对路径；`/locales/*` 静态路由只放行
  `manifest.json` 与 `<locale>/{console,desktop,errors}.json`。
- `defaultLocale` / `fallbackLocale` 必须在该 manifest 的 `locales` 中注册。

## pack 文件

```json
{
  "schemaVersion": 1,
  "locale": "zh-CN",
  "pack": "console",
  "messages": {
    "nav.map": "星图"
  }
}
```

- `messages` 是扁平 key → 字符串；key 稳定、命名 `<区域>.<语义>`。
- 插值占位符用 `{name}`；同一 key 在所有语言中的占位符集合必须一致。
- 缺 key 时 `t()` 回退 key（不返回空字符串）；运行期按
  `请求 locale → manifest.fallbackLocale → defaultLocale` 查找。
- 用户数据（设备名、忆云名、命名空间、记忆正文、审计原文、错误原文）不进入 pack。

## 新增语言

1. 新建 `locales/<locale>/`，放入 `console.json`（以及 `desktop.json` / `errors.json` 占位）。
2. 在 `locales/manifest.json` 的 `locales` 里登记 `locale`、`nativeName`、`files`。
3. 运行 `npm run check:i18n`。

不需要改 `packages/console/console.js`、`packages/console/i18n.mjs` 或语言行代码。
语言行直接使用 manifest 的 `nativeName` 生成选项。

## 加载与分发

- 浏览器：`packages/console/i18n.mjs` 的 `initI18n()` 请求 `/locales/manifest.json`
  和 `/locales/<locale>/console.json`；`console.js` 在首帧应用静态文案前 `await initI18n()`。
- 守护：`packages/mcp/src/serve.mjs` 提供只读 `/locales/*` 路由；`MEBULAR_LOCALES_DIR`
  可覆盖根目录（桌面打包时由 `extraResources` 落到 `<resources>/locales`）。
- npm：根 `package.json` 的 `files` 包含 `locales`，`npm pack` 会带上完整数据层。

## 校验

`npm run check:i18n` 扫描 manifest + 所有 pack，校验文件存在、envelope 元数据、
console key 对等、占位符一致、值非空、非默认语言不含中文（白名单），以及 loader /
fallback / 静态引用。主路径（顶栏 / 导航 / 锁定态 / 新建 / 加入 / 邀请 / 向导）
另有 key 组完整性与 `data-i18n` 挂载检查。`tests/console/i18n.test.mjs` 用只读注入
临时 locale 证明“加目录 + manifest 即可新增语言”。
