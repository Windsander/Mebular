# 共享 Runtime 操作指南

本页是 [RUNTIME-COEXISTENCE.md](../architecture/RUNTIME-COEXISTENCE.md) 的简明操作版：
如何查看/安装/升级/回滚共享 runtime，以及 App 与 DSH Plugin 两个入口如何安全共存。
命令都在本机执行，不需要外网（安装/检查更新除外）。

## 1. 先看状态

```bash
mebular runtime status --json
mebular runtime resolve --json
mebular runtime current show --json
mebular runtime provider list --json
mebular runtime service status --json
```

关注：

- `mode`：`reused`（已 attach）/ `service` / `child` / `down`；
- `instance` 是否等于当前 home 的 `homeKey`；
- `current.version` 与 `daemon.version` 是否一致（运行中的 daemon 是版本真源）；
- `provider.kind`：`app` / `cli` / `shared`；
- `service.registered/running/foreign` 是否正常。

两个入口同时运行时，它们应指向同一个 `home`/`homeKey` 和同一个 daemon。看到两个不同端口、
两个 daemon 或 `service.foreign`，先停下排查，不要继续安装。

## 2. 两个入口的默认行为

| 入口 | 默认 | 说明 |
| --- | --- | --- |
| App | 启动时 ensure/attach；child 由 App 持有 | Console「让 Mebular 常驻」才安装 service |
| DSH Plugin | `lifecycle: attach`、`bootstrap: prompt` | 只连接已有 runtime；不会因安装插件而静默下载/启动 |

Plugin 的可选配置（`cordis.patch.yml`）：

```yaml
- insert:
    - id: mebular
      name: '@mebular/dsh-plugin'
      config:
        lifecycle: attach    # attach | managed | auto
        runtime: auto        # auto | external（external = 永不启动）
        persistence: child   # child | service（service 需要已存在 service）
        bootstrap: prompt    # prompt | never（never = 不显示/拒绝安装）
        panel: true
```

显式 `daemonUrl` 会固定一个实例，并且始终 attach-only。

## 3. 安装 / 重装共享 runtime

只有确认没有 App/CLI provider、且用户同意时才安装：

```bash
# 固定版本（CLI/App 默认取 core APP_VERSION；Plugin 面板取插件 package version）
mebular runtime install --version 0.2.2 --json

# 同版本损坏/需要覆盖时
mebular runtime reinstall --version 0.2.2 --json
```

Plugin 面板触发的安装使用**插件自身 `package.json` 的 `version`**（运行时读取，发布 bump 无需改
插件源码）；同一 release train 中它与 `@mebular/core` 版本一致。CLI/App 安装器默认版本仍是 core 的
`APP_VERSION`。

成功后：

- `<cloudRoot>/runtime/<version>/` 是完整安装；
- `runtime/current.json` 指向该版本；
- `runtime-providers.json` 增加 `kind: shared`；
- 失败时旧 current/provider/runtime 保留，staging 清理，不会留下半个 runtime。

`install` 对已存在且完整的同版本是幂等的；`reinstall` 才会覆盖同版本并保留旧目录 backup。

## 4. 启动更新检查与升级

```bash
# 只检查，不安装（24h 节流；--force 忽略节流）
mebular runtime check-update --json
mebular runtime update-state show --json

# 用户选择「跳过此版本」/「已提示」
mebular runtime update-state skip --version 0.1.3 --json
mebular runtime update-state prompted --version 0.1.3 --json

# 显式升级到指定版本或 check-update 已知的 latest
mebular runtime upgrade --to 0.1.3 --json
mebular runtime upgrade --to latest --json

# 升级状态/锁诊断
mebular runtime upgrade-state show --json
```

规则：

- 来源固定为官方 npm `@mebular/core` stable；不接受任意 URL/registry。
- 两个入口共享 `update.lock` / `upgrade.lock`；一个执行时另一个返回 `busy` 并等待重连，
  不重复下载/提示。
- 升级保留旧版本目录，失败会恢复 previous current/provider；不会自动降级或起第二版本。
- service 已注册时会更新并重启 service；未注册时只切 current，不启动 daemon。

## 5. 常驻 service

```bash
mebular runtime service install --json
mebular runtime service status --json
mebular runtime service restart --json

# 只移除 unit/manifest；runtime/provider/data 保留
mebular runtime service uninstall --json
```

manifest 位于用户 home 的 `.mebular/services/mebular-serve.json`，记录
`version/runtimePath/cliPath/provider/owner/home/cloudRoot`。service unit 落在 OS 用户 home，
不在 profile 目录。若 `service.foreign=true`，说明同 label 被其他 home 占用，不要覆盖。

## 6. 回滚与降级

推荐顺序（都不需要删除 `~/.mebular`）：

1. **Plugin 退回 attach-only**：`lifecycle: attach`、`runtime: external`、`bootstrap: never`。
2. **停止本次入口的 child**：退出 App/Plugin；service 不会被停。
3. **停用常驻**：`mebular runtime service uninstall`。
4. **回到旧 runtime**（旧目录仍保留时）：

   ```bash
   mebular runtime current set \
     --version 0.2.2 \
     --runtime-path ~/.mebular/runtime/0.2.2 \
     --cli ~/.mebular/runtime/0.2.2/node_modules/@mebular/core/packages/mcp/bin/mebular.mjs \
     --provider shared --owner shared --json
   ```

   然后 `runtime service restart`（常驻）或重新打开入口 ensure。旧目录不存在时使用
   `runtime reinstall --version <old>` 重新安装。

5. **不要清空 home**：数据、身份、provider/current 都在 `~/.mebular`；回滚不需要删数据。

目前没有 `runtime uninstall` CLI；`runtime service uninstall` 只停常驻，旧 runtime 目录需人工
确认无入口使用后再删除。data 永不默认删除。

## 7. 灰度和观察点

建议按入口逐步放开，不要一次全量：

1. CLI/App：验证 `resolve/ensure/status`、provider、child/service；
2. Plugin attach-only（`bootstrap: never`）：只观察连接与状态，不启动；
3. Plugin `managed` / `auto`：先用 child，再验证 service 常驻；
4. plugin-only 安装：只对明确点击安装的用户开放。

观察：`/healthz` 的 `instance`、`runtime.json` 的 `pid/http`、`runtime-providers.json` 的
`kind/path/version`、service manifest 的 `provider/owner/version`、`update-state`/`upgrade-state`
的 `busy`/`reason`。任务运行中不要升级；选择「稍后」。

## 8. 常见问题

| 现象 | 先检查 | 处理 |
| --- | --- | --- |
| Plugin 显示 `download_required` | `runtime provider list` | 打开 App/安装 CLI；或用户显式点安装 |
| `instance_mismatch` / `cloud_mismatch` | 端口上是谁在跑 | 停止另一个忆云或换端口，不要 attach |
| `service_unknown` / `service_foreign` | `runtime service status` | 修复/重试 service；foreign 不覆盖他人 |
| `start_locked` | `runtime-start.lock` 的 PID | 等健康或清理陈旧 PID 锁 |
| `install_locked` | `runtime/install.lock` | 等另一个入口安装完成 |
| 升级 `busy` | `runtime upgrade-state show` | 等对方结束并 reconnect，不重复执行 |
| current invalid | `runtime current show` | 重新安装或显式 `current set` 修复 |
| 更新后仍跑旧版本 | `runtime status` 的 daemon.version | 重启 service/入口；运行中 daemon 是版本真源 |

## 9. 验证

```bash
npm run verify:runtime:coexistence   # 离线共存 E2E
npm run verify:dsh-plugin            # 插件契约
npm test -- --runInBand tests/mcp/runtime-*.test.mjs
```

E2E 使用真实 CLI 子进程、隔离临时 home/root、fake provider/daemon/npm；不访问外网，不安装
真实系统 service，运行结束清理临时目录与进程。
