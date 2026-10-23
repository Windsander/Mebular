'use strict';

/**
 * Web client half of @mebular/dsh-plugin.
 *
 * DSH loads this file as a plain side-effect script in the browser: no top-level
 * ESM syntax, no bundler. It registers a "Mebular" section in DSH Settings that
 * explains the MCP connection and links out to the Mebular console.
 *
 * The panel is only an entry point. Mebular keeps running as its own app/daemon;
 * nothing here fetches state or embeds the console.
 *
 * The module must declare `inject: ['slots']` so DSH provides `ctx.slots`;
 * without it the client entry fails to activate at web boot.
 */

const PLUGIN_ID = '@mebular/dsh-plugin';
const MCP_ENDPOINT = 'http://127.0.0.1:7331/mcp';
const CONSOLE_URL = 'http://127.0.0.1:7331/console';

const styles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '16px',
    border: '1px solid var(--dsh-color-border, var(--border, rgba(127, 127, 127, 0.28)))',
    borderRadius: 'var(--dsh-radius-md, 10px)',
    background: 'var(--dsh-color-surface, var(--card, transparent))',
    color: 'var(--dsh-color-text, var(--foreground, inherit))',
    fontFamily: 'var(--dsh-font-sans, var(--font-sans, inherit))',
    lineHeight: 1.5,
  },
  title: {
    margin: 0,
    fontSize: '15px',
    fontWeight: 600,
  },
  description: {
    margin: 0,
    color: 'var(--dsh-color-text-secondary, var(--muted-foreground, inherit))',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    fontSize: '13px',
  },
  label: {
    color: 'var(--dsh-color-text-secondary, var(--muted-foreground, inherit))',
  },
  endpoint: {
    padding: '2px 6px',
    borderRadius: 'var(--dsh-radius-sm, 6px)',
    background: 'var(--dsh-color-code-bg, var(--code-background, rgba(127, 127, 127, 0.14)))',
    color: 'var(--dsh-color-code-text, var(--code-foreground, inherit))',
    fontFamily: 'var(--dsh-font-mono, var(--font-mono, monospace))',
    fontSize: '12px',
  },
  button: {
    alignSelf: 'flex-start',
    marginTop: '2px',
    padding: '6px 12px',
    border: '1px solid transparent',
    borderRadius: 'var(--dsh-radius-sm, 6px)',
    background: 'var(--dsh-color-accent, var(--primary, #4f7cff))',
    color: 'var(--dsh-color-accent-text, var(--primary-foreground, #ffffff))',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
  },
  hint: {
    margin: 0,
    fontSize: '12px',
    color: 'var(--dsh-color-text-secondary, var(--muted-foreground, inherit))',
  },
};

function openConsole(event) {
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  window.open(CONSOLE_URL, '_blank', 'noopener,noreferrer');
}

function createApply(React) {
  const h = React.createElement;

  function Panel() {
    return h(
      'div',
      { style: styles.section, 'data-mebular': 'settings-panel' },
      h('h2', { style: styles.title }, 'Mebular'),
      h(
        'p',
        { style: styles.description },
        'Manage devices, invitations and the star map in the Mebular app.',
      ),
      h(
        'div',
        { style: styles.row },
        h('span', { style: styles.label }, 'MCP endpoint'),
        h('code', { style: styles.endpoint }, MCP_ENDPOINT),
      ),
      h(
        'button',
        { type: 'button', style: styles.button, onClick: openConsole },
        'Open Mebular console',
      ),
      h(
        'p',
        { style: styles.hint },
        'Mebular runs separately from DSH. To use a custom port, update the URL in packages/dsh-plugin/cordis.patch.yml.',
      ),
    );
  }

  return function apply(ctx) {
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'mebular',
          order: 100,
          label: () => 'Mebular',
        },
        Panel,
      ),
    );
  };
}

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory: (require) => {
    const React = require('react');
    return { inject: ['slots'], apply: createApply(React) };
  },
});
