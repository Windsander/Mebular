# Memory Runtime 演示

[English](README.md) · [Memory Runtime 用户指南](../../docs/guides/MEMORY_RUNTIME_CN.md)

这是一个可运行的 0.3 Memory Runtime sidecar 端到端演示。它使用**真实**的 Mebular
app、**真实**的 `startHttpServer`（含内部 Memory Capability API）和**真实** supervisor
启动 `mebular-memory-runtime`。图、capability API 和 sidecar 都不是 mock。

```bash
npm run build
node examples/memory-runtime-demo/index.mjs
```

演示会创建临时 Mebular home，结束时删除。需要保留并复用同一个目录时：

```bash
node examples/memory-runtime-demo/index.mjs --home /tmp/mebular-memory-demo
```

## 演示内容

1. **ingest 用户偏好**（`extractor=heuristic`）：“我喜欢深色主题，默认用中文回答。”
   确定性规则把 `preference` 写入 `user` 域。
2. **ingest 项目事实**（`extractor=host` 候选）：`mebular / port / 7331`。这是宿主提交的
   结构化数据，不是模型调用。
3. **宽泛 recall**（“你还记得我的偏好吗？”）只返回命中片段的 gist。脚本断言没有附加
   `detail`。
4. **具体 recall**（`7331`）展开事实详情，并断言原值 `7331` 存在。因为请求了
   `capture=local`，演示还会显示本机 Raw 原文；原文不会写入图。
5. **`/context`** 在 `maxBytes=2048` / `tokenBudget=500` 内组装请求级块，标记
   `trust=untrusted`、`purpose=background`。
6. **checkpoint** 通过 capability 写入 `task:<threadId>`，再从 sidecar 读回，显示
   `source=cloud` 和相同 revision。

脚本只输出简短中文摘要；代码和注释为英文。

## 前置与边界

- Node.js 20 或更新版本，且仓库已构建（`npm run build`）。演示直接 import `dist/` 与
  `packages/mcp/src`，不跑 TypeScript 源码。
- 仓库必须已有 `packages/memory-runtime/dist`。没有就先构建；演示会明确失败，不会静默跳过
  sidecar。
- 除非你已设置 `MEBULAR_MEMORY_RUNTIME_BIN`，否则脚本强制指向仓库内的 sidecar。
- **不访问外部网络、不下载模型、不调用模型。** 只用 `heuristic` 和 host candidates；
  sidecar 状态必须显示 `heuristic`。
- 只使用临时 home；不读写真实的 `~/.mebular`。
- 结束时先停止 sidecar 和 MCP server，再删除临时 home。使用 `--home` 时保留目录以便检查或
  复用。

## 输出形态

```text
[Mebular Memory Runtime Demo]
home: /tmp/...（临时，结束删除）
MCP daemon: http://127.0.0.1:<port>
Memory Runtime sidecar: http://127.0.0.1:<port>/memory-runtime/v1
sidecar 状态: ready · 模型来源: heuristic

[1/6] ingest 用户偏好（heuristic）
[2/6] ingest 项目事实（host candidates；不调用模型）
[3/6] 宽泛 recall：...（只给 gist）
[4/6] 具体问题：查询精确端口 7331（detail 展开）
[5/6] /context 预算块（blocks / bytes / tokens）
[6/6] checkpoint 写入/读取（revision / summary）
```

任一步失败时，脚本会打印 `演示失败：...`，包含失败的请求并返回非零退出码；不会吞掉
sidecar 缺失、记录缺失或详情不匹配。

## 相关

- [Memory Runtime 用户指南](../../docs/guides/MEMORY_RUNTIME_CN.md)
- [0.3.0 验收报告](../../docs/quality/0.3.0-memory-runtime-acceptance.md)
- [三宿主 E2E](../../tests/integration/host-e2e/README.md)
