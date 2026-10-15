// Mebular 桌面 App · 菜单栏图标（品牌 ✦ 星章）
// 用户定稿：白色背景 + 星星镂空——macOS 以「模板图」实现：黑色+透明源，系统在深色菜单栏
// 自动渲染为白底镂空星、浅色菜单栏为黑底镂空星，两种外观均保持品牌与可读性。
// 运行状态语义由 tooltip 与托盘菜单承担（图标不再分色）。
// 数据：18×18（@1x 源）+ 36×36（@2x 载荷，nativeImage.addRepresentation）。

const PNG_18 = 'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAwUlEQVR4nKzTMQ4BQRTG8YctJAoH0BAJCgkdcQNncAeVRqdxDY1KFO7AAURCoRNRKiQKKvxfmGQjm7Dz9kt+2czu5svb7Ewg0amjixbaKMiPBF/rLEYYICMxEi5qYIaqeCT1ueawQVk84yYaW0rcRB2skBZDdKK+tcQV1cSeixYVxZ6DFuXFnn0gyWSpf+0ptjxQSmKiOY7WiW6o4GSZ6I6elujCdyPu5H0iFu5G3KIrhmhiHX7w76dtMcUE56gXXgAAAP//gt6VmwAAAAZJREFUAwBRdBoa22TAhAAAAABJRU5ErkJggg==';
const PNG_36 = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAACQklEQVR4nMSYy0tVURTGv9LeA6Fo0gN6J2HUJLKoaFjjZkVESNAfUIMgqFGXatQ/0KBG4syBOnAgKqIjry/wCeJjICgoIr4f3+c+V656rp5z1tbzgx/3Hu7hsu66a++19ilGOGX0JX1Iy+lF+GGctgbW0e6dNxzZcX2SfqefaBEOllX6i36jywgJ6B6tpLdxuLTTiuB1K6AztINeRzoM0Tt0Kfe3/IarmbQ4S4/TemXoMW2iR5Eua/SZMqTs3EX6KDlFykop7EzTGdgpVUBXYGeYjsDOZkAlsNNHB2CnxFchN9JmeECFtA4bWh1X4ZZtP3bv/rHwkaEquPoZpDUwYs3QPL1Fx4JrtZ0uegwJsWRogb7JC0aouD/ANc5EJM1QD32LoCGG8IT+R4ItJW6GZukXen+PYIRWnGaqH3CZjEzUDGmQ0i/+SycRj0v0PVxGb+53czGio2wmGdpUTyt0McrNcWtoDm7KyyBvyiuApk/9vZ/pKUQkaVH30tcoXEeP6D96AzFJuuw1IbTQVyGfvYNrJbGDET42Rm2Go8G13msBxKnNbVhbh2ojk3f9xxKM8NFctYIu0/O0E0ZMvybvO17QC/CAj4DEU3g63aqGJmBHZ6prsDOhgLKwo5bgI0NZXwGdo6dhJ6tVpr1Dx+gTSJclWqZmOQVX3M+RLl9pdW4gV3aUpcN+8pFDPfEBXc3t1BoNPiIdNJ5UBK/bWkcD3FEmA8NMHDOQn3DtZ2tqKHSG0vip3bccB/NIr43WIuSR3gYAAAD//7L/q8gAAAAGSURBVAMAjoRp3oiMNgcAAAAASUVORK5CYII=';

/** 菜单栏图标（品牌星章；任意 state 同一图形——状态在 tooltip/菜单） */
export function iconDataUrl(state) {
  void state;
  return `data:image/png;base64,${PNG_18}`;
}

/** @2x 载荷（nativeImage.addRepresentation 用） */
export function iconDataUrl2x() {
  return `data:image/png;base64,${PNG_36}`;
}

export const TRAY_STATES = Object.freeze(['green', 'yellow', 'red']);
