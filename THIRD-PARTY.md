# 第三方依赖清单（THIRD-PARTY）

> 政策（C7 建立）：**新增运行时依赖必须** ①在本文件登记（包名 / 版本 / 许可 / 用途 / 降级行为）；
> ②**精确 pin**（`x.y.z`，不用 `^`/`~`/`*`）；③可选依赖必须是**软降级**（缺包不报错、功能降档）；
> ④由 `npm run check:deps` 在 CI 强制校验。存量带范围（`^`）的依赖登记为 **legacy-range**（不追溯收窄，
> 以免锁死既有安装），新依赖一律禁止范围写法。

## 运行时依赖（dependencies）

| 包 | 版本 | 许可 | 用途 | 降级行为 |
|---|---|---|---|---|
| `ulid` | `^2.3.0`（legacy-range） | MIT | 事件/节点 ID 生成（时间有序） | 无（核心必需） |
| `bonjour` | `^3.5.1`（legacy-range） | MIT | LAN 设备发现（mDNS/C3） | 缺包/初始化失败 → 发现禁用 + 告警（其他连接方式不受影响）；库形态默认不启用真 mDNS |
| `zod` | `^4.6.5`（legacy-range） | MIT | MCP 工具入参 schema 校验 | 无（CLI 必需） |
| `@modelcontextprotocol/server` | `^2.0.0`（legacy-range） | MIT | MCP server（stdio / Streamable HTTP），`mebular mcp` / `mebular serve` | 无（CLI 必需） |

## 可选依赖（optionalDependencies）

| 包 | 版本 | 许可 | 用途 | 降级行为 |
|---|---|---|---|---|
| `libp2p` | `^2.x`（legacy-range） | Apache-2.0 OR MIT | libp2p 核心（真实网络栈装配） | 缺包 → `NETWORK_LIBP2P_NOT_AVAILABLE`（诚实报错，不静默降级） |
| `@chainsafe/libp2p-noise` | `^17.0.0`（legacy-range） | Apache-2.0 OR MIT | libp2p 连接加密 | 缺包 → `NETWORK_LIBP2P_NOT_AVAILABLE`（诚实报错，不静默降级） |
| `@chainsafe/libp2p-yamux` | `^8.0.1`（legacy-range） | Apache-2.0 OR MIT | libp2p 流复用 | 同上 |
| `@libp2p/circuit-relay-v2` | `^4.2.13`（legacy-range） | Apache-2.0 OR MIT | circuit relay（C6 内建桥角色 / relay 客户端） | 缺包 → `NETWORK_RELAY_NOT_AVAILABLE`；桥角色自动不装配 |
| `@libp2p/autonat` | `3.0.28`（**精确 pin**） | Apache-2.0 OR MIT | C4：AutoNAT 可达性自检 | 缺包 → 打洞禁用 + 告警（`getNatStatus().loadError`），其他连接方式不受影响 |
| `@libp2p/dcutr` | `3.0.28`（**精确 pin**） | Apache-2.0 OR MIT | C4：DCUtR 打洞（relay 上升级直连） | 缺包 → 保留 relay（不升级），不报错 |
| `@libp2p/identify` | `^4.1.14`（legacy-range） | Apache-2.0 OR MIT | relay 预约/协议协商 | 同上（circuit relay 依赖它） |
| `@libp2p/crypto` | `^5.1.23`（legacy-range） | Apache-2.0 OR MIT | 设备密钥 ↔ libp2p keypair | 缺包 → 真实网络栈不可用 |
| `@libp2p/peer-id` | `^6.0.15`（legacy-range） | Apache-2.0 OR MIT | peerId 派生/解析 | 同上 |
| `@libp2p/tcp` | `^11.0.27`（legacy-range） | Apache-2.0 OR MIT | TCP 传输 | 同上 |
| `@multiformats/multiaddr` | `^13.0.3`（legacy-range） | Apache-2.0 OR MIT | multiaddr 解析 | 同上 |

### 内置 vendored（随包源码，不是 npm 依赖）

| 包 | 版本 | 许可 | 用途 | 降级行为 |
|---|---|---|---|---|
| `qrcode-generator` | `2.0.4`（**源码内置**，`packages/qr/src/third-party`） | MIT | `@mebular/qr` 的 QR 编码（终端/SVG；应用层专用） | 随包编译，无缺包路径；编码失败 → 文本令牌/分组文本兜底 |

### 可选运行时导入（**非** package.json 依赖）

| 包 | 版本 | 许可 | 用途 | 降级行为 |
|---|---|---|---|---|
| `@huggingface/transformers` | 未声明（用户自行安装） | Apache-2.0 | 语义召回（可选能力，动态 import） | 缺包 → 关键词检索降级 + 告警（`semantic.enabled` 运行时为假） |

## 开发期技能素材（非运行时）

> `.opencode/skills/` 下的 agent skill：纯文本指令，**不参与构建、不进 npm 包、
> 不被运行时加载**，故不受「精确 pin / 降级行为」政策约束，但仍登记许可与来源。
> 详表见 [`.opencode/skills/README.md`](.opencode/skills/README.md)。

| 素材 | 来源 commit | 许可 | 用途 | 状态 |
|---|---|---|---|---|
| `frontend-design`（Anthropic） | `41bbe19` | Apache-2.0 | UI 审美方向顾问（开发期文本） | 已 vendor（含 LICENSE.txt） |
| `web-design-guidelines`（Vercel） | `ba46938` | ⚠️ 不明（上游无 LICENSE） | UI 质量清单参考 | **未入库**，仅本机参考 |

## 校验

```bash
npm run check:deps     # ① 所有 runtime/optional 依赖都在本清单；② 新依赖必须精确 pin；③ 清单条目字段齐备
```
CI 在 `build / test / lint` job 中执行 `npm run check:deps`；QR 正常路径由内置编码器覆盖，
渲染失败时回退文本令牌/分组文本（`npm run verify:invite` 与单测覆盖）。
