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
          daemon_unreachable: 'No Mebular daemon answered on the configured loopback address. MCP tools stay unavailable until the daemon starts; start Mebular or run "mebular serve" and the panel and tools recover automatically.',
          daemon_unhealthy: 'Mebular answered, but its health check did not report ready. Check the Mebular logs, then refresh.',
          embed_info_unavailable: 'Mebular is running but does not expose /app/embed/info. Update Mebular to a version that supports DSH embedding.',
          embed_not_ok: 'Mebular refused the embed discovery request. Check the Mebular version and status.',
          embed_protocol_unsupported: 'This Mebular Console uses an embed protocol this plugin does not support. Update the plugin or Mebular.',
          embed_unsupported: 'This Mebular daemon does not offer Console embedding (loopback only).',
          not_loopback: 'Embedding is disabled because Mebular or DSH is not on a loopback address. Open Console in a browser instead.',
          embed_url_invalid: 'Mebular returned an embed URL that is not a loopback HTTP(S) URL. The panel will not load it.',
          managed_cli_missing: 'Managed mode could not find the Mebular CLI. Install Mebular, or set MEBULAR_CLI or the plugin cliPath, then restart DSH.',
          managed_start_failed: 'The plugin started Mebular but it did not become healthy. Check the Mebular logs or start Mebular manually; the panel and tools recover automatically once it is up.',
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
          daemon_unreachable: '配置的 loopback 地址上没有 Mebular daemon。daemon 启动前 MCP 工具不可用；请启动 Mebular 或运行 "mebular serve"，面板与工具会自动恢复。',
          daemon_unhealthy: 'Mebular 已响应，但健康检查未就绪。请检查 Mebular 日志后刷新。',
          embed_info_unavailable: 'Mebular 正在运行，但没有提供 /app/embed/info。请升级到支持 DSH 嵌入的版本。',
          embed_not_ok: 'Mebular 拒绝了嵌入发现请求。请检查 Mebular 版本与状态。',
          embed_protocol_unsupported: '此 Mebular Console 的嵌入协议版本不受插件支持。请升级插件或 Mebular。',
          embed_unsupported: '此 Mebular daemon 不允许嵌入 Console（仅限 loopback）。',
          not_loopback: 'Mebular 或 DSH 不在 loopback 地址上，因此禁用嵌入。请在浏览器中打开 Console。',
          embed_url_invalid: 'Mebular 返回了非 loopback HTTP(S) 的嵌入 URL，面板不会加载它。',
          managed_cli_missing: 'managed 模式没有找到 Mebular CLI。请安装 Mebular，或设置 MEBULAR_CLI / 插件 cliPath，然后重启 DSH。',
          managed_start_failed: '插件已启动 Mebular，但健康检查未通过。请检查 Mebular 日志或手动启动 Mebular；daemon 就绪后面板与工具会自动恢复。',
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
        padding: '0 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
      },
      dot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flex: 'none',
        background: 'var(--dsw-alias-label-tertiary, #888)',
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
      if (loading && info === null) return 'checking';
      if (ready) return 'connected';
      if (error !== null) return 'offline';
      if (info?.status === 'starting') return 'starting';
      return info?.status === 'up' ? 'unavailable' : 'offline';
    }

    function dotColor(status) {
      if (status === 'connected') return 'var(--dsw-alias-state-success-primary, #22c55e)';
      if (status === 'starting') return 'var(--dsw-alias-state-info-primary, #38bdf8)';
      if (status === 'unavailable') return 'var(--dsw-alias-state-warn-primary, #d97706)';
      if (status === 'offline') return 'var(--dsw-alias-state-error-primary, #ef4444)';
      return 'var(--dsw-alias-label-tertiary, #888)';
    }

    function reasonMessage(t, info, error) {
      if (typeof error === 'string' && error.length > 0) return t.error.replace('{error}', error);
      const reason = typeof info?.reason === 'string' ? info.reason : 'unknown';
      return t.reasons[reason] ?? t.reasons.unknown;
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

    function MebularPanel() {
      const t = currentText();
      const [info, setInfo] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [refreshToken, setRefreshToken] = React.useState(0);
      const [frameState, setFrameState] = React.useState('idle');

      React.useEffect(() => {
        let active = true;
        let timer = null;

        const tick = async () => {
          const signal =
            typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
              ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
              : undefined;
          try {
            const response = await fetch(
              EMBED_INFO_PATH,
              signal === undefined
                ? { cache: 'no-store', headers: { accept: 'application/json' } }
                : { cache: 'no-store', headers: { accept: 'application/json' }, signal },
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const next = await response.json();
            if (!active) return;
            setInfo(next !== null && typeof next === 'object' ? next : null);
            setError(null);
          } catch (cause) {
            if (!active) return;
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            if (active) setLoading(false);
          }
        };

        setLoading(true);
        tick();
        timer = window.setInterval(tick, POLL_MS);
        return () => {
          active = false;
          if (timer !== null) window.clearInterval(timer);
        };
      }, [refreshToken]);

      const embedUrl = safeHttpUrl(info?.embedUrl);
      const ready = Boolean(
        info?.ok === true &&
          info?.status === 'up' &&
          info?.loopback === true &&
          info?.embedProtocol === 1 &&
          embedUrl !== null &&
          isLoopbackHttpUrl(embedUrl),
      );
      const frameFailed = frameState === 'failed';
      const showFrame = ready && !frameFailed;
      const consoleUrl = safeHttpUrl(info?.consoleUrl) ?? DEFAULT_CONSOLE_URL;
      const version = typeof info?.version === 'string' && info.version.length > 0 ? info.version : null;
      const status = statusOf(info, loading, ready, error);
      const refresh = () => setRefreshToken((value) => value + 1);

      React.useEffect(() => {
        if (!ready) setFrameState('idle');
        else setFrameState('loading');
      }, [ready, embedUrl, refreshToken]);

      React.useEffect(() => {
        if (frameState !== 'loading' || !showFrame) return undefined;
        const timer = window.setTimeout(() => setFrameState('failed'), FRAME_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
      }, [frameState, showFrame]);

      const header = h(
        'div',
        { style: styles.header },
        h('span', { style: { ...styles.dot, background: dotColor(status) }, 'aria-hidden': 'true' }),
        h('span', { style: styles.title }, t.title),
        version === null ? null : h('span', { style: styles.version }, `v${version.replace(/^v/, '')}`),
        h('span', { style: styles.spacer }),
        error !== null && !ready
          ? h('span', { style: styles.warn, title: error }, t.hostUnavailable)
          : h('span', { style: styles.version }, t[status]),
        h(
          'a',
          {
            href: consoleUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: styles.action,
          },
          t.openConsole,
        ),
        h('button', { type: 'button', onClick: refresh, style: styles.action }, t.refresh),
      );

      const starting = info?.status === 'starting';
      const cliMissing = info?.reason === 'managed_cli_missing';
      const heading = loading && info === null
        ? t.connectingTitle
        : starting
          ? t.startingTitle
          : cliMissing
            ? t.cliMissingTitle
            : frameFailed
              ? t.frameFailedTitle
              : info?.status === 'up' ? t.incompatibleTitle : t.offlineTitle;
      const bodyText = loading && info === null
        ? t.connectingBody
        : starting
          ? t.startingBody
          : frameFailed ? t.reasons.frame_blocked : reasonMessage(t, info, error);

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

      return h('div', { style: styles.root }, header, body);
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
          MebularIcon,
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

    return { apply, inject };
  },
});
