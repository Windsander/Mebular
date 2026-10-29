// 设置 · 常用「自动修复」：失败详情可展开、内容转义（不把 token/HTML 带进 DOM）。

import { describe, it, expect } from '@jest/globals';
import { repairRowHtml } from '../../packages/console/assistants.js';

describe('repairRowHtml', () => {
  it('渲染失败摘要 + 可展开 per-client 详情', () => {
    const html = repairRowHtml({
      busy: false,
      message: '已修复 1 个，1 个未完成：OpenCode。',
      tone: 'error',
      details: [
        { name: 'OpenCode', reasons: ['接入失败：写入失败已回滚', 'Skill 安装失败：源缺少 mcp/'] },
        { name: 'Hermes', reasons: ['验证失败：rc=1'] },
      ],
    });
    expect(html).toContain('settings-repair-row');
    expect(html).toContain('settings-repair-details');
    expect(html).toContain('失败详情（2）');
    expect(html).toContain('<b>OpenCode</b>');
    expect(html).toContain('写入失败已回滚');
    expect(html).toContain('源缺少 mcp/');
    expect(html).toContain('<b>Hermes</b>');
    expect(html).toContain('rc=1');
  });

  it('详情做 HTML 转义 + 密钥脱敏；无详情时不渲染 details', () => {
    const html = repairRowHtml({
      message: '失败',
      tone: 'error',
      details: [{ name: '<img src=x onerror=alert(1)>', reasons: ['token=abc123 <script>bad()</script>', 'Bearer xyz.abc sk-1234567890'] }],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('abc123');
    expect(html).not.toContain('xyz.abc');
    expect(html).not.toContain('sk-1234567890');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('token=&lt;redacted&gt;');
    expect(html).toContain('Bearer &lt;redacted&gt;');
    expect(html).toContain('sk-&lt;redacted&gt;');

    const plain = repairRowHtml({ message: '', busy: false });
    expect(plain).not.toContain('settings-repair-details');
  });

  it('busy 时按钮禁用并显示修复中', () => {
    const html = repairRowHtml({ busy: true, message: '正在逐个检查并修复…' });
    expect(html).toContain('disabled');
    expect(html).toContain('修复中…');
  });
});
