// MCP server 装配（G6.2 + R1）：stdio 传输 + **27 工具**（记忆 11 + 任务 16）+ memory_policy prompt。
// 全部委托 MemoryService（D33 单一实现）。

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryService } from '@mebular/core';
import { createMebular, homeDir, loadConfigFile } from './config.mjs';
import { registerTools } from './tools.mjs';
import { startHttpServer, acquireLock, pidAlive } from './serve.mjs';
import { APP_VERSION } from './version.mjs';
import { createJoinServer } from './jointoken.mjs';
import { clearApplyPending, readApplyPending, writeApplyResult, writeServeReady } from './config-apply.mjs';
import { buildSettings } from './admin.mjs';
import { isProvisionHome } from './provision.mjs';
import { acquireActiveLock, profileIdForHome, resolveCloudRoot } from './profiles.mjs';
import { advertiseHost, endpointHostname, isLoopbackHost } from './lan-host.mjs';

const MEMORY_POLICY = `# Mebular 记忆使用规约（memory_policy）
1. 先查后写：写入前先用 memory_query/memory_search 查重，避免重复。
2. 类型选择：稳定事实→fact；用户偏好→preference；会话/任务过程→episode；可复用步骤→skill；观察→observation。
3. 时效：有有效期的用 metadata.expiresAt；过期事实不要当现状。
4. 关系：相关对象用 metadata.relatedTo 精确关联（仅链接已存在节点）。
5. 隐私：不要写入密钥、口令、完整身份证件等高敏感信息。
6. 无结果别编：召回为空就如实说明，不要臆造记忆。`;

export function buildServer(service, options = {}) {
  const server = new McpServer({ name: 'mebular', version: APP_VERSION });
  registerTools(server, service, options);
  server.registerPrompt(
    'memory_policy',
    {
      title: 'Mebular 记忆使用规约',
      description: '先查后写 / 类型选择 / 时效 / 隐私 / 关系 / 无结果别编',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: MEMORY_POLICY },
        },
      ],
    }),
  );
  return server;
}

/**
 * G2：本次启动是否为「保存即生效」的候选实例？是 → 用**新实例的运行时**计算本次改动字段的
 * 三元组（已配置/实际），写 <home>/config-apply.result.json（status=applied + verify[]）。
 * 校验不一致（如环境变量优先）不影响启动，交由前端红色提示。
 */
async function finalizePendingApply({ home, app, service, config, runtime }) {
  const pending = await readApplyPending(home);
  if (!pending || !Array.isArray(pending.fields) || pending.fields.length === 0) return;
  // 监督进程已判定回滚（新配置启动失败）：本实例是「回滚后的旧配置」——不得写 applied
  if (pending.rollingBack === true) return;
  let verify = [];
  try {
    const settings = await buildSettings({ app, service, config, runtime, home });
    const rows = new Map((settings.effective ?? []).map((row) => [row.path, row]));
    verify = pending.fields.map((path) => {
      const row = rows.get(path);
      if (!row) return { path, ok: null, note: '无三元组（非可编辑/只读项）' };
      const ok = JSON.stringify(row.configured ?? null) === JSON.stringify(row.actual ?? null);
      return { path, configured: row.configured ?? null, actual: row.actual ?? null, ok, reason: row.reason ?? null };
    });
  } catch (error) {
    verify = [{ path: '*', ok: null, note: `校验失败：${String(error?.message ?? error)}` }];
  }
  await writeApplyResult(home, {
    status: 'applied',
    attempt: pending.attempt ?? null,
    at: new Date().toISOString(),
    fields: pending.fields,
    verify,
    waitedMs: null,
  }).catch(() => undefined);
  await clearApplyPending(home);
}

/**
 * 启动 stdio MCP server；返回句柄用于收尾。
 * F-CLI-2：守护（`serve`）在运行时拒绝启动 stdio —— 否则第二写者会同库写、并抢 P2P 监听端口。
 * 客户端应指向守护的 HTTP `/mcp`（`mebular print-config --client <id> --url <daemon>/mcp`），或先停止守护。
 */
export async function startStdioServer() {
  const home = homeDir();
  const lockPath = join(home, 'lock');
  if (existsSync(lockPath)) {
    let held = null;
    try {
      held = JSON.parse(await readFile(lockPath, 'utf-8'));
    } catch {
      held = null;
    }
    if (held?.pid && pidAlive(held.pid)) {
      const error = new Error(
        `守护已在运行（pid ${held.pid}）：stdio 会与它争用存储与监听端口。`
          + '请把客户端指向守护的 HTTP /mcp（mebular print-config --client <id> --url http://<host>:<port>/mcp），或先停止守护。',
      );
      error.code = 'MCP_STORAGE_LOCKED';
      throw error;
    }
  }
  const { app } = await createMebular();
  const service = new MemoryService(app);
  // stdio 也是「本进程唯一写者」：任务工具复用同一个 app（同一 EventLog），不再另开离线实例。
  const handle = serveStdio(() => buildServer(service, { toolContext: { home, mebular: app } }));

  const shutdown = async () => {
    await handle.close().catch(() => undefined);
    await app.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { handle, app, service };
}

function runtimeMcpPort(config, options = {}) {
  return options.port ?? config?.mcp?.http?.port ?? 7331;
}

/**
 * P1：统一 serve 生命周期（UNINITIALIZED → INITIALIZING → READY）。
 *
 * - 无论空 home 还是已初始化 home，都只启动**一个** HTTP server、只取**一次** <home>/lock；
 * - 空 home 的 create/join 由同一进程热初始化（app / join service / 运行时快照就地切换），不重启、不换端口；
 * - 失败由 serve.mjs 回滚本次落盘产物，再回到 UNINITIALIZED（锁不释放、不重抢）。
 *
 * 启动 Streamable HTTP server（G6.3）。
 * 单实例：先取 <home>/lock；被占抛 MCP_STORAGE_LOCKED。
 */
export async function startServeServer(options = {}) {
  const home = homeDir();
  const provisionStart = isProvisionHome(home, { storagePath: process.env.MEBULAR_STORAGE_PATH });
  // F-NET-1（C）：**先取单实例锁，再初始化网络**——第二写者应在绑定监听端口前就得到
  // 可读的 MCP_STORAGE_LOCKED（此前 createMebular 先启网络 → 抢 4001 → 裸 EADDRINUSE）。
  const preConfig = provisionStart ? {} : await loadConfigFile(home).catch(() => ({}));
  const { storagePathForHome } = await import('./home-identity.mjs');
  const preStoragePath = storagePathForHome(home, preConfig, process.env);
  const lock = await acquireLock(home, preStoragePath);

  // 热初始化 / 正常启动共用：app、join 服务、运行时快照与生命周期资源。
  let current = null;
  let httpServer = null;

  const stopBroadcast = (context) => {
    if (context?.broadcastInterval) {
      clearInterval(context.broadcastInterval);
      context.broadcastInterval = null;
    }
  };

  const stopRuntime = async (context) => {
    if (!context) return;
    stopBroadcast(context);
    await context.joinServer?.close().catch(() => undefined);
    await context.activeLock?.release?.().catch(() => undefined);
    await context.app?.shutdown().catch(() => undefined);
  };

  const startBroadcast = (context) => {
    if (typeof context.app.getNetEndpointsStatus !== 'function' || !context.app.getNetEndpointsStatus().enabled) {
      return null;
    }
    // C5：地址自动广播的「可达性/地址变化」复查（app 侧节奏；库不装计时器）。
    // 只在开启广播时挂载；10 分钟一次（unref，不拖住宿主退出）；地址未变时 publish 自身去抖。
    const interval = setInterval(() => {
      void context.app.publishNetEndpoints?.('periodic').catch(() => undefined);
    }, 600_000);
    interval.unref?.();
    return interval;
  };

  const finalizeRuntime = async (context) => {
    await writeServeReady(home).catch(() => undefined);
    await finalizePendingApply({
      home,
      app: context.app,
      service: context.service,
      config: context.config,
      runtime: context.runtime,
    }).catch(() => undefined);
    context.broadcastInterval = startBroadcast(context);
  };

  /**
   * 创建 app + join 服务 + 运行时快照。
   * hot=true：create/join 已写盘，须在同一进程内接管；此时额外取 root 级单活锁并立即写 ready。
   */
  const startRuntime = async ({ serverContext, hot = false } = {}) => {
    let context = null;
    try {
      const created = await createMebular();
      const { app, storagePath, deviceId, config, effective } = created;
      const service = new MemoryService(app);
      const httpCfg = config?.mcp?.http ?? {};
      const tlsKey = serverContext?.tlsKey ?? options.tlsKey ?? httpCfg.tlsKey;
      const tlsCert = serverContext?.tlsCert ?? options.tlsCert ?? httpCfg.tlsCert;
      const tlsRequested = serverContext
        ? Boolean(serverContext.tls)
        : (options.tls === true || httpCfg.tls === true || Boolean(tlsKey && tlsCert));
      const tlsReady = Boolean(tlsKey && tlsCert);
      if (!serverContext && tlsRequested && !tlsReady) {
        const error = new Error(
          'MCP_INSECURE_CONFIG：mcp.http.tls=true 但缺少证书——请在 config.json 填写 mcp.http.tlsKey 与 mcp.http.tlsCert，或关闭 tls',
        );
        error.code = 'MCP_INSECURE_CONFIG';
        throw error;
      }
      const mcpHost = serverContext?.host ?? options.host ?? httpCfg.host ?? '127.0.0.1';
      const mcpPort = serverContext?.port ?? runtimeMcpPort(config, options);
      const mcpAuth = serverContext?.auth ?? options.auth ?? httpCfg.auth ?? 'none';
      const runtime = {
        ...effective,
        storagePath,
        mcp: {
          host: mcpHost,
          port: mcpPort,
          auth: mcpAuth,
          tls: Boolean(tlsRequested && tlsReady),
          tlsKeyConfigured: Boolean(tlsKey),
          tlsCertConfigured: Boolean(tlsCert),
        },
      };
      const joinConf = config.joinService;
      const joinBind = joinConf?.bind ?? '0.0.0.0';
      // F-C6：令牌里的 endpoint 必须是新设备可直达地址——bind 通配时取本机 LAN IPv4（无则回环并告警），
      // 也允许 joinService.endpoint 显式固定（跨网段/NAT 场景）。
      const joinAdvertise = advertiseHost(joinBind);
      const joinEndpointDemo = joinConf?.enabled
        ? (typeof joinConf.endpoint === 'string' && joinConf.endpoint
          ? joinConf.endpoint
          : `http://${joinAdvertise}:${joinConf.port ?? 4002}`)
        : undefined;
      const joinEndpointHost = joinEndpointDemo !== undefined ? endpointHostname(joinEndpointDemo) : null;
      const joinEndpointLoopback = joinEndpointHost !== null && isLoopbackHost(joinEndpointHost);

      context = {
        app,
        service,
        config,
        runtime,
        deviceId,
        storagePath,
        namespace: config.sync?.namespaces?.[0] ?? 'tasks',
        joinEndpoint: joinEndpointDemo,
        joinServer: null,
        joinPort: null,
        broadcastInterval: null,
        activeLock: null,
      };

      // W2 A4：join 服务由守护托管（令牌 → 委派证书）。fleet 不再托管生产 join。
      if (joinConf?.enabled) {
        try {
          context.joinServer = await createJoinServer({
            mebular: app,
            deviceId,
            storagePath,
            bind: joinConf.bind ?? '0.0.0.0',
            port: joinConf.port ?? 4002,
            log: (m) => console.error(m),
          });
        } catch (error) {
          // E：启动失败根因化——不笼统报「serve 起不来」，明确指出是可执行的修复动作
          const bind = joinConf.bind ?? '0.0.0.0';
          const port = joinConf.port ?? 4002;
          const detail = {
            at: new Date().toISOString(),
            code: error?.code === 'EADDRINUSE' ? 'JOIN_PORT_IN_USE' : (error?.code ?? 'JOIN_START_FAILED'),
            bind,
            port,
            message: error?.code === 'EADDRINUSE'
              ? `joinService.port ${port} 被占（bind=${bind}）：改端口（如 joinService.port=0 由系统分配）或释放占用`
              : `joinService 启动失败（${error?.code ?? 'ERROR'}，bind=${bind}:${port}）：${error?.message ?? error}`,
          };
          await writeFile(join(home, 'join.error.json'), JSON.stringify(detail, null, 2), 'utf-8').catch(() => undefined);
          const wrapped = new Error(detail.message);
          wrapped.code = detail.code;
          wrapped.cause = error;
          throw wrapped;
        }
        await rm(join(home, 'join.error.json'), { force: true }).catch(() => undefined);
        context.joinPort = context.joinServer.port;
        runtime.join = {
          enabled: true,
          bind: joinBind,
          port: context.joinServer.port,
          endpoint: joinEndpointDemo,
          endpointLoopback: joinEndpointLoopback,
        };
        console.error(`JOIN_READY ${JSON.stringify({ endpoint: joinEndpointDemo, port: context.joinServer.port, loopback: joinEndpointLoopback })}`);
      }

      if (hot) {
        // P1：同一进程切换，先确认 root 级没有别的活实例，再写 ready。
        const cloud = resolveCloudRoot({ home, env: process.env });
        if (cloud.available) {
          const cloudId = await profileIdForHome(cloud.root, home).catch(() => null);
          context.activeLock = await acquireActiveLock({ root: cloud.root, home, profileId: cloudId });
        }
        await finalizeRuntime(context);
      }
      return context;
    } catch (error) {
      await stopRuntime(context);
      throw error;
    }
  };

  // TLS 以**真开关**为准——config.mcp.http.tls===true，或显式提供证书；缺证书即启动报错（不静默降级）。
  const initialHttpCfg = preConfig?.mcp?.http ?? {};
  const initialTlsKey = options.tlsKey ?? initialHttpCfg.tlsKey;
  const initialTlsCert = options.tlsCert ?? initialHttpCfg.tlsCert;
  const initialTlsRequested = options.tls === true || initialHttpCfg.tls === true
    || Boolean(initialTlsKey && initialTlsCert);
  const initialTlsReady = Boolean(initialTlsKey && initialTlsCert);
  if (!provisionStart && initialTlsRequested && !initialTlsReady) {
    await lock.release();
    const error = new Error(
      'MCP_INSECURE_CONFIG：mcp.http.tls=true 但缺少证书——请在 config.json 填写 mcp.http.tlsKey 与 mcp.http.tlsCert，或关闭 tls',
    );
    error.code = 'MCP_INSECURE_CONFIG';
    throw error;
  }
  const serverHost = options.host ?? initialHttpCfg.host ?? '127.0.0.1';
  if (provisionStart) {
    const loopback = serverHost === '127.0.0.1' || serverHost === 'localhost' || serverHost === '::1';
    if (!loopback) {
      await lock.release();
      const error = new Error(`引导态仅允许 loopback（当前 host=${serverHost}）：请用 --host 127.0.0.1 完成初始化`);
      error.code = 'MCP_PROVISION_LOOPBACK_REQUIRED';
      throw error;
    }
  }

  // 引导态强制 loopback + auth none（旧 startProvisionServer 契约）：初始化完成后热切换为
  // create/join 写入的正常配置；避免 --auth bearer 等 CLI 覆盖让 READY 后自己的 admin API 不可用。
  const serverAuth = provisionStart ? 'none' : (options.auth ?? initialHttpCfg.auth ?? 'none');
  const serverTls = provisionStart ? false : Boolean(initialTlsRequested && initialTlsReady);
  const serverTlsKey = provisionStart ? undefined : initialTlsKey;
  const serverTlsCert = provisionStart ? undefined : initialTlsCert;

  try {
    if (!provisionStart) {
      current = await startRuntime({ hot: false });
    }
    httpServer = await startHttpServer({
      home,
      app: current?.app ?? null,
      service: current?.service ?? null,
      config: current?.config ?? {},
      buildServer,
      host: serverHost,
      port: options.port ?? initialHttpCfg.port,
      auth: serverAuth,
      tls: serverTls,
      tlsKey: serverTlsKey,
      tlsCert: serverTlsCert,
      tokensFile: options.tokensFile ?? initialHttpCfg.tokensFile,
      deviceId: current?.deviceId ?? null,
      namespace: current?.namespace ?? 'tasks',
      ...(current?.joinEndpoint !== undefined ? { joinEndpoint: current.joinEndpoint } : {}),
      runtime: current?.runtime ?? null,
      // D2：写端点默认开启（仍需 memory.admin scope + CSRF 双提交）；`MEBULAR_CONSOLE_WRITES=0` 可降级为 D1 只读
      writesEnabled: options.writesEnabled ?? process.env.MEBULAR_CONSOLE_WRITES !== '0',
      provision: provisionStart,
      initializeRuntime: async ({ action, result, server }) => {
        const next = await startRuntime({ action, result, serverContext: server, hot: true });
        current = next;
        return next;
      },
      onClose: async () => {
        const context = current;
        current = null;
        await stopRuntime(context);
      },
    });
    // 监听端口 0 / 默认值时以实际绑定为准
    if (current) {
      current.runtime.mcp.host = httpServer.host;
      current.runtime.mcp.port = httpServer.port;
      current.runtime.mcp.auth = httpServer.auth;
      // G：装配完成后写「已监听」标记——supervisor 用它判定新实例健康（join 失败则不写）
      await finalizeRuntime(current);
      // Skill 收敛（启动/升级）：受管旧版更新、用户修改保留；失败只记录，绝不阻断 serve。
      void import('./clients.mjs')
        .then(({ autoEnsureSkills, assistantUserHome }) => autoEnsureSkills({ home, userHome: assistantUserHome(), cwd: process.cwd() }))
        .then((result) => {
          if (result?.summary?.failed > 0 || (result?.ok === false && result?.skipped !== true)) {
            console.error(`SKILL_ENSURE_PENDING_REPAIR ${result?.reason ?? `${result?.summary?.failed ?? 1} client(s)`}`);
          }
        })
        .catch((error) => console.error(`SKILL_ENSURE_FAILED ${error?.code ?? 'ERROR'}`));
    }

    const shutdown = async () => {
      await httpServer?.close().catch(() => undefined);
      await lock.release();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return {
      ...httpServer,
      lock,
      provision: provisionStart,
      getRuntime: () => current,
      getState: () => ({ ...httpServer.getState(), runtimeReady: current !== null }),
    };
  } catch (error) {
    await httpServer?.close().catch(() => undefined);
    if (!httpServer) {
      await stopRuntime(current);
      current = null;
    }
    await lock.release();
    throw error;
  }
}
