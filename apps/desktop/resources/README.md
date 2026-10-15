# resources

App 打包资源（`electron-builder.yml` 的 `buildResources`）。

## App 图标

与网页版 favicon 同源的 ✦ 星（深底圆角 + 薄荷绿辉光）：

- `icon.svg` —— 矢量源（设计基准，可再生成任意尺寸）
- `icon.png` —— 1024×1024 主图；`electron-builder.yml` 的 `icon:` 指向它，
  打包时自动派生 macOS `.icns` / Windows `.ico`
- 运行时：主进程 `appIconPath()`（macOS `app.dock.setIcon` + 窗口 `icon`，见 `../src/main/index.mjs`）

再生成（改版设计后跑一次）：

```sh
# 1) 用任意渲染器把 icon.svg 渲染成 1024×1024 透明底 PNG（示例：headless Chrome）
"$CHROME" --headless=new --default-background-color=00000000 \
  --window-size=1024,1024 --screenshot=resources/icon.png \
  "file://$PWD/apps/desktop/resources/icon.html"   # 或一个包住 SVG 的最小 HTML
# 2) 提交 icon.png + icon.svg
```

托盘状态点（绿/黄/红）是另一套 16×16 内联 PNG，见 `../src/main/tray-icons.mjs`，与本图标无关。
