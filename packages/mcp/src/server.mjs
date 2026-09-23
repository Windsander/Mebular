// MCP server 装配（G6.2）：stdio 传输 + 11 工具 + memory_policy prompt。
// 全部委托 MemoryService（D33 单一实现）。

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryService } from '@mebular/core';
import { createMebular, homeDir } from './config.mjs';
import { registerTools } from './tools.mjs';
import { startHttpServer, acquireLock } from './serve.mjs';
import { createJoinServer } from './jointoken.mjs';
import { clearApplyPending, readApplyPending, writeApplyResult, writeServeReady } from './config-apply.mjs';
import { buildSettings } from './admin.mjs';
import { isProvisionHome } from './provision.mjs';
import { advertiseHost, endpointHostname, isLoopbackHost } from './lan-host.mjs';

const MEMORY_POLICY = `# Mebular 记忆使用规约（memory_policy）
1. 先查后写：写入前先用 memory_query/memory_search 查重，避免重复。
2. 类型选择：稳定事实→fact；用户偏好→preference；会话/任务过程→episode；可复用步骤→skill；观察→observation。
3. 时效：有有效期的用 metadata.expiresAt；过期事实不要当现状。
4. 关系：相关对象用 metadata.relatedTo 精确关联（仅链接已存在节点）。
5. 隐私：不要写入密钥、口令、完整身份证件等高敏感信息。
6. 无结果别编：召回为空就如实说明，不要臆造记忆。`;

export function buildServer(service) {
  const server = new McpServer({ name: 'mebular', version: '0.1.0' });
  registerTools(server, service);
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

/** 启动 stdio MCP server；返回句柄用于收尾 */
export async function startStdioServer() {
  const { app } = await createMebular();
  const service = new MemoryService(app);
  const handle = serveStdio(() => buildServer(service));

  const shutdown = async () => {
    await handle.close().catch(() => undefined);
    await app.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { handle, app, service };
}

/**
 * 引导态服务器：空家目录时只服务 /healthz + /console（引导页）+ /app/provision/*（CSRF）。
 * 仅 loopback（fail-closed）；不起 Mebular app / 网络 / store —— 待用户在 GUI 选「建新 / 加入」后再重启进入正常态。
 */
export async function startProvisionServer(options = {}) {
  const home = homeDir();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7331;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback) {
    const error = new Error(`引导态仅允许 loopback（当前 host=${host}）：请用 --host 127.0.0.1 完成初始化`);
    error.code = 'MCP_PROVISION_LOOPBACK_REQUIRED';
    throw error;
  }
  const storagePath = process.env.MEBULAR_STORAGE_PATH ?? join(home, 'store.jsonl');
  const lock = await acquireLock(home, storagePath);
  try {
    const http = await startHttpServer({
      home,
      app: null,
      service: null,
      config: {},
      host,
      port,
      auth: 'none',
      tls: false,
      deviceId: null,
      provision: true,
      writesEnabled: true,
      runtime: null,
    });
    const shutdown = async () => {
      await http.close().catch(() => undefined);
      await lock.release();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return { ...http, lock, provision: true };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/**
 * 启动 Streamable HTTP server（G6.3）。
 * 单实例：先取 <home>/lock；被占抛 MCP_STORAGE_LOCKED。
 */
export async function startServeServer(options = {}) {
  const provisionHome = homeDir();
  // 引导态：真正的空家目录（无 config/主密钥/身份）→ 不自举 root；只起最小 HTTP（引导页 + provision API）
  if (isProvisionHome(provisionHome, { storagePath: process.env.MEBULAR_STORAGE_PATH })) {
    return await startProvisionServer(options);
  }
  const { app, home, storagePath, deviceId, config, effective } = await createMebular();
  const lock = await acquireLock(home, storagePath);
  let joinServer = null;
  try {
    const service = new MemoryService(app);
    // 参与配置：CLI 优先，其次 config.mcp.http（此前 serve 完全忽略 config，设置卡会失真）
    const httpCfg = config?.mcp?.http ?? {};
    const tlsKey = options.tlsKey ?? httpCfg.tlsKey;
    const tlsCert = options.tlsCert ?? httpCfg.tlsCert;
    // F-C1（A）：TLS 以**真开关**为准——config.mcp.http.tls===true，或显式提供证书；缺证书即启动报错（不静默降级）
    const tlsRequested = options.tls === true || httpCfg.tls === true || Boolean(tlsKey && tlsCert);
    const tlsReady = Boolean(tlsKey && tlsCert);
    if (tlsRequested && !tlsReady) {
      const error = new Error(
        'MCP_INSECURE_CONFIG：mcp.http.tls=true 但缺少证书——请在 config.json 填写 mcp.http.tlsKey 与 mcp.http.tlsCert，或关闭 tls',
      );
      error.code = 'MCP_INSECURE_CONFIG';
      throw error;
    }
    const runtime = {
      ...effective,
      storagePath,
      mcp: {
        host: options.host ?? httpCfg.host ?? '127.0.0.1',
        port: options.port ?? httpCfg.port ?? 7331,
        auth: options.auth ?? httpCfg.auth ?? 'none',
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
    const http = await startHttpServer({
      home,
      app,
      service,
      config,
      buildServer,
      host: runtime.mcp.host,
      port: runtime.mcp.port,
      auth: runtime.mcp.auth,
      tls: runtime.mcp.tls,
      tlsKey,
      tlsCert,
      tokensFile: options.tokensFile ?? httpCfg.tokensFile,
      deviceId,
      namespace: config.sync?.namespaces?.[0] ?? 'tasks',
      ...(joinEndpointDemo !== undefined ? { joinEndpoint: joinEndpointDemo } : {}),
      runtime,
      // D2：写端点默认开启（仍需 memory.admin scope + CSRF 双提交）；`MEBULAR_CONSOLE_WRITES=0` 可降级为 D1 只读
      writesEnabled: options.writesEnabled ?? process.env.MEBULAR_CONSOLE_WRITES !== '0',
    });
    // 监听端口 0 / 默认值时以实际绑定为准
    runtime.mcp.host = http.host;
    runtime.mcp.port = http.port;
    runtime.mcp.auth = http.auth;
    // W2 A4：join 服务由守护托管（令牌 → 委派证书）。fleet 不再托管生产 join。
    if (joinConf?.enabled) {
      try {
        joinServer = await createJoinServer({
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
      runtime.join = {
        enabled: true,
        bind: joinBind,
        port: joinServer.port,
        endpoint: joinEndpointDemo,
        endpointLoopback: joinEndpointLoopback,
      };
      console.error(`JOIN_READY ${JSON.stringify({ endpoint: joinEndpointDemo, port: joinServer.port, loopback: joinEndpointLoopback })}`);
    }
    // G：装配完成后写「已监听」标记——supervisor 用它判定新实例健康（join 失败则不写）
    await writeServeReady(home).catch(() => undefined);
    // G：若本次启动是「保存即生效」的候选实例 → 用新实例运行时算生效校验并落 result
    await finalizePendingApply({ home, app, service, config, runtime }).catch(() => undefined);
    // C7：邀请自动授权的 TTL 清扫（默认 24h 到期自动撤销；走既有 revokeGrant，不改授权语义）
    const { sweepAutoGrantRevokes } = await import('./jointoken.mjs');
    const grantSweepInterval = setInterval(() => {
      void sweepAutoGrantRevokes({ mebular: app, storagePath }).catch(() => undefined);
    }, 600_000);
    grantSweepInterval.unref?.();
    void sweepAutoGrantRevokes({ mebular: app, storagePath }).catch(() => undefined);

    // C5：地址自动广播的「可达性/地址变化」复查（app 侧节奏；库不装计时器）。
    // 只在开启广播时挂载；10 分钟一次（unref，不拖住宿主退出）；地址未变时 publish 自身去抖。
    const broadcastInterval = typeof app.getNetEndpointsStatus === 'function' && app.getNetEndpointsStatus().enabled
      ? setInterval(() => { void app.publishNetEndpoints?.('periodic').catch(() => undefined); }, 600_000)
      : null;
    broadcastInterval?.unref?.();

    const shutdown = async () => {
      if (broadcastInterval) clearInterval(broadcastInterval);
      clearInterval(grantSweepInterval);
      await joinServer?.close().catch(() => undefined);
      await http.close().catch(() => undefined);
      await lock.release();
      await app.shutdown().catch(() => undefined);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return { ...http, lock, app, service, joinServer, joinPort: joinServer?.port ?? null };
  } catch (error) {
    await joinServer?.close().catch(() => undefined);
    await lock.release();
    await app.shutdown().catch(() => undefined);
    throw error;
  }
}
