// 控制台壳层细节：设置页签单行 / 邀请令牌块宽稳定 / 自定义下拉统一高度。
// 静态契约（不启浏览器）；活体像素断言在 verify:console:ui（1440/1024/390）。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

const root = new URL('../../', import.meta.url);
const css = readFileSync(new URL('packages/console/console.css', root), 'utf-8');
const en = JSON.parse(readFileSync(new URL('locales/en-US/console.json', root), 'utf-8')).messages;

describe('设置页签：英文单行 + 精简文案', () => {
  it('settings-tab 全局 nowrap / 不参与压缩；≤760 才允许容器换行', () => {
    expect(css).toMatch(/\.settings-tab \{[\s\S]*?white-space: nowrap;[\s\S]*?\}/);
    expect(css).toMatch(/\.settings-tab \{[\s\S]*?flex: 0 0 auto;[\s\S]*?\}/);
    expect(css).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.settings-tabs \{ flex-wrap: wrap; \}/);
  });

  it('英文页签文案精简但不含中文，且含义完整', () => {
    expect(en['settings.tab.assistants']).toBe('Assistants');
    expect(en['settings.tab.mcp']).toBe('MCP');
    expect(en['settings.extra.about']).toBe('About device');
    for (const key of ['settings.tab.assistants', 'settings.tab.mcp', 'settings.extra.about']) {
      expect(en[key]).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
});

describe('邀请令牌块：宽/左边界不随忙态按钮文字变化', () => {
  it('invite-main 单列 minmax(0,1fr)、token block width:100%', () => {
    expect(css).toMatch(/\.invite-main \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.invite-token-block \{[^}]*width: 100%/);
  });

  it('重新生成按钮预留两态宽度且不压缩；controls 自身 min-width:0', () => {
    expect(css).toMatch(/\.invite-controls \{[^}]*min-width: 0/);
    expect(css).toMatch(/\.invite-controls #invite-regenerate \{[^}]*flex: 0 0 auto;[^}]*min-width: 84px[^}]*height: var\(--select-h\)/);
    expect(css).toMatch(/\.invite-controls #invite-regenerate \{[^}]*justify-content: center/);
  });
});

describe('自定义下拉高度：统一 token + 按上下文对齐', () => {
  it('声明 --select-h / --select-h-compact 两个 token', () => {
    expect(css).toMatch(/--select-h: 26px;/);
    expect(css).toMatch(/--select-h-compact: 32px;/);
  });

  it('普通 trigger 26px；compact 32px；邀请与语言行复用标准档', () => {
    expect(css).toMatch(/\.crt-select-trigger \{[\s\S]*?height: var\(--select-h\);/);
    expect(css).toMatch(/\.crt-select--compact \.crt-select-trigger,[\s\S]*?height: var\(--select-h-compact\);/);
    expect(css).toMatch(/\.invite-ttl \.crt-select-trigger \{[^}]*height: var\(--select-h\)/);
    expect(css).toMatch(/\.settings-language-control \.crt-select-trigger \{[^}]*height: var\(--select-h\)/);
  });

  it('设置输入框与下拉同高；助手表单文本框同高（相邻控件 ≤1px 的前提）', () => {
    expect(css).toMatch(/\.cfg-control \.cfg-input \{ height: var\(--select-h\); \}/);
    expect(css).toMatch(/\.asst-form-grid \.crt-input \{ height: var\(--select-h\); \}/);
  });

  it('菜单圆角/定位策略未被改动（仍 8px、fixed）', () => {
    expect(css).toMatch(/\.crt-select-menu \{[^}]*position: fixed;[^}]*border-radius: 8px;/);
  });
});
