# 控制台 E2 · 双实例手工验收

目标：在两台设备（或同一台机器的两个 `MEBULAR_HOME`）上，用真实 serve +
真实 libp2p 完成「连接 → 授权 → 同步 → 撤销 → 再同步」的闭环，并核对审计导出。

前置：`npm install && npm run build`（libp2p 相关可选依赖已随根 `optionalDependencies` 安装）。

## 0. 准备两个实例

```bash
# 实例 A
export A=/tmp/mebular-a
node packages/mcp/bin/mebular.mjs init --storage $A/store.jsonl   # 生成 key/config
# 让 A 监听真实网络（在 $A/config.json 中设置）：
#   network.enabled: true
#   network.libp2p.listen: ["/ip4/127.0.0.1/tcp/14001/ws", "/ip4/127.0.0.1/tcp/14001"]
#   sync.policyIssuers: ["device-A"]        # 引导签发者（两端一致）
#   sync.peerNamespacePolicy: {}            # 默认拒绝；控制台授权后无需填写

# 实例 B
export B=/tmp/mebular-b
node packages/mcp/bin/mebular.mjs init --storage $B/store.jsonl
# 同样设置 network.enabled / listen 到 14002，sync.policyIssuers: ["device-A"]
# 注意 deviceId：A=device-A，B=device-B（config.json 或 MEBULAR_DEVICE_ID）
```

分别启动：

```bash
MEBULAR_HOME=$A node packages/mcp/bin/mebular.mjs serve --port 7331
MEBULAR_HOME=$B node packages/mcp/bin/mebular.mjs serve --port 7332
node packages/mcp/bin/mebular.mjs console --port 7331   # 打印 A 的控制台 URL
node packages/mcp/bin/mebular.mjs console --port 7332
```

浏览器打开 A 的控制台：`http://127.0.0.1:7331/console/`。

## 1. 用向导连接并授权（D3）

1. 在 A 点「＋ 添加设备」：
   - 第 ① 步复制 A 的 multiaddr（形如 `/ip4/127.0.0.1/tcp/14001/p2p/<peerId>`）。
   - 在 B 的控制台同样打开向导，复制 B 的 multiaddr 与 deviceId。
2. 回到 A，填入 B 的 deviceId 与 multiaddr → 「连接」。
   - 成功：第 ② 步显示「已连接并完成认证」。
   - 失败：按提示检查对面 serve、multiaddr 是否含 `/p2p/`、端口可达性，修正后「重试」。
3. 第 ③ 步勾选要共享给 B 的域（默认全不选；界面显示将共享的记忆条数）→「签发授权」。
4. 第 ④ 步显示 grantId，可复制留档。

## 2. 验证双向同步

- A 在授权域内写入一条记忆（用 MCP `memory_write`，或 `examples/` 中的脚本）。
- A 控制台「立即同步」（设备卡）或在写入后等待 push-on-write；B 的星图应出现 A、
  且域视图里该域记忆数增加。
- 反向在 B 写入，A 侧同样可见（B 需对 A 授权；在 B 的控制台用向导/域开关完成）。

## 3. 撤销与吊销（二次确认）

- 在 A 的设备卡关闭某域开关：弹窗文案应为
  「B 不会再收到关于『该域』的新记忆；已同步内容不会撤回；可用新授权恢复。」
  确认后，A 再写入的新记忆不再抵达 B（已同步内容仍在 B）。
- 在 A 点「吊销设备」：弹窗文案应为
  「B 无法再接收你的任何分区，其签发的政策记录不再被采纳；已同步数据不回撤；
  可重新授权恢复。」确认后 B 读侧为空；再对 B 签发新 grant 即恢复。

## 4. 审计时间线导出

- 切到「审计」视图：grant / revoke / device_revoke 事件按时间倒序；
- 用「动作 / 设备 / 域」下拉过滤；
- 点「导出 JSON」下载当前过滤结果，核对每条记录的 `eventId/type/issuer/subject/
  grantId/at/valid` 与第 3 步的操作一一对应。

## 5. SSE 实时性

- 保持两个控制台打开，在对面触发同步/写入；星图中心应有脉冲，状态条与记忆数在
  2–5s 内更新（无 SSE 时退回轮询）。
- 若 serve 以 `--auth bearer/oauth` 运行，页面会提示录入 token；SSE 通过
  `?token=` 连接（写操作仍要求 `memory.admin` + CSRF）。

## 已知边界

- 「立即同步」使用 `node.getChannel` + `SecureChannelSyncTransport` +
  `sync.syncWithDevice`；当同步管理器的常驻 push-on-write 会话已占用同一信道的
  接收迭代器时，手工同步可能与之交错，建议在无并发写入时使用。
- 单条 grant 含多个域时，关闭其中一个域会撤销整条 grant（core 语义：按 grantId
  精确失效）；控制台「开」始终按单域签发 grant，以避免误伤其他域。
