// Mebular console · English copy (foundation batch)
//
// Rules:
// - Stable, flat keys (<area>.<meaning>); later batches migrate the remaining screens.
// - Interpolation uses {name}; placeholder sets must match zh-CN (scripts/check-i18n.mjs).
// - User data (device names, cloud names, namespaces, memory content) is never translated
//   and must not live in this catalog.

export default {
  // Top bar and navigation
  'app.title': 'Mebular Console',
  'app.brand': 'Mebular Console',
  'nav.map': 'Star map',
  'nav.domains': 'Sharing',
  'nav.memories': 'Memories',
  'nav.audit': 'Audit',
  'topbar.settings': 'Settings',
  'topbar.joinCloud': 'Join cloud',
  'topbar.invite': 'Invite device',
  'topbar.createCloud': 'New cloud',

  // Settings shell
  'settings.title': 'Local settings',
  'settings.aria': 'Local settings',
  'settings.tabsAria': 'Settings tabs',
  'settings.tab.common': 'General',
  'settings.tab.security': 'Security',
  'settings.tab.assistants': 'AI assistants',
  'settings.tab.mcp': 'MCP access',
  'settings.tab.advanced': 'Advanced',

  // Language setting (the only visible foundation entry until the full catalog is ready)
  'settings.language': 'Language',
  'settings.language.aria': 'Interface language',
  'settings.language.title': 'Interface language (applies immediately)',
  'settings.language.current': 'Current language: {language}',

  // Language names stay in their own language so the selected option is always readable
  'locale.zh-CN': '简体中文',
  'locale.en-US': 'English',
};
