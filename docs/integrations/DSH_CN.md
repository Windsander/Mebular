# 在 DeepSeek Harness（DSH）中使用 Mebular

[English](DSH.md) · [返回文档索引](../README.md)

`@mebular/dsh-plugin` 把 Mebular 的记忆与任务图接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。它是一个轻量
DSH bundle：把官方的 `@deepseek-ai/dsh-mcp-client` 注册到**已经在运行**的 Mebular 守护进程上，
固定使用 **Streamable HTTP**。

## 两个面，同一张图

| 面 | 职责 |
| --- | --- |
| **Mebular App / 守护进程** | 控制面：身份、存储锁、信任、同步、星图控制台。 |
| **DSH** | Agent 面：在会话里理解并调用 Mebular 的记忆与任务工具。 |

插件不会替换 App：它不另起 Mebular 进程、不直接读本地存储、不 import `@mebular/*`，唯一
契约是守护进程公开的 HTTP `/mcp`。DSH 面板里的控制台入口会**在新浏览器标签页**打开
`http://127.0.0.1:7331/console`，**不使用 iframe** —— 控制台仍由 App 拥有（鉴权、存储、
星图、邀请）。

## 前提

1. 先启动 Mebular App，或单独运行守护进程：

   ```bash
   mebular serve            # 默认 MCP + 控制台端口 7331
   curl -sS http://127.0.0.1:7331/healthz
   ```

2. 确认默认端点为 `http://127.0.0.1:7331/mcp`。

> **用 HTTP，不要用 stdio。** stdio 会另起一个 Mebular 进程，和 App 的守护进程抢 storage
> lock（`MCP_STORAGE_LOCKED`）。插件的 `cordis.patch.yml` 固定
> `transport: streamable-http`；不要改成 `stdio`，也不要给条目加 `command:`。

## 安装

```bash
dsh plugin --profile web add @mebular/dsh-plugin
```

包内自带 `cordis.patch.yml`；安装后会向 web profile 插入插件 host entry，
以及一个 `@deepseek-ai/dsh-mcp-client` 实例，`serverName: mebular`、
`transport: streamable-http`，URL 指向默认 `/mcp`。重启 DSH 会话使 profile 生效。

## 验证

```bash
dsh web --dump-config | grep -A3 mebular
```

输出块里应包含 `serverName: mebular`、`transport: streamable-http` 和
`url: http://127.0.0.1:7331/mcp`。DSH 会话里的工具名形如 `mcp__mebular__*`（例如某个记忆
读写或任务工具）。调用一次并拿到 Mebular 的数据，就说明图已接通。

如果调用返回 `NOT_INITIALIZED`，先在锁定控制台里新建 / 加入忆云；同一个 MCP 会话会自动
恢复，不需要重启守护进程。如果 App 根本没运行，请先启动它 —— 插件不会替你启动。

## 自定义端口

默认端口是 `7331`。如果 Mebular 不在默认位置，两端要改成同一个端口：

- App / 守护进程：改 `~/.mebular/config.json` 的 `mcp.http.port`（或用
  `mebular serve --port <port>` 启动；`0` 表示自动分配）。
- 插件：修改安装后 profile 里的 patch（或改包内 `cordis.patch.yml` 后重装），让 `url`
  与之一致，例如：

  ```yaml
  - id: mcp-mebular
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: mebular
      transport: streamable-http
      url: http://127.0.0.1:12345/mcp
  ```

控制台地址跟随同一个守护端口：`http://127.0.0.1:<port>/console`。

## 插件位置

包代码在本仓库的 `packages/dsh-plugin`，以 `@mebular/dsh-plugin` 发布。GitHub topic 是
**仓库级**的：`dsh-plugin`、`deepseek-harness`、`agent-memory` 等关键词描述整个 Mebular
仓库，而不是一个独立包仓库，所以搜索会回到这里。

## 发布与版本

- 插件独立版本 `0.1.0`，有独立的 npm 生命周期。
- 它和 Mebular v0.1.0 走**同一条 release train**，首个公开插件与首个公开 Mebular 版本一起
  落地。
- 它**不进入**五包 lockstep（`core`、`service`、`skill`、`mcp`、`fleet`）：那五个包永远同
  版本，插件可以单独前进。
- 发布是幂等的：`publish-dsh` job 从 `packages/dsh-plugin/package.json` 读取版本，
  `npm view` 已存在则跳过，否则执行发布。详见[发布 SOP](../operations/RELEASE.md)。

## 卸载

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

这只移除 DSH 侧的 MCP 客户端；Mebular App、数据和运行中的控制台不受影响。
