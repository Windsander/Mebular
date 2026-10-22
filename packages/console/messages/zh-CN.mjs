// Mebular 控制台 · 简体中文文案（foundation 批次）
//
// 约定：
// - key 稳定、扁平命名（<区域>.<语义>）；迁移中的页面逐步补 key，不在本批一次性翻译全量界面。
// - 插值占位符用 {name}；zh-CN / en-US 的占位符集合必须一致（scripts/check-i18n.mjs）。
// - 用户数据（设备名、忆云名、命名空间、记忆内容）不进入 catalog。

export default {
  // 顶栏与导航
  'app.title': 'Mebular 控制台',
  'app.brand': 'Mebular 控制台',
  'nav.map': '星图',
  'nav.domains': '共享',
  'nav.memories': '记忆',
  'nav.audit': '审计',
  'topbar.settings': '设置',
  'topbar.joinCloud': '加入忆云',
  'topbar.invite': '邀请设备',
  'topbar.createCloud': '新建忆云',

  // 设置壳
  'settings.title': '本机设置',
  'settings.aria': '本机设置',
  'settings.tabsAria': '设置页签',
  'settings.tab.common': '常用',
  'settings.tab.security': '安全',
  'settings.tab.assistants': 'AI 助手',
  'settings.tab.mcp': 'MCP 接入',
  'settings.tab.advanced': '高级',

  // 语言设置（foundation 唯一可见入口；全量 catalog 完成前由就绪开关控制）
  'settings.language': '语言',
  'settings.language.aria': '界面语言',
  'settings.language.title': '界面语言（选择后立即生效）',
  'settings.language.current': '当前语言：{language}',

  // 语言名称始终用该语言自己的写法，避免用户看不懂当前选项
  'locale.zh-CN': '简体中文',
  'locale.en-US': 'English',
};
