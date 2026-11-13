// 设置 · 常用最终行结构：重启与向导都有独立入口，更多只承担取消常驻。

import { describe, expect, it } from '@jest/globals';
import { restartRowHtml, serviceRowHtml, wizardRowHtml } from '../../packages/console/assistants.js';

describe('设置 · 本机运行行', () => {
  it('临时运行：保留安装与独立重启，不渲染无动作的更多菜单', () => {
    const service = serviceRowHtml({ registered: false, running: true });
    expect(service).toContain('data-svc-action="install"');
    expect(service).toContain('asst-row settings-resident-row');
    expect(service).toContain('settings-row-status');
    expect(service).toContain('开机自启');
    expect(service).not.toContain('kv-dot');
    expect(service).not.toContain('settings-row-stack');
    expect(service).not.toContain('settings-row-meta');
    expect(service).not.toContain('data-settings-more');
    expect(restartRowHtml()).toContain('class="asst-row settings-restart-row"');
    expect(restartRowHtml()).toContain('data-svc-action="restart"');
  });

  it('已常驻：更多只含取消常驻，重新检测仍在主行', () => {
    const service = serviceRowHtml({ registered: true, running: true });
    expect(service).toContain('data-svc-action="recheck"');
    expect(service).toContain('data-svc-action="uninstall"');
    expect(service).not.toContain('data-svc-action="restart"');
    expect(service).toContain('aria-haspopup="menu"');
  });

  it('重启向导：仅在桌面桥可用时渲染独立行与既有 id/title', () => {
    expect(wizardRowHtml(false)).toBe('');
    const row = wizardRowHtml(true);
    expect(row).toContain('class="asst-row settings-wizard-row"');
    expect(row).toContain('id="settings-open-wizard"');
    expect(row).toContain('title="');
    expect(row).toContain('已有配置');
  });
});
