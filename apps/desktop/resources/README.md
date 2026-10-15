# resources

App 打包资源（`electron-builder.yml` 的 `buildResources`）。

## App 图标

与网页版 favicon 同源的 ✦ 星（深底圆角 + 薄荷绿辉光）：

- `icon.svg` —— 矢量源（设计基准，可再生成任意尺寸）；尺寸遵循 macOS 官方图标网格：
  内容 824×824 居中于 1024 画布（四周各 100px 透明边距）——与其他 App 在 Dock 中视觉等大
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

菜单栏图标是另一套「品牌星章」（白底 + 星星镂空，macOS 模板图自动反色；18pt + @2x），
见 `../src/main/tray-icons.mjs`；运行状态语义在 tooltip 与托盘菜单。
