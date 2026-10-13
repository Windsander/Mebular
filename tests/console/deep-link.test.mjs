// R-1 PR-B · console 接缝断言：深链 view 参数（高-3）/ 桌面壳感知（高-4）/ 连接页减负（中-5）
// 重启闭环（中-6）/ 词表对齐。纯函数单测 + 静态契约（不启浏览器、不引依赖）。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialViewFromSearch, CONSOLE_VIEWS } from '../../packages/console/deep-link.js';

const here = dirname(fileURLToPath(import.meta.url));
const consoleJs = readFileSync(join(here, '..', '..', 'packages', 'console', 'console.js'), 'utf-8');
const indexHtml = readFileSync(join(here, '..', '..', 'packages', 'console', 'index.html'), 'utf-8');
const serveSrc = readFileSync(join(here, '..', '..', 'packages', 'mcp', 'src', 'serve.mjs'), 'utf-8');

describe('R-1 高-3 view 深链映射（initialViewFromSearch）', () => {
  it('?view=connect → connect；?view=connect&step=device → connect + 打开邀请', () => {
    expect(initialViewFromSearch('?view=connect')).toMatchObject({ view: 'connect', openInvite: false });
    expect(initialViewFromSearch('?view=connect&step=device')).toMatchObject({ view: 'connect', openInvite: true });
  });

  it('合法视图全量映射；非法/缺省 → null（回退 map）', () => {
    for (const v of CONSOLE_VIEWS) {
      expect(initialViewFromSearch(`?view=${v}`).view).toBe(v);
    }
    expect(initialViewFromSearch('?view=hack').view).toBeNull();
    expect(initialViewFromSearch('').view).toBeNull();
    expect(initialViewFromSearch('?mock=1&token=x').view).toBeNull();
  });

  it('?shell=desktop → shellDesktop 标志', () => {
    expect(initialViewFromSearch('?shell=desktop').shellDesktop).toBe(true);
    expect(initialViewFromSearch('?view=connect&shell=desktop')).toMatchObject({ view: 'connect', shellDesktop: true });
  });

  it('接线：console.js 消费 initialViewFromSearch 并以深链视图启动', () => {
    expect(consoleJs).toMatch(/initialViewFromSearch\(location\.search\)/);
    expect(consoleJs).toMatch(/setView\(deepLink\.view \?\? 'map'\)/);
    expect(consoleJs).toMatch(/deepLink\.openInvite/);
  });

  it('console.js 的全部本地模块 import 都在 serve 静态白名单（CONSOLE_FILES）内', () => {
    const imports = [...consoleJs.matchAll(/from\s*'\.\/([\w-]+\.js)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    const filesBlock = serveSrc.match(/CONSOLE_FILES\s*=\s*\{[\s\S]*?\}/)?.[0] ?? '';
    for (const f of imports) expect(filesBlock).toContain(`'${f}'`);
  });
});

describe('R-1 高-3 空态词表对齐真实按钮', () => {
  it('空态提到「＋ 连接已有地址」与「＋ 邀请新设备」，不再指不存在的「＋ 连接新对端」', () => {
    const emptyBlock = consoleJs.match(/function renderEmptyState[\s\S]*?\n}/)?.[0] ?? '';
    expect(emptyBlock).toContain('＋ 连接已有地址');
    expect(emptyBlock).toContain('＋ 邀请新设备');
    expect(emptyBlock).not.toContain('＋ 连接新对端');
  });
});

describe('R-1 高-4 桌面壳感知（provision 引导页不给终端指令）', () => {
  it('index.html 待重启面板有一键「重启守护」壳按钮（默认隐藏）', () => {
    expect(indexHtml).toMatch(/id="provision-restart-shell"[^>]*hidden|hidden[^>]*id="provision-restart-shell"/);
  });

  it('console.js：desktop 壳下待重启走 window.mebularDesktop.restart，不展示 nohup', () => {
    expect(consoleJs).toMatch(/window\.mebularDesktop\?\.restart/);
    expect(consoleJs).toMatch(/provision-restart-shell/);
  });

  it('serve.mjs / console.js 不再写死 ~/.mebular 路径（用真实 home）', () => {
    expect(serveSrc).not.toContain('~/.mebular/serve.log');
    expect(serveSrc).toContain('${home}/serve.log');
    expect(consoleJs).not.toContain('~/.mebular/serve.log');
  });
});

describe('R-1 中-5/中-6 连接页减负 + 重启闭环（静态契约）', () => {
  it('分组折叠：已装可接入 / 未安装 / 手动 三组 <details class="connect-group">', () => {
    expect(consoleJs).toContain('connect-group');
    expect(consoleJs).toContain('已装可接入');
    expect(consoleJs).toContain('未安装');
    expect(consoleJs).toContain('需手动合并');
  });

  it('每卡 1 个主按钮「接入」；已接入 → 「已接入 ✓」收编；其余进 overflow「更多」', () => {
    expect(consoleJs).toContain('已接入 ✓');
    expect(consoleJs).toMatch(/connect-overflow[\s\S]*?>更多</);
  });

  it('回滚有二次确认（小-11）；接入成功给重启 checklist（中-6）', () => {
    expect(consoleJs).toMatch(/action\s*===\s*'rollback'[\s\S]{0,200}confirm\(/);    expect(consoleJs).toContain('完全退出该助手');
    expect(consoleJs).toContain('我已重启，重新检测');
  });

  it('常驻卡不再展示 plist 全路径；移入「关于本机」', () => {
    const serviceCard = consoleJs.match(/const serviceBox[\s\S]*?const list/)?.[0] ?? '';
    expect(serviceCard).not.toContain('unitPath');
    expect(consoleJs).toMatch(/常驻服务文件[\s\S]{0,120}unitPath|unitPath[\s\S]{0,120}常驻服务文件/);
  });

  it('小-10：desktop 壳下连接页有「返回向导」（window.mebularDesktop.openWizard）', () => {
    expect(indexHtml).toContain('id="connect-back-wizard"');
    expect(consoleJs).toMatch(/window\.mebularDesktop\?\.openWizard/);
  });
});
