# Fleet 上车（订阅自主 · greenfield）

> 目标态只有四个概念：**设备（信任链）· 订阅（阅读权 + 维持义务）· 移出（唯一否定）· 安全档（动作门槛）**。
> 没有 grant/issuer/自动签发/对端×按域白名单；没有旧设备兼容层。

## 1. 建域（第一台）

```bash
fleet quickstart --daemon --dir ~/.mebular --device device-A
```

- 生成主密钥 + 设备身份 + `config.json`；
- 本机声明订阅默认域（`tasks`）；
- 启动 join 服务并生成加入令牌；
- 建域零门槛：任何设备都可以 `fleet namespace --namespace <name>` 写域公告。

## 2. 加入（第二台）

```bash
fleet join --token <令牌|文件> --daemon --dir ~/.mebular --device device-B
```

- 新设备取得委派证书链（不复制主密钥）；
- 新设备自行声明订阅；
- 订阅零门槛、无需批准；订阅热生效（无需重启）。

## 3. 订阅 / 退订

```bash
fleet subscribe   --dir ~/.mebular --namespace notes
fleet unsubscribe --dir ~/.mebular --namespace notes
fleet subscribers --dir ~/.mebular --namespace notes
```

- 订阅 = 阅读权 + 维持义务：接收该域更新，并把本机新增同步给其他订阅设备；
- 只能改自己（`author === member`）；不能替他人订阅/退订；
- 退订只改声明，不清本地历史；「退出并交接」才清本机数据与水位。

## 4. 移出 / 恢复

```bash
fleet security revoke --dir ~/.mebular --device device-B   # 移出（UI 称「移出」）
fleet restore --dir ~/.mebular --to device-B               # 恢复
```

- 移出是作者级：只拒被移出设备本人；不连坐其后代/新成员；
- 恢复建立新纪元 E-1：恢复前署名的订阅/移出/档位记录不复活；恢复后需重新订阅；
- high 档需会签或恢复码；medium 需本机动态码。

## 5. 医生

```bash
fleet doctor --dir ~/.mebular --json
```

关键项：

| 项 | 含义 |
|---|---|
| `namespace 订阅` | 本机是否已声明订阅该域 |
| `对端订阅` | 对端是否已声明订阅（未订阅不算失败，等待即可） |
| `移出状态` | 本机/对端是否被移出 |
| `peer 可达` | 地址簿中的对端是否可达 |

## 6. 命令边界

- 没有 `fleet grant` / `fleet revoke`（域授权）/ `fleet declare-issuer` / `fleet pending` / `fleet approve`；
- `fleet member(s)` 已改为 `subscribe` / `unsubscribe` / `subscribers`；
- 加入令牌不再携带自动授权/TTL 字段；高档次订阅证明由 `securityApproval` 携带。

## 7. 明确边界

- 订阅不提供域级保密：信任边界内、未被移出的设备可自行订阅任意域；
- 移出是逐台动作，不沿证书链传播；
- 不做「删除域」；全网删域属未来治理协议。
