<div align="center">

![Mebular](assets/banner.svg)

# Mebular

**让你的 AI 助手共用一份本地记忆。**

Mebular 跑在你自己的机器上：不管你用几个助手、几台设备，学到的东西都能共用。

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[官网](https://mebular.cyberfederal.io) · [开始使用](#开始使用) · [English](README.md)

</div>

---

## 开始使用

Mebular 是一个桌面 App，背后是本机的一个小服务。不用注册账号、不用租服务器、也不用先装
Node.js——App 会自己把服务准备好。

1. **拿到 App。** 从 [GitHub Releases](https://github.com/Windsander/Mebular/releases) 下载并打开。
   macOS、Windows、Linux 都支持。
2. **点「开始部署」。** 它会在本机启动本地服务，并接入这台机器上已经装好的 AI 助手。要做的就这一步，
   不上传到托管服务。
3. **二选一。** 控制台以锁定状态打开：第一台设备点「新建忆云」，后续设备点「加入忆云」。
   忆云是一份共享记忆空间，不是托管服务。

新建和加入都在同一进程、同一页面完成：不重启守护、不刷新页面，初始化一返回控制台就解锁。
整个过程不需要任何托管账号。

**你会看到什么。** 星图先只有这台机器一个节点，忆云存在前其它卡片不可用。新建或加入后，顶栏变成
「邀请设备」和「加入忆云」，其余卡片点亮。下一台机器就从顶栏邀请。

加第二台设备只要一个令牌：在已加入该忆云的设备上点「邀请设备」，拿到二维码或一次性令牌；在新机器上点
「加入忆云」，粘贴令牌即可。新设备拿到委派证书，主密钥不复制，之后各自同步。

前置条件很简单：一台 64 位的 macOS、Windows 或 Linux 机器。App 自己管理本地服务，上面的路径不需要终端，
也不需要管理员权限。

想用命令行，或者机器没有图形界面？同一个控制台也能在本机跑起来：

```bash
npm install -g @mebular/core   # 然后：mebular serve → http://127.0.0.1:7331/console
```

桌面、浏览器、命令行、源码四条路径的完整步骤见[快速上手](docs/getting-started/QUICKSTART_CN.md)。

## 你能做什么

- **跨会话记住上下文。** 助手用 `memory_write` 写下一条事实，之后你接上的每个助手都能召回它。
  技术栈、偏好、上个月定下的方案，不用再说一遍。
- **让任务在助手之间流动。** 用 `task_submit` 派一个任务，本机或另一台机器上的助手接手，
  结果回到同一份记忆里。整条链路看得见，不用猜中间发生了什么。
- **接上你已经在用的助手。** Mebular 走 MCP，直接接入现有工具：不用重写，也不用换供应商。

上面这些用的是同一份记忆：助手在一个工具里写下的内容，换一个助手能读到，换一台设备同步后也能读到。
想知道助手都知道些什么，你只需要看一个地方。

## 为什么本地优先

- **数据留在你的设备上。** 没有托管服务、没有账号，记忆写在你自己的本地存储里，随时可以备份。
- **每次改动都可审计。** 每次写入都签名并内容寻址，谁改了什么随时查得到。
- **离线也能用。** 断网照常干活，重连后设备自己补齐，最后收敛到同一份记忆。

忆云是设备之间直接同步的。这种取舍有边界——比如同一忆云内的设备可以读取它订阅的记忆域。
放敏感数据之前，先看[限制与取舍](docs/limitations/LIMITATIONS_CN.md)。

## 它是怎么工作的

![Mebular 架构图](assets/architecture-cn.svg)

每台机器跑一个本地服务，身份、存储和同步都归它管。助手通过 MCP 连到这个服务，彼此不直接对话。
设备之间再直接交换记忆，中间没有中心协调者。

## 了解更多

- **快速上手** — [桌面、浏览器、命令行与源码](docs/getting-started/QUICKSTART_CN.md)
- **控制台** — [本地界面能做什么](docs/console/README.md)
- **架构** — [运行时分层的信任模型](docs/architecture/ARCHITECT.md)
- **限制与取舍** — [已知边界](docs/limitations/LIMITATIONS_CN.md)
- **变更日志** — [发布说明](CHANGELOG.md)
- **参与贡献** — [质量门禁与参与方式](CONTRIBUTING.md)

<div align="center">

v0.1.0 · 早期 · MIT

</div>
