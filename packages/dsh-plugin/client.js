/* eslint-env browser */
// @mebular/dsh-plugin browser half.
//
// This is a hand-written DSH client bundle: no JSX, no build step, and exactly
// one module request (`react`). It contributes a sidebar icon and a root-scoped
// `main` panel. The panel does not reimplement Console; it embeds the shared
// Mebular Console served by the daemon at /console/?embed=dsh.
//
// Nothing here imports @mebular/*. State comes only from the host plugin's
// loopback-only GET /mebular/embed-info route.

window.__ModuleLoader__.load({
  id: '@mebular/dsh-plugin',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const EMBED_INFO_PATH = '/mebular/embed-info';
    const RUNTIME_INSTALL_PATH = '/mebular/runtime/install';
    const RUNTIME_UPGRADE_PATH = '/mebular/runtime/upgrade';
    const README_URL = 'https://github.com/Windsander/Mebular#readme';
    const DEFAULT_CONSOLE_URL = 'http://127.0.0.1:7331/console';
    const POLL_MS = 2500;
    const FETCH_TIMEOUT_MS = 4000;
    const FRAME_TIMEOUT_MS = 12000;

    const TEXT = {
      en: {
        title: 'Mebular',
        connected: 'Connected',
        checking: 'Connecting',
        starting: 'Starting',
        offline: 'Offline',
        unavailable: 'Unavailable',
        connectingTitle: 'Connecting to Mebular',
        connectingBody: 'Waiting for the local Mebular daemon to answer.',
        startingTitle: 'Starting Mebular',
        startingBody: 'The DSH plugin is starting the local Mebular daemon. This usually takes a few seconds.',
        offlineTitle: 'Mebular is not running',
        downloadTitle: 'Open or install Mebular',
        installTitle: 'Install Mebular Runtime',
        installBody: 'No Mebular app, CLI, service or shared runtime was found. Install the pinned Mebular runtime, initialize it, and start it once. Nothing is downloaded unless you click Install.',
        installingTitle: 'Installing Mebular Runtime',
        installingBody: 'Downloading and verifying the pinned Mebular runtime, then initializing and starting it. This can take a few minutes; keep DSH open.',
        installFailedTitle: 'Mebular Runtime installation failed',
        installFailedBody: 'Nothing was started and the previous runtime (if any) is unchanged. Retry, reinstall, or run the manual command and check again.',
        installAction: 'Install',
        installRetry: 'Retry',
        installReinstall: 'Reinstall Runtime',
        installCopy: 'Copy manual command',
        installCopied: 'Copied',
        installRedetect: 'Check again',
        installManualHint: 'Manual install: run this command, then click “Check again”.',
        installReadme: 'Installation guide',
        installVersion: 'Target version: {version}',
        installDone: 'Mebular Runtime is ready',
        installReasonLabel: 'Reason: {reason}',
        updateAvailable: 'Update available',
        updateMessage: 'Mebular {current} → {latest}',
        updateAction: 'Update',
        updateLater: 'Later',
        updateSkip: 'Skip this version',
        updateUpdatingTitle: 'Updating Mebular',
        updateUpdatingBody: 'Installing the new runtime, then reconnecting. Keep DSH open.',
        updateFailedTitle: 'Mebular update failed',
        updateFailedBody: 'The previous runtime (if any) is still in use.',
        updateReasonLabel: 'Reason: {reason}',
        updateBusy: 'Another Mebular entry point is updating the runtime. Wait for it to finish, then reconnect.',
        updateReconnectFailed: 'The update finished but the panel could not reconnect. Refresh or open Console.',
        serviceTitle: 'Mebular runtime conflict',
        profileTitle: 'Mebular profile mismatch',
        cliMissingTitle: 'Mebular CLI not found',
        incompatibleTitle: 'Mebular Console cannot be embedded',
        frameFailedTitle: 'Mebular Console did not load',
        openConsole: 'Open Console',
        openInBrowser: 'Open Console in browser',
        refresh: 'Refresh',
        hostUnavailable: 'Panel route unavailable',
        loadingFrame: 'Loading Console…',
        error: 'The DSH host could not read Mebular status: {error}',
        reasons: {
          daemon_unreachable: 'No Mebular daemon answered on the configured loopback address. MCP tools are unavailable until it starts; start Mebular or run "mebular serve", then the panel and tools recover automatically.',
          daemon_unhealthy: 'Mebular answered, but its health check did not report ready. Check the Mebular logs, then refresh.',
          download_required: 'No Mebular runtime was found on this machine. Open the Mebular app or install the Mebular CLI, then restart DSH; the panel and MCP tools connect automatically once it runs. This plugin does not download Mebular.',
          offline: 'The npm registry is unreachable because this machine appears to be offline. Reconnect, then retry or use the manual command.',
          registry_unreachable: 'The npm registry could not be reached. Check the network/proxy settings, then retry or use the manual command.',
          http_error: 'The npm registry refused the download (HTTP error). Retry later, or install the pinned version manually.',
          integrity_mismatch: 'The downloaded runtime did not match the pinned version or was incomplete. Reinstall Runtime and the plugin will verify it again.',
          disk_full: 'The disk is full, so the runtime could not be installed. Free some space, then retry.',
          permission_denied: 'The runtime directory is not writable. Fix its permissions, then retry; the previous runtime was kept.',
          npm_missing: 'npm was not found. Install Node.js/npm, then retry or use the manual command.',
          unsupported_version: 'The pinned runtime version is not available from npm. Update the plugin or install a supported version manually.',
          cancelled: 'The runtime installation was cancelled or timed out. Retry when ready; no partial runtime was started.',
          install_locked: 'Another Mebular entry point is installing the runtime. Wait for it to finish, then check again.',
          provider_registration_failed: 'The runtime was installed but could not be registered for App/CLI discovery. Fix runtime-providers.json, then retry; nothing was started.',
          init_failed: 'The runtime was installed but initialization failed, so it was not started. Retry; existing Mebular data and identity were not overwritten.',
          start_failed: 'The runtime was installed but did not become ready. Retry, check the Mebular logs, or start Mebular manually.',
          install_failed: 'The Mebular runtime could not be installed. Retry, reinstall, or use the manual command.',
          provisioning: 'The shared Mebular runtime supervisor is starting Mebular. This usually takes a few seconds.',
          service_conflict: 'The Mebular background service cannot be reused safely (another owner or unverifiable state). Open Mebular, check its service status, then refresh.',
          service_unknown: 'The plugin cannot verify the Mebular background service state. Check the Mebular service (or reinstall it from the Mebular Console), then refresh; no second daemon will be started.',
          service_foreign: 'The Mebular background service belongs to another Mebular home. Stop that instance or switch this profile; the plugin will not overwrite it.',
          service_not_registered: 'This profile is configured with persistence:service, but the Mebular background service is not installed. Open Mebular and enable “Keep Mebular running” in its Console, or switch persistence back to child.',
          profile_mismatch: 'The daemon on this address belongs to a different Mebular profile. Switch Mebular to this profile or close the other instance; the plugin will not start a second daemon.',
          instance_mismatch: 'The daemon on this address serves a different Mebular workspace. Close the other instance or switch profiles; the plugin will not start a second daemon.',
          instance_missing: 'The daemon on this address has no workspace identity, so the plugin cannot verify it. Restart Mebular from the same profile.',
          cloud_mismatch: 'The daemon on this address serves a different Mebular cloud. Switch Mebular to this cloud or close the other instance.',
          CLOUD_ALREADY_ACTIVE: 'Another Mebular instance already runs a different profile. Stop it or switch this profile; no second daemon will be started.',
          port_in_use: 'The configured Mebular port is used by another program. Free the port or change the Mebular port; the plugin will not start a second daemon.',
          version_mismatch: 'The running Mebular runtime is a different version than this plugin expects. Update Mebular or the plugin, then restart DSH.',
          managed_cli_missing: 'No Mebular CLI or app runtime was found. Open the Mebular app or install the Mebular CLI, then restart DSH.',
          managed_start_failed: 'The shared runtime supervisor started Mebular but it did not become healthy. Check the Mebular logs or start Mebular manually; the panel and tools recover automatically once it is up.',
          supervise_failed: 'The shared runtime supervisor exited before reporting a ready daemon. Check the Mebular logs; the plugin will not start a second daemon.',
          child_exited: 'The Mebular runtime this plugin started has exited. Start Mebular again, or use lifecycle: attach to only follow an existing daemon.',
          runtime_resolve_failed: 'The plugin found a Mebular runtime but could not read its shared runtime status. Reinstall or update the Mebular app/CLI, then restart DSH.',
          start_locked: 'Another Mebular entry point is starting the runtime. Wait a moment; the panel and tools attach when it is ready.',
          embed_info_unavailable: 'Mebular is running but does not expose /app/embed/info. Update Mebular to a version that supports DSH embedding.',
          embed_not_ok: 'Mebular refused the embed discovery request. Check the Mebular version and status.',
          embed_protocol_unsupported: 'This Mebular Console uses an embed protocol this plugin does not support. Update the plugin or Mebular.',
          embed_unsupported: 'This Mebular daemon does not offer Console embedding (loopback only).',
          not_loopback: 'Embedding is disabled because Mebular or DSH is not on a loopback address. Open Console in a browser instead.',
          embed_url_invalid: 'Mebular returned an embed URL that is not a loopback HTTP(S) URL. The panel will not load it.',
          frame_blocked: 'The Console iframe did not load, possibly blocked by CSP or cross-origin policy. Open it in a browser instead.',
          unknown: 'The Mebular Console is unavailable. Open it in a browser to see the daemon status.',
        },
      },
      zh: {
        title: 'Mebular',
        connected: '已连接',
        checking: '连接中',
        starting: '启动中',
        offline: '未运行',
        unavailable: '不可嵌入',
        connectingTitle: '正在连接 Mebular',
        connectingBody: '等待本地 Mebular daemon 响应。',
        startingTitle: '正在启动 Mebular',
        startingBody: 'DSH 插件正在启动本地 Mebular daemon，通常需要几秒钟。',
        offlineTitle: 'Mebular 未运行',
        downloadTitle: '打开或安装 Mebular',
        installTitle: '安装 Mebular Runtime',
        installBody: '本机没有找到 Mebular App、CLI、常驻服务或共享 runtime。安装固定版本的 Mebular runtime，并自动初始化、启动一次。只有点击「安装」才会下载。',
        installingTitle: '正在安装 Mebular Runtime',
        installingBody: '正在下载并校验固定版本的 Mebular runtime，随后初始化并启动。可能需要几分钟，请保持 DSH 打开。',
        installFailedTitle: 'Mebular Runtime 安装失败',
        installFailedBody: '没有启动任何半成品，旧 runtime（如有）保持不变。可以重试、重新安装，或执行手动命令后重新检测。',
        installAction: '安装',
        installRetry: '重试',
        installReinstall: '重新安装 Runtime',
        installCopy: '复制手动命令',
        installCopied: '已复制',
        installRedetect: '重新检测',
        installManualHint: '手动安装：执行下面的命令，然后点击「重新检测」。',
        installReadme: '安装说明',
        installVersion: '目标版本：{version}',
        installDone: 'Mebular Runtime 已就绪',
        installReasonLabel: '原因：{reason}',
        updateAvailable: '发现更新',
        updateMessage: 'Mebular {current} → {latest}',
        updateAction: '更新',
        updateLater: '稍后',
        updateSkip: '跳过此版本',
        updateUpdatingTitle: '正在更新 Mebular',
        updateUpdatingBody: '正在安装新 runtime，随后重新连接。请保持 DSH 打开。',
        updateFailedTitle: 'Mebular 更新失败',
        updateFailedBody: '旧 runtime（如有）仍在使用。',
        updateReasonLabel: '原因：{reason}',
        updateBusy: '另一个 Mebular 入口正在更新 runtime。请等它完成后再重新连接。',
        updateReconnectFailed: '更新已完成，但面板未能重新连接。请刷新或打开 Console。',
        serviceTitle: 'Mebular runtime 冲突',
        profileTitle: 'Mebular profile 不一致',
        cliMissingTitle: '未找到 Mebular CLI',
        incompatibleTitle: 'Mebular Console 无法嵌入',
        frameFailedTitle: 'Mebular Console 加载失败',
        openConsole: '打开 Console',
        openInBrowser: '在浏览器打开 Console',
        refresh: '刷新',
        hostUnavailable: '面板接口不可用',
        loadingFrame: '正在加载 Console…',
        error: 'DSH 主机无法读取 Mebular 状态：{error}',
        reasons: {
          daemon_unreachable: '配置的 loopback 地址上没有 Mebular daemon。MCP 工具暂时不可用；请启动 Mebular 或运行 "mebular serve"，就绪后面板与工具会自动恢复。',
          daemon_unhealthy: 'Mebular 已响应，但健康检查未就绪。请检查 Mebular 日志后刷新。',
          download_required: '本机没有找到可用的 Mebular runtime。请打开 Mebular App 或安装 Mebular CLI，然后重启 DSH；启动后面板与 MCP 工具会自动连接。本插件不会自动下载 Mebular。',
          offline: '本机似乎离线，无法访问 npm registry。请恢复网络后重试，或使用手动命令。',
          registry_unreachable: '无法连接 npm registry。请检查网络/代理后重试，或使用手动命令。',
          http_error: 'npm registry 拒绝了下载（HTTP 错误）。请稍后重试，或手动安装固定版本。',
          integrity_mismatch: '下载的 runtime 与固定版本不一致或文件不完整。请点「重新安装 Runtime」，插件会再次校验。',
          disk_full: '磁盘空间不足，无法安装 runtime。请释放空间后重试。',
          permission_denied: 'runtime 目录不可写。请修复权限后重试；旧 runtime 已保留。',
          npm_missing: '没有找到 npm。请先安装 Node.js/npm，然后重试或使用手动命令。',
          unsupported_version: 'npm 上没有这个固定版本的 runtime。请更新插件，或手动安装受支持的版本。',
          cancelled: 'runtime 安装已取消或超时。准备好后重试；不会启动半成品。',
          install_locked: '另一个 Mebular 入口正在安装 runtime。请等它完成，然后重新检测。',
          provider_registration_failed: 'runtime 已安装，但无法注册给 App/CLI 发现。请修复 runtime-providers.json 后重试；没有启动任何东西。',
          init_failed: 'runtime 已安装，但初始化失败，因此没有启动。请重试；现有 Mebular 数据与身份未被覆盖。',
          start_failed: 'runtime 已安装，但没有就绪。请重试、检查 Mebular 日志，或手动启动 Mebular。',
          install_failed: 'Mebular runtime 安装失败。请重试、重新安装，或使用手动命令。',
          provisioning: '共享 runtime supervisor 正在启动 Mebular，通常需要几秒钟。',
          service_conflict: 'Mebular 常驻服务无法安全复用（归属不明或状态无法确认）。请打开 Mebular 检查常驻服务状态后刷新。',
          service_unknown: '插件无法确认 Mebular 常驻服务状态。请在 Mebular Console 检查或重新安装常驻服务后刷新；不会启动第二个 daemon。',
          service_foreign: '该 Mebular 常驻服务属于另一个 Mebular home。请停止那个实例或切换 profile；插件不会覆盖它。',
          service_not_registered: '当前 profile 配置了 persistence:service，但尚未安装 Mebular 常驻服务。请在 Mebular Console 打开「让 Mebular 常驻」，或把 persistence 改回 child。',
          profile_mismatch: '该地址上的 daemon 属于另一个 Mebular profile。请把 Mebular 切到当前 profile 或关闭另一个实例；插件不会启动第二个 daemon。',
          instance_mismatch: '该地址上的 daemon 服务于另一张忆云。请关闭另一个实例或切换 profile；插件不会启动第二个 daemon。',
          instance_missing: '该地址上的 daemon 没有忆云身份，插件无法确认它。请从同一 profile 重启 Mebular。',
          cloud_mismatch: '该地址上的 daemon 服务于另一个忆云。请切换 Mebular 或关闭另一个实例。',
          CLOUD_ALREADY_ACTIVE: '已有另一个 profile 的 Mebular 实例在运行。请停止它或切换当前 profile；不会启动第二个 daemon。',
          port_in_use: '配置的 Mebular 端口已被其他程序占用。请释放端口或更换 Mebular 端口；插件不会启动第二个 daemon。',
          version_mismatch: '运行中的 Mebular runtime 版本与插件预期不一致。请更新 Mebular 或插件后重启 DSH。',
          managed_cli_missing: '没有找到 Mebular CLI 或 App runtime。请打开 Mebular App 或安装 Mebular CLI，然后重启 DSH。',
          managed_start_failed: '共享 runtime supervisor 已启动 Mebular，但健康检查未通过。请检查 Mebular 日志或手动启动 Mebular；就绪后面板与工具会自动恢复。',
          supervise_failed: '共享 runtime supervisor 在报告就绪前退出。请检查 Mebular 日志；插件不会启动第二个 daemon。',
          child_exited: '插件启动的 Mebular runtime 已退出。请重新启动 Mebular，或使用 lifecycle: attach 只跟随已有 daemon。',
          runtime_resolve_failed: '插件找到了 Mebular runtime，但无法读取共享 runtime 状态。请重新安装或更新 Mebular App/CLI 后重启 DSH。',
          start_locked: '另一个 Mebular 入口正在启动 runtime。请稍候；就绪后会自动 attach。',
          embed_info_unavailable: 'Mebular 正在运行，但没有提供 /app/embed/info。请升级到支持 DSH 嵌入的版本。',
          embed_not_ok: 'Mebular 拒绝了嵌入发现请求。请检查 Mebular 版本与状态。',
          embed_protocol_unsupported: '此 Mebular Console 的嵌入协议版本不受插件支持。请升级插件或 Mebular。',
          embed_unsupported: '此 Mebular daemon 不允许嵌入 Console（仅限 loopback）。',
          not_loopback: 'Mebular 或 DSH 不在 loopback 地址上，因此禁用嵌入。请在浏览器中打开 Console。',
          embed_url_invalid: 'Mebular 返回了非 loopback HTTP(S) 的嵌入 URL，面板不会加载它。',
          frame_blocked: 'Console iframe 没有加载成功，可能被 CSP 或跨源策略阻止。请在浏览器中打开 Console。',
          unknown: 'Mebular Console 当前不可用。请在浏览器中打开以查看 daemon 状态。',
        },
      },
    };

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: '100%',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: 'none',
        minHeight: 40,
        padding: '0 20px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
      },
      headerSidebarCollapsed: {
        // DSH keeps its collapsed-sidebar controls floating over the left edge
        // of the main panel. Reserve that strip so the Mebular header does not
        // render underneath them.
        paddingLeft: 172,
      },
      iconAction: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        flex: 'none',
        padding: 0,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        textDecoration: 'none',
      },
      dot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flex: 'none',
        background: 'var(--dsw-alias-label-tertiary, #888)',
      },
      statusIcon: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      },
      statusDot: {
        position: 'absolute',
        right: -1,
        bottom: -1,
        width: 7,
        height: 7,
        borderRadius: '50%',
        border: '1.5px solid var(--dsw-alias-bg-layer-1, rgba(10,10,18,.9))',
        boxSizing: 'content-box',
        pointerEvents: 'none',
      },
      title: {
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      },
      version: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #888)',
        whiteSpace: 'nowrap',
      },
      meta: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #888)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 220,
      },
      spacer: {
        flex: 1,
      },
      warn: {
        fontSize: 11,
        color: 'var(--dsw-alias-state-warn-primary, #d97706)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 180,
      },
      banner: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        flex: 'none',
        padding: '6px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary, #aaa)',
      },
      bannerText: {
        flex: 1,
        minWidth: 160,
        lineHeight: 1.4,
      },
      bannerActions: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
      },
      action: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        lineHeight: '24px',
        cursor: 'pointer',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        font: 'inherit',
      },
      frameWrap: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        background: '#0a0a12',
      },
      frame: {
        flex: 1,
        width: '100%',
        minHeight: 0,
        border: 0,
        display: 'block',
        background: '#0a0a12',
      },
      frameOverlay: {
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        background: '#0a0a12',
        color: 'var(--dsw-alias-label-secondary, #aaa)',
        fontSize: 12,
        pointerEvents: 'none',
      },
      placeholder: {
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        textAlign: 'center',
      },
      placeholderIcon: {
        color: 'var(--dsw-alias-label-secondary, #aaa)',
        opacity: 0.8,
      },
      heading: {
        margin: 0,
        fontSize: 15,
        fontWeight: 600,
      },
      copy: {
        margin: 0,
        maxWidth: 460,
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary, #aaa)',
      },
      buttonRow: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        maxWidth: 520,
      },
      primaryAction: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 32,
        padding: '0 14px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-state-success-primary, #22c55e)',
        background: 'var(--dsw-alias-state-success-primary, #22c55e)',
        color: '#04120a',
        fontSize: 12,
        fontWeight: 600,
        lineHeight: '30px',
        cursor: 'pointer',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        font: 'inherit',
      },
      codeBlock: {
        display: 'block',
        maxWidth: 520,
        margin: 0,
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.5,
        textAlign: 'left',
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      detail: {
        margin: 0,
        maxWidth: 520,
        fontSize: 11,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary, #888)',
        wordBreak: 'break-word',
      },
    };

    function currentText() {
      try {
        const lang = typeof document === 'undefined' ? '' : document.documentElement?.lang;
        return String(lang ?? '').toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en;
      } catch {
        return TEXT.en;
      }
    }

    function safeHttpUrl(value) {
      if (typeof value !== 'string' || value.length === 0) return null;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
      } catch {
        return null;
      }
    }

    function isLoopbackIpv4(host) {
      const parts = host.split('.');
      if (parts.length !== 4) return false;
      if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
      return parts[0] === '127';
    }

    function isLoopbackIpv6(host) {
      if (host === '::1') return true;
      if (!host.startsWith('::ffff:')) return false;
      const tail = host.slice('::ffff:'.length);
      if (isLoopbackIpv4(tail)) return true;
      const groups = tail.split(':');
      return groups.length === 2
        && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
        && (Number.parseInt(groups.map((group) => group.padStart(4, '0')).join(''), 16) >>> 24) === 127;
    }

    function isLoopbackHostname(hostname) {
      if (typeof hostname !== 'string' || hostname.length === 0) return false;
      const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
      if (host === 'localhost' || host.endsWith('.localhost')) return true;
      if (host.includes(':')) return isLoopbackIpv6(host);
      return isLoopbackIpv4(host);
    }

    function isLoopbackHttpUrl(value) {
      const href = safeHttpUrl(value);
      if (href === null) return false;
      try {
        return isLoopbackHostname(new URL(href).hostname);
      } catch {
        return false;
      }
    }

    function statusOf(info, loading, ready, error) {
      if (error !== null) return 'offline';
      if (ready) return 'connected';
      if (info?.status === 'starting' || info?.install?.state === 'installing') return 'starting';
      if (info?.status === 'up') return 'unavailable';
      if (loading && info === null) return 'checking';
      return info === null ? 'checking' : 'offline';
    }

    function dotColor(status) {
      if (status === 'connected') return 'var(--dsw-alias-state-success-primary, #22c55e)';
      if (status === 'starting' || status === 'unavailable') {
        return 'var(--dsw-alias-state-warn-primary, #d97706)';
      }
      if (status === 'offline') return 'var(--dsw-alias-state-error-primary, #ef4444)';
      return 'var(--dsw-alias-label-tertiary, #888)';
    }

    function statusTitle(t, status) {
      return `${t.title}: ${t[status] ?? t.checking}`;
    }

    function isReadyInfo(info) {
      const embedUrl = safeHttpUrl(info?.embedUrl);
      return Boolean(
        info?.ok === true &&
          info?.status === 'up' &&
          info?.loopback === true &&
          info?.embedProtocol === 1 &&
          embedUrl !== null &&
          isLoopbackHttpUrl(embedUrl),
      );
    }

    function reasonMessage(t, info, error) {
      if (typeof error === 'string' && error.length > 0) return t.error.replace('{error}', error);
      const reason = typeof info?.reason === 'string' ? info.reason : 'unknown';
      return t.reasons[reason] ?? t.reasons.unknown;
    }

    function installInfoOf(info) {
      const install = info?.install;
      return install !== null && typeof install === 'object' ? install : null;
    }

    function canInstall(info) {
      const install = installInfoOf(info);
      if (install === null || install.allowed !== true || install.state === 'installing') return false;
      return info?.downloadRequired === true;
    }

    function installReasonMessage(t, info) {
      const install = installInfoOf(info);
      if (install === null || typeof install.reason !== 'string') return null;
      return t.reasons[install.reason] ?? t.installFailedBody;
    }

    /**
     * Pure panel view for the plugin-only install flow. The host already owns
     * `install.state`; the client only chooses copy and which buttons apply.
     */
    function installView(t, info) {
      const install = installInfoOf(info);
      if (install === null) return null;
      if (install.state === 'installing') {
        return {
          kind: 'installing',
          heading: t.installingTitle,
          body: t.installingBody,
          detail: null,
          manualCommand: null,
          targetVersion: install.targetVersion ?? null,
          actions: [],
        };
      }
      if (install.state === 'failed') {
        const canRetry = install.allowed === true;
        return {
          kind: 'failed',
          heading: t.installFailedTitle,
          body: `${t.installFailedBody} ${installReasonMessage(t, info) ?? ''}`.trim(),
          detail: typeof install.detail === 'string' ? install.detail : null,
          manualCommand: typeof install.manualCommand === 'string' ? install.manualCommand : null,
          targetVersion: install.targetVersion ?? null,
          actions: canRetry
            ? ['retry', 'reinstall', 'copy', 'redetect', 'readme']
            : ['copy', 'readme'],
        };
      }
      if (!canInstall(info)) return null;
      return {
        kind: 'install',
        heading: t.installTitle,
        body: t.installBody,
        detail: null,
        manualCommand: typeof install.manualCommand === 'string' ? install.manualCommand : null,
        targetVersion: install.targetVersion ?? null,
        actions: ['install', 'copy', 'redetect', 'readme'],
      };
    }

    function updateReasonText(t, reason) {
      if (reason === 'busy') return t.updateBusy;
      if (reason === 'reconnect_failed') return t.updateReconnectFailed;
      if (typeof reason === 'string' && reason.length > 0) {
        return (t.reasons[reason] ?? reason);
      }
      return null;
    }

    /**
     * Pure banner view. `update.show` is a session prompt; `update.manual` is an
     * already-prompted version the user can still update explicitly from the
     * header. `dismissedVersion` is the local "later" choice and never writes
     * skip; `pending` reflects the in-flight POST before the next poll.
     */
    function updateView(t, info, { dismissedVersion = null, pending = null } = {}) {
      const update = info?.update !== null && typeof info?.update === 'object' ? info.update : null;
      const upgrade = info?.upgrade !== null && typeof info?.upgrade === 'object' ? info.upgrade : null;
      if (update === null && upgrade === null) return null;
      const latest = typeof update?.latestVersion === 'string' ? update.latestVersion : null;
      const current = typeof update?.currentVersion === 'string' ? update.currentVersion : null;
      const to = typeof upgrade?.toVersion === 'string' ? upgrade.toVersion : latest;
      const from = typeof upgrade?.fromVersion === 'string' ? upgrade.fromVersion : current;
      const message = t.updateMessage.replace('{current}', from ?? '—').replace('{latest}', to ?? '—');

      if (pending === 'update' || upgrade?.state === 'updating' || upgrade?.state === 'skipping') {
        return {
          kind: 'updating',
          heading: t.updateUpdatingTitle,
          body: t.updateUpdatingBody,
          message,
          reason: null,
          actions: [],
        };
      }
      const dismissed = dismissedVersion !== null
        && ((latest !== null && dismissedVersion === latest)
          || (typeof to === 'string' && dismissedVersion === to));
      if (dismissed) return null;
      if (upgrade?.state === 'failed') {
        return {
          kind: 'failed',
          heading: t.updateFailedTitle,
          body: `${t.updateFailedBody} ${t.updateReasonLabel.replace('{reason}', updateReasonText(t, upgrade.reason) ?? 'upgrade_failed')}`.trim(),
          message,
          reason: typeof upgrade.reason === 'string' ? upgrade.reason : 'upgrade_failed',
          actions: ['update', 'later'],
        };
      }
      if (update === null || update.available !== true || update.skipped === true) return null;
      if (update.show !== true) return null;
      return {
        kind: 'available',
        heading: t.updateAvailable,
        body: null,
        message,
        reason: null,
        actions: ['update', 'later', 'skip'],
      };
    }

    // One module-level store feeds both the sidebar status dot and the panel.
    // It polls /mebular/embed-info only while at least one React subscriber is
    // mounted, shares an in-flight request, and never requires anything beyond
    // React and the browser globals already used by this client.
    function createEmbedInfoStore(options = {}) {
      const fetchImpl = typeof options.fetchImpl === 'function'
        ? options.fetchImpl
        : (url, init) => fetch(url, init);
      const setIntervalFn = typeof options.setIntervalFn === 'function'
        ? options.setIntervalFn
        : (fn, ms) => window.setInterval(fn, ms);
      const clearIntervalFn = typeof options.clearIntervalFn === 'function'
        ? options.clearIntervalFn
        : (timer) => window.clearInterval(timer);
      const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : POLL_MS;
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : FETCH_TIMEOUT_MS;

      const listeners = new Set();
      let snapshot = {
        info: null,
        error: null,
        loading: true,
        ready: false,
        status: 'checking',
        installPending: false,
        installError: null,
        upgradePending: false,
        upgradeError: null,
        promptWarning: null,
        dismissedVersion: null,
      };
      let timer = null;
      let inFlight = null;
      let installInFlight = null;
      let upgradeInFlight = null;
      const promptedSent = new Set();

      function publish(patch) {
        const next = { ...snapshot, ...patch };
        next.ready = next.error === null && isReadyInfo(next.info);
        next.status = statusOf(next.info, next.loading, next.ready, next.error);
        snapshot = next;
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            // A subscriber must never break the shared poll.
          }
        }
      }

      function load() {
        if (inFlight !== null) return inFlight;
        const request = (async () => {
          const signal =
            typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
              ? AbortSignal.timeout(timeoutMs)
              : undefined;
          try {
            const response = await fetchImpl(
              EMBED_INFO_PATH,
              signal === undefined
                ? { cache: 'no-store', headers: { accept: 'application/json' } }
                : { cache: 'no-store', headers: { accept: 'application/json' }, signal },
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const next = await response.json();
            publish({
              info: next !== null && typeof next === 'object' ? next : null,
              error: null,
              loading: false,
            });
          } catch (cause) {
            publish({
              info: null,
              error: cause instanceof Error ? cause.message : String(cause),
              loading: false,
            });
          }
        })();
        inFlight = request;
        request.finally(() => {
          if (inFlight === request) inFlight = null;
        });
        return request;
      }

      function start() {
        if (timer !== null) return;
        void load();
        timer = setIntervalFn(() => {
          void load();
        }, intervalMs);
      }

      function stop() {
        if (timer === null) return;
        clearIntervalFn(timer);
        timer = null;
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        if (listeners.size === 1) start();
        return () => {
          if (!listeners.delete(listener)) return;
          if (listeners.size === 0) stop();
        };
      }

      /**
       * One loopback write. The only literal POST in this client; callers pass
       * a fixed host route and one action, never a version/tag/URL.
       */
      async function postAction(path, action, { timeoutScale = 4 } = {}) {
        const signal =
          typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs * timeoutScale)
            : undefined;
        const init = {
          method: 'POST',
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
          ...(signal === undefined ? {} : { signal }),
        };
        const response = await fetchImpl(path, init);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json().catch(() => null);
      }

      /**
       * One explicit user action -> one POST. Never called by polling. The
       * host owns install state; the next embed-info read reflects it.
       */
      function install(action = 'install') {
        if (installInFlight !== null) return installInFlight;
        const request = (async () => {
          publish({ installPending: true, installError: null });
          try {
            await postAction(RUNTIME_INSTALL_PATH, action);
            publish({ installPending: false, installError: null });
          } catch (cause) {
            publish({
              installPending: false,
              installError: cause instanceof Error ? cause.message : String(cause),
            });
          }
          await load();
        })();
        installInFlight = request;
        request.finally(() => {
          if (installInFlight === request) installInFlight = null;
        });
        return request;
      }

      /** Local "later": never writes skip, never auto-retries. */
      function later(version = null) {
        publish({
          dismissedVersion: typeof version === 'string' && version.length > 0 ? version : null,
          upgradeError: null,
        });
      }

      /**
       * Explicit prompt acknowledgement, sent only after the main panel actually
       * rendered the banner. One POST per latestVersion per browser session; the
       * host re-reads the latest version, so no client version is transmitted.
       * A failure is a local warning only and never disables the update actions.
       */
      function confirmPrompted(version = null) {
        const latest = typeof version === 'string' && version.length > 0
          ? version
          : (typeof snapshot.info?.update?.latestVersion === 'string'
            ? snapshot.info.update.latestVersion
            : null);
        if (latest === null || promptedSent.has(latest)) return Promise.resolve();
        promptedSent.add(latest);
        const request = (async () => {
          try {
            await postAction(RUNTIME_UPGRADE_PATH, 'prompted', { timeoutScale: 2 });
            publish({ promptWarning: null });
          } catch (cause) {
            publish({ promptWarning: cause instanceof Error ? cause.message : String(cause) });
          }
          await load();
        })();
        return request;
      }

      /**
       * Explicit update/skip. `later` stays local; both other actions are one
       * POST to the fixed upgrade route. The host re-reads the latest version,
       * so a client-supplied version is impossible by construction.
       */
      function upgrade(action = 'update') {
        if (action === 'later') {
          const latest = typeof snapshot.info?.update?.latestVersion === 'string'
            ? snapshot.info.update.latestVersion
            : null;
          later(latest);
          return Promise.resolve();
        }
        if (upgradeInFlight !== null) return upgradeInFlight;
        const request = (async () => {
          publish({ upgradePending: true, upgradeError: null });
          try {
            const response = await postAction(RUNTIME_UPGRADE_PATH, action, { timeoutScale: 8 });
            const latest = typeof response?.upgrade?.toVersion === 'string'
              ? response.upgrade.toVersion
              : (typeof snapshot.info?.update?.latestVersion === 'string'
                ? snapshot.info.update.latestVersion
                : null);
            publish({
              upgradePending: false,
              upgradeError: null,
              // A successful update/skip suppresses this version locally too;
              // the next shared check reflects the same state for other entries.
              ...(action === 'update' || action === 'skip'
                ? { dismissedVersion: latest }
                : {}),
            });
          } catch (cause) {
            publish({
              upgradePending: false,
              upgradeError: cause instanceof Error ? cause.message : String(cause),
            });
          }
          await load();
        })();
        upgradeInFlight = request;
        request.finally(() => {
          if (upgradeInFlight === request) upgradeInFlight = null;
        });
        return request;
      }

      return {
        subscribe,
        getSnapshot: () => snapshot,
        refresh: load,
        install,
        later,
        upgrade,
        confirmPrompted,
      };
    }

    const embedInfoStore = createEmbedInfoStore();

    function useEmbedInfo() {
      const [snapshot, setSnapshot] = React.useState(() => embedInfoStore.getSnapshot());
      React.useEffect(() => {
        const sync = () => setSnapshot(embedInfoStore.getSnapshot());
        const unsubscribe = embedInfoStore.subscribe(sync);
        sync();
        return unsubscribe;
      }, []);
      return snapshot;
    }

    function MebularIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 2.4, fill: 'currentColor', stroke: 'none' }),
        h('ellipse', { cx: 12, cy: 12, rx: 9, ry: 4.1, transform: 'rotate(-28 12 12)' }),
        h('ellipse', { cx: 12, cy: 12, rx: 9, ry: 4.1, transform: 'rotate(28 12 12)' }),
      );
    }

    function OpenConsoleIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M14 4h6v6' }),
        h('path', { d: 'M20 4 11 13' }),
        h('path', { d: 'M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6' }),
      );
    }

    function RefreshIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M20 11a8.1 8.1 0 0 0-14.9-4.7L3 8' }),
        h('path', { d: 'M3 3v5h5' }),
        h('path', { d: 'M4 13a8.1 8.1 0 0 0 14.9 4.7L21 16' }),
        h('path', { d: 'M21 21v-5h-5' }),
      );
    }

    function MebularStatusIcon(props) {
      const t = currentText();
      const { status } = useEmbedInfo();
      const size = Number.isFinite(props?.size) ? props.size : 18;
      return h(
        'span',
        {
          style: { ...styles.statusIcon, width: size, height: size },
          'data-mebular-status': status,
        },
        h(MebularIcon, { size }),
        h('span', {
          title: statusTitle(t, status),
          'aria-hidden': 'true',
          style: { ...styles.statusDot, background: dotColor(status) },
        }),
      );
    }

    function useDshSidebarCollapsed() {
      const read = () => {
        try {
          return typeof document !== 'undefined'
            && document.querySelector('[data-sidebar-collapsed="true"]') !== null;
        } catch {
          return false;
        }
      };
      const [collapsed, setCollapsed] = React.useState(read);
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
        const sync = () => setCollapsed(read());
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(document.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ['data-sidebar-collapsed'],
        });
        return () => observer.disconnect();
      }, []);
      return collapsed;
    }

    function MebularPanel() {
      const t = currentText();
      const sidebarCollapsed = useDshSidebarCollapsed();
      const {
        info, error, loading, ready, status, installPending, installError,
        upgradePending, upgradeError, dismissedVersion,
      } = useEmbedInfo();
      const [refreshToken, setRefreshToken] = React.useState(0);
      const [frameState, setFrameState] = React.useState('idle');
      const [copied, setCopied] = React.useState(false);
      const [pendingUpgradeAction, setPendingUpgradeAction] = React.useState(null);

      const embedUrl = safeHttpUrl(info?.embedUrl);
      const frameFailed = frameState === 'failed';
      const showFrame = ready && !frameFailed;
      const consoleUrl = safeHttpUrl(info?.consoleUrl) ?? DEFAULT_CONSOLE_URL;
      const version = typeof info?.version === 'string' && info.version.length > 0 ? info.version : null;
      const updateBanner = updateView(t, info, {
        dismissedVersion,
        pending: upgradePending ? (pendingUpgradeAction ?? 'update') : null,
      });
      const promptLatest = updateBanner?.kind === 'available'
        && info?.update?.auto === true
        && typeof info?.update?.latestVersion === 'string'
        ? info.update.latestVersion
        : null;
      const updateAvailable = info?.update !== null && typeof info?.update === 'object'
        ? info.update
        : null;
      const manualUpdateVersion = updateAvailable?.manual === true && updateBanner === null
        && (dismissedVersion === null || dismissedVersion !== updateAvailable.latestVersion)
        ? updateAvailable.latestVersion
        : null;
      const upgradeState = typeof info?.upgrade?.state === 'string' ? info.upgrade.state : null;
      const pendingView = installView(t, info) ?? (installPending
        ? {
          kind: 'installing',
          heading: t.installingTitle,
          body: t.installingBody,
          detail: null,
          manualCommand: null,
          targetVersion: installInfoOf(info)?.targetVersion ?? null,
          actions: [],
        }
        : null);
      const installViewValue = installPending && pendingView?.kind !== 'installing'
        ? { ...pendingView, kind: 'installing', heading: t.installingTitle, body: t.installingBody, actions: [] }
        : pendingView;
      const refresh = () => {
        setRefreshToken((value) => value + 1);
        void embedInfoStore.refresh();
      };
      const runInstall = (action) => {
        setCopied(false);
        void embedInfoStore.install(action);
      };
      const runUpgrade = (action) => {
        if (action === 'later') {
          embedInfoStore.later(updateAvailable?.latestVersion ?? null);
          return;
        }
        setPendingUpgradeAction(action);
        void embedInfoStore.upgrade(action).finally(() => {
          setPendingUpgradeAction(null);
        });
      };
      const copyManual = async () => {
        const command = installViewValue?.manualCommand;
        if (typeof command !== 'string' || command.length === 0) return;
        try {
          await navigator?.clipboard?.writeText(command);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      };

      React.useEffect(() => {
        if (!ready) setFrameState('idle');
        else setFrameState('loading');
      }, [ready, embedUrl, refreshToken]);

      React.useEffect(() => {
        if (frameState !== 'loading' || !showFrame) return undefined;
        const timer = window.setTimeout(() => setFrameState('failed'), FRAME_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
      }, [frameState, showFrame]);

      React.useEffect(() => {
        if (upgradeState !== 'done') return;
        // Upgrade success: reload the shared Console/embed info once; no retry loop.
        setRefreshToken((value) => value + 1);
        void embedInfoStore.refresh();
      }, [upgradeState]);

      React.useEffect(() => {
        // Only a rendered banner acknowledges the prompt; sidebar polling alone
        // never writes the shared prompted state.
        if (promptLatest === null) return;
        void embedInfoStore.confirmPrompted(promptLatest);
      }, [promptLatest]);

      const header = h(
        'div',
        {
          style: { ...styles.header, ...(sidebarCollapsed ? styles.headerSidebarCollapsed : null) },
          'data-mebular-panel-header': 'true',
        },
        h('span', {
          style: { ...styles.dot, background: dotColor(status) },
          title: statusTitle(t, status),
          'aria-hidden': 'true',
        }),
        h('span', { style: styles.title }, t.title),
        version === null ? null : h('span', { style: styles.version }, `v${version.replace(/^v/, '')}`),
        h('span', { style: styles.spacer }),
        error !== null && !ready
          ? h('span', { style: styles.warn, title: error }, t.hostUnavailable)
          : status === 'connected'
            ? null
            : h('span', { style: styles.version }, t[status]),
        manualUpdateVersion === null
          ? null
          : h(
              'button',
              {
                type: 'button',
                disabled: upgradePending,
                onClick: () => runUpgrade('update'),
                style: styles.action,
                title: `${t.updateAction} ${manualUpdateVersion}`,
              },
              `${t.updateAction} v${manualUpdateVersion.replace(/^v/, '')}`,
            ),
        h(
          'a',
          {
            href: consoleUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: styles.iconAction,
            title: t.openConsole,
            'aria-label': t.openConsole,
            'data-mebular-action': 'open-console',
          },
          h(OpenConsoleIcon),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: refresh,
            style: styles.iconAction,
            title: t.refresh,
            'aria-label': t.refresh,
            'data-mebular-action': 'refresh',
          },
          h(RefreshIcon),
        ),
      );

      const starting = info?.status === 'starting';
      const cliMissing = info?.reason === 'managed_cli_missing';
      const heading = installViewValue !== null
        ? installViewValue.heading
        : loading && info === null
          ? t.connectingTitle
          : starting
            ? t.startingTitle
            : frameFailed
              ? t.frameFailedTitle
              : cliMissing
                ? t.cliMissingTitle
                : info?.status === 'up' ? t.incompatibleTitle : t.offlineTitle;
      const bodyText = installViewValue !== null
        ? installViewValue.body
        : loading && info === null
          ? t.connectingBody
          : starting
            ? t.startingBody
            : frameFailed ? t.reasons.frame_blocked : reasonMessage(t, info, error);

      const installButtons = installViewValue === null
        ? null
        : h(
            'div',
            { style: styles.buttonRow },
            ...installViewValue.actions.map((action) => {
              if (action === 'copy') {
                return h(
                  'button',
                  {
                    key: action,
                    type: 'button',
                    onClick: () => { void copyManual(); },
                    style: styles.action,
                  },
                  copied ? t.installCopied : t.installCopy,
                );
              }
              if (action === 'readme') {
                return h(
                  'a',
                  {
                    key: action,
                    href: README_URL,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    style: styles.action,
                  },
                  t.installReadme,
                );
              }
              const label = action === 'install'
                ? t.installAction
                : action === 'retry'
                  ? t.installRetry
                  : action === 'reinstall' ? t.installReinstall : t.installRedetect;
              return h(
                'button',
                {
                  key: action,
                  type: 'button',
                  disabled: installPending,
                  onClick: () => runInstall(action),
                  style: action === 'install' ? styles.primaryAction : styles.action,
                },
                label,
              );
            }),
          );
      const installDetails = installViewValue === null
        ? null
        : [
            installViewValue.targetVersion === null
              ? null
              : h(
                  'p',
                  { key: 'version', style: styles.detail },
                  t.installVersion.replace('{version}', installViewValue.targetVersion),
                ),
            installViewValue.kind === 'failed' && installViewValue.detail !== null
              ? h('p', { key: 'detail', style: styles.detail }, installViewValue.detail)
              : null,
            installViewValue.manualCommand === null
              ? null
              : h('p', { key: 'manual-hint', style: styles.detail }, t.installManualHint),
            installViewValue.manualCommand === null
              ? null
              : h('code', { key: 'manual', style: styles.codeBlock }, installViewValue.manualCommand),
            installError === null
              ? null
              : h('p', { key: 'post-error', style: styles.warn }, installError),
          ].filter(Boolean);

      const updateBannerNode = updateBanner === null
        ? null
        : h(
            'div',
            { style: styles.banner, 'data-mebular-update': updateBanner.kind },
            h(
              'div',
              { style: styles.bannerText },
              h('strong', null, updateBanner.heading),
              ' ',
              h('span', null, updateBanner.message),
              updateBanner.body === null ? null : h('div', null, updateBanner.body),
              upgradeError === null ? null : h('div', { style: styles.warn }, upgradeError),
            ),
            h(
              'div',
              { style: styles.bannerActions },
              ...updateBanner.actions.map((action) => h(
                'button',
                {
                  key: action,
                  type: 'button',
                  disabled: upgradePending,
                  onClick: () => runUpgrade(action),
                  style: action === 'update' ? styles.primaryAction : styles.action,
                },
                action === 'update'
                  ? t.updateAction
                  : action === 'later' ? t.updateLater : t.updateSkip,
              )),
            ),
          );

      const body = showFrame
        ? h(
            'div',
            { style: styles.frameWrap },
            h('iframe', {
              key: `${refreshToken}:${embedUrl}`,
              src: embedUrl,
              title: 'Mebular Console',
              sandbox: 'allow-scripts allow-same-origin allow-forms',
              referrerPolicy: 'origin',
              style: styles.frame,
              onLoad: (event) => {
                // A cross-origin Console throws on contentWindow.location, which
                // proves a real document loaded. A readable about:blank usually
                // means CSP blocked the frame; switch to the guidance page.
                try {
                  const href = event?.currentTarget?.contentWindow?.location?.href;
                  setFrameState(href === 'about:blank' ? 'failed' : 'ready');
                } catch {
                  setFrameState('ready');
                }
              },
              onError: () => setFrameState('failed'),
            }),
            frameState === 'ready'
              ? null
              : h('div', { style: styles.frameOverlay }, h(MebularIcon, { size: 20 }), t.loadingFrame),
          )
        : h(
            'div',
            { style: styles.placeholder },
            h('div', { style: styles.placeholderIcon }, h(MebularIcon, { size: 48 })),
            h('h2', { style: styles.heading }, heading),
            h('p', { style: styles.copy }, bodyText),
            installDetails,
            installButtons,
            h(
              'a',
              {
                href: consoleUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: { ...styles.action, height: 30, padding: '0 14px', lineHeight: '28px' },
              },
              t.openInBrowser,
            ),
          );

      return h('div', { style: styles.root }, header, updateBannerNode, body);
    }

    const inject = ['slots'];

    // Host-injected through DSH webServer.tapIndex. Absent means panel:true;
    // only an explicit `panel:false` disables both slots. MCP tools are mounted
    // separately by the host plugin from the same discovered daemon URL and are
    // unaffected by this switch.
    function panelEnabled() {
      try {
        const config = typeof window === 'undefined' ? undefined : window.__MEBULAR_DSH__;
        return !(config !== null && typeof config === 'object' && config.panel === false);
      } catch {
        return true;
      }
    }

    function apply(ctx) {
      if (!panelEnabled()) return;
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'mebular',
            order: 10,
            label: 'Mebular',
          },
          MebularStatusIcon,
        ),
      );
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'mebular',
          },
          MebularPanel,
        ),
      );
    }

    const plugin = { apply, inject };

    // Opt-in test seam for the zero-build client: tests can inspect the pure
    // status mapping and construct isolated stores. DSH never sets this global.
    try {
      if (typeof window !== 'undefined' && window.__MEBULAR_DSH_TEST__ === true) {
        plugin.__test = {
          createEmbedInfoStore,
          dotColor,
          installInfoOf,
          installReasonMessage,
          installView,
          updateView,
          isReadyInfo,
          canInstall,
          reasonMessage,
          statusOf,
          statusTitle,
          text: currentText,
        };
      }
    } catch {
      // A blocked window global must not affect plugin registration.
    }

    return plugin;
  },
});
