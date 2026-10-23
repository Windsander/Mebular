# @mebular/dsh-plugin

把 Mebular 的记忆与任务图接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。
插件只做一件事：把正在运行的 Mebular daemon 的公开 HTTP MCP 端点注册成 `mebular` 工具面。

- **App 是控制面**：Mebular App / daemon 继续独立运行、继续负责存储与 UI。
- **DSH 只拿到 MCP 工具**：不共享进程、不读取本地存储、不 import `@mebular/*`。
- **不走 stdio**：stdio 模式会另起一个 Mebular 进程并和 App daemon 抢 storage lock；本插件固定使用 Streamable HTTP。

## 前提

先启动 Mebular App（或单独运行 daemon），确认默认 MCP 端点已就绪：

```bash
curl -sS http://127.0.0.1:7331/healthz
```

默认端口是 `7331`，MCP 路径是 `/mcp`。

## 安装

在 DSH 的 web profile 中安装：

```bash
dsh plugin --profile web add @mebular/dsh-plugin
```

插件包内自带 `cordis.patch.yml`，安装后会向 profile 插入一个
`@deepseek-ai/dsh-mcp-client` 实例（`serverName: mebular`、`transport: streamable-http`）。

## 验证

重启 DSH 会话后，工具列表里应出现 `mebular` 服务下的工具，命名形如：

```text
mcp__mebular__*
```

例如让 DSH 调用 `mcp__mebular__*` 中的记忆检索/写入工具；能返回 Mebular 的数据即接通。
DSH 与 Mebular App 同时保持运行，App 不会因为安装插件而退出或消失。

## 自定义端口

如果 Mebular 不在默认的 `127.0.0.1:7331`，修改安装后 profile 中本插件的 patch
（或直接编辑插件包里的 `cordis.patch.yml`）里的 `url`：

```yaml
- insert:
    - id: mebular
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mebular
        transport: streamable-http
        url: http://127.0.0.1:12345/mcp
```

端口需要和 Mebular 的 `mcp.http.port`（或 `mebular serve --port`）一致。

## 卸载

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

这只移除 DSH 侧的 MCP 客户端，不会影响 Mebular App 及其数据。

## License

MIT
