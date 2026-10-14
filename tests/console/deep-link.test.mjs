// R-1 PR-B · console 接缝断言：深链 view 参数（高-3）/ 桌面壳感知（高-4）
// UX-2：连接页收编进「设置 · AI 助手」（?view=connect 保留为别名重定向）/ 邀请单动作 / 首屏叠加层。
// 纯函数单测 + 静态契约（不启浏览器、不引依赖）。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialViewFromSearch, CONSOLE_VIEWS } from '../../packages/console/deep-link.js';

const here = dirname(fileURLToPath(import.meta.url));
const consoleJs = readFileSync(join(here, '..', '..', 'packages', 'console', 'console.js'), 'utf-8');
const assistantsJs = readFileSync(join(here, '..', '..', 'packages', 'console', 'assistants.js'), 'utf-8');
const indexHtml = readFileSync(join(here, '..', '..', 'packages', 'console', 'index.html'), 'utf-8');
const serveSrc = readFileSync(join(here, '..', '..', 'packages', 'mcp', 'src', 'serve.mjs'), 'utf-8');

describe('R-1 高-3 view 深链映射（initialViewFromSearch）', () => {
  it('UX-2：?view=connect → 别名重定向（openSettings=assistants，view=null 回退 map）；&step=device 直达邀请弹层', () => {
    expect(initialViewFromSearch('?view=connect')).toMatchObject({ view: null, openSettings: 'assistants', openInvite: false });
    expect(initialViewFromSearch('?view=connect&step=device')).toMatchObject({ view: null, openSettings: null, openInvite: true });
    expect(CONSOLE_VIEWS).not.toContain('connect');
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
    expect(initialViewFromSearch('?view=connect&shell=desktop')).toMatchObject({ view: null, shellDesktop: true });
  });

  it('接线：console.js 消费 initialViewFromSearch 并以深链视图启动 + 别名重定向开设置', () => {
    expect(consoleJs).toMatch(/initialViewFromSearch\(location\.search\)/);
    expect(consoleJs).toMatch(/setView\(deepLink\.view \?\? 'map'\)/);
    expect(consoleJs).toMatch(/deepLink\.openInvite/);
    expect(consoleJs).toMatch(/deepLink\.openSettings[\s\S]{0,160}renderSettings\(deepLink\.openSettings\)/);
  });

  it('console.js 的全部本地模块 import 都在 serve 静态白名单（CONSOLE_FILES）内', () => {
    const imports = [...consoleJs.matchAll(/from\s*'\.\/([\w-]+\.js)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    const filesBlock = serveSrc.match(/CONSOLE_FILES\s*=\s*\{[\s\S]*?\}/)?.[0] ?? '';
    for (const f of imports) expect(filesBlock).toContain(`'${f}'`);
  });

  it('UX-2：新模块 assistants.js 已登记 CONSOLE_FILES 且被 console.js 引用', () => {
    const filesBlock = serveSrc.match(/CONSOLE_FILES\s*=\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(filesBlock).toContain("'assistants.js'");
    expect(consoleJs).toMatch(/from '\.\/assistants\.js'/);
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

describe('UX-2 设置 · AI 助手专区（单列表，静态契约）', () => {
  it('行模板：名称 + 状态词 + 一个动作（asst-row）；状态词同引导语言', () => {
    expect(assistantsJs).toContain('asst-row');
    for (const word of ['未安装', '未接入', '待生效', '已接入 ✓', '需手动', '检测失败', '验证未过']) {
      expect(assistantsJs).toContain(word);
    }
  });

  it('需处理优先排序；未安装进底部折叠「未安装（n）」', () => {
    expect(assistantsJs).toMatch(/function sortClients/);
    expect(assistantsJs).toContain('未安装（');
    expect(assistantsJs).toContain('asst-missing');
  });

  it('行内验证闭环：接入 → 待生效 → 「我已重载，重新验证」；不替用户发 reload', () => {
    expect(assistantsJs).toContain('我已重载，重新验证');
    expect(assistantsJs).toContain('已接好，重载');
    expect(assistantsJs).toContain('我们不会替你发 reload');
  });

  it('回滚有二次确认（小-11 保持）；详情行内展开（判据/路径/次级动作）', () => {
    expect(consoleJs).toMatch(/action\s*===\s*'rollback'[\s\S]{0,200}confirm\(/);
    expect(assistantsJs).toContain('data-cli-action="details"');
    expect(assistantsJs).toContain('查看改动');
    expect(assistantsJs).toContain('回滚');
  });

  it('对轮 A 未知字段容忍：state/evidence/hasVerify/activation 可选链归一化', () => {
    expect(assistantsJs).toMatch(/c\.state\s*\?\?/);
    expect(assistantsJs).toContain('c.evidence ?? null');
    expect(assistantsJs).toContain('c.activation ?? null');
  });
});

describe('UX-2 常驻卡归设置 · 常用 + 重启向导', () => {
  it('常驻运行行进 common 面板（settings-resident），按状态唯一主操作', () => {
    expect(consoleJs).toContain('settings-resident');
    expect(consoleJs).toMatch(/panel\('common'[\s\S]{0,400}serviceRowHtml/);
    expect(assistantsJs).toContain('让 Mebular 常驻');
  });

  it('常驻卡不展示 plist 全路径；仍在「关于本机 · 常驻服务文件」', () => {
    expect(assistantsJs).not.toContain('unitPath');
    expect(consoleJs).toMatch(/常驻服务文件[\s\S]{0,120}unitPath|unitPath[\s\S]{0,120}常驻服务文件/);
  });

  it('重启向导：设置 · 常用行 + desktop 桥（web 无桥不渲染）', () => {
    expect(assistantsJs).toContain('重启向导');
    expect(assistantsJs).toContain('settings-open-wizard');
    expect(consoleJs).toMatch(/window\.mebularDesktop\?\.openWizard/);
    expect(assistantsJs).toContain('不动已有配置');
  });
});

describe('UX-2 首屏叠加层（只读；星图本体不改）', () => {
  it('index.html 有 status-pill 与 attention-card 容器（默认 hidden）', () => {
    expect(indexHtml).toMatch(/id="status-pill"[^>]*hidden|hidden[^>]*id="status-pill"/);
    expect(indexHtml).toMatch(/id="attention-card"[^>]*hidden|hidden[^>]*id="attention-card"/);
  });

  it('renderOverlays 只在星图视图显示；注意浮卡无事不出现（items 空 → hidden）', () => {
    expect(consoleJs).toMatch(/function renderOverlays[\s\S]{0,900}state\.view === 'map'/);
    expect(consoleJs).toMatch(/card\.hidden = !onMap \|\| items\.length === 0/);
  });

  it('叠加层 [hidden] 不被 display 覆盖（回归：非星图视图状态条必须真隐藏）', () => {
    const cssSrc = readFileSync(join(here, '..', '..', 'packages', 'console', 'console.css'), 'utf-8');
    expect(cssSrc).toMatch(/\.status-pill\[hidden\][^{]*\{[^}]*display:\s*none/);
  });

  it('注意项点击直达：助手 → 设置·AI 助手', () => {
    expect(consoleJs).toMatch(/data-attention-action/);
    expect(consoleJs).toMatch(/attentionAction === 'assistants'[\s\S]{0,160}renderSettings\('assistants'\)/);
  });
});

describe('UX-2 邀请单动作页', () => {
  it('主结果 = QR + 令牌复制；次级（端点编辑/多余命令/警告）收「详情」折叠', () => {
    const inviteBlock = consoleJs.match(/async function renderInvite[\s\S]*?\n {2}\} catch/)?.[0] ?? '';
    expect(inviteBlock).toContain('让新设备扫码或粘贴令牌加入');
    expect(inviteBlock).toContain('<details class="asst-detail"><summary>详情</summary>');
    expect(inviteBlock).toContain('invite-endpoint');
  });

  it('重新生成收详情且二次确认（旧令牌失效是不可逆方向）', () => {
    expect(consoleJs).toContain('invite-regen-inline');
    expect(consoleJs).toMatch(/invite-regen-inline[\s\S]{0,260}confirm\(/);
  });

  it('joinService 未启用 → 一行式 + 「去设置启用」', () => {
    expect(consoleJs).toContain('join_disabled');
    expect(consoleJs).toContain('invite-to-settings');
  });
});
