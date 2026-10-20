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

  it('E2-A2：?view=settings&focus=clouds → 常用页 + focusClouds（托盘「管理忆云…」）', () => {
    expect(initialViewFromSearch('?view=settings&focus=clouds')).toMatchObject({
      view: null,
      openSettings: 'common',
      focusClouds: true,
      focusSecurity: false,
    });
    expect(initialViewFromSearch('?view=settings&focus=security').focusClouds).toBe(false);
    expect(initialViewFromSearch('?view=map&focus=clouds').focusClouds).toBe(false);
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

describe('E2-A2 忆云入口与卡片（静态契约）', () => {
  it('顶栏：品牌后 #cloud-badge + 对称「加入忆云」「邀请设备」；无 #add-device', () => {
    expect(indexHtml).toMatch(/class="brand"[\s\S]{0,160}id="cloud-badge"/);
    expect(indexHtml).toContain('id="join-cloud"');
    expect(indexHtml).toContain('加入忆云');
    expect(indexHtml).toContain('id="invite-device"');
    expect(indexHtml).not.toContain('id="add-device"');
    expect(consoleJs).not.toContain("$('#add-device')");
  });

  it('加入弹层：令牌 / 名字 / 指纹预览 / 分步 / 结果面板', () => {
    for (const id of ['cloud-join-token', 'cloud-join-name', 'cloud-join-inspect', 'cloud-join-steps', 'cloud-join-result', 'cloud-join-submit']) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
    expect(consoleJs).toContain('/admin/api/clouds/inspect');
    expect(consoleJs).toContain('/admin/api/clouds/join');
    expect(consoleJs).toMatch(/body:\s*\{\s*token,\s*name,\s*confirm:\s*true\s*\}/);
    expect(consoleJs).toContain('正在校验令牌');
    expect(consoleJs).toContain('正在创建忆云');
    expect(consoleJs).toContain('mebular cloud use');
    expect(consoleJs).toContain('window.mebularDesktop?.cloudSwitch');
  });

  it('忆云卡：当前不可切换 / 已归档危险确认 / 改名即时生效 / 无删除入口', () => {
    expect(consoleJs).toContain('settings-cloud-card');
    expect(consoleJs).toMatch(/current\s*\?\s*''\s*:\s*`<button[^`]*data-cloud-switch/);
    expect(consoleJs).toContain('/admin/api/clouds/rename');
    expect(consoleJs).toContain('归档保留，不删除');
    expect(consoleJs).not.toContain('data-cloud-delete');
    expect(consoleJs).not.toContain('删除忆云');
    expect(consoleJs).toMatch(/settingsSignature[\s\S]{0,900}state\.clouds/);
  });

  it('邀请单屏：本忆云 + 根指纹 + 「加入忆云」指路', () => {
    expect(consoleJs).toContain('本忆云');
    expect(consoleJs).toContain('invite-cloud-identity');
    expect(consoleJs).toContain('让 TA 在控制台点「加入忆云」');
  });
});

describe('UX-2 定稿：中央空态遮罩下线（只有本机时不遮挡星图）', () => {
  it('empty-state 元素/渲染/样式全部移除；引导归顶栏真实按钮', () => {
    expect(consoleJs).not.toContain('renderEmptyState');
    expect(consoleJs).not.toContain('empty-state');
    expect(indexHtml).not.toContain('empty-state');
    const consoleCss = readFileSync(join(here, '..', '..', 'packages', 'console', 'console.css'), 'utf-8');
    expect(consoleCss).not.toContain('.empty-state');
    // 顶栏操作组几何统一（用户实拍：三个按钮大小不一致感）——固定高 + flex 居中 + 图标槽
    expect(consoleCss).toMatch(/\.topbar-actions \.btn \{[^}]*inline-flex[^}]*height: 34px/);
    expect(consoleCss).toMatch(/\.topbar-actions \.btn \.btn-ico \{[^}]*width: 15px/);
    // 引导入口（顶栏）仍在（图标槽 span + 文案）；E1：连接已有地址已撤下
    expect(indexHtml).toContain('btn-ico');
    expect(indexHtml).not.toContain('连接已有地址');
    expect(indexHtml).toContain('邀请设备');
    expect(indexHtml).toContain('诊断与恢复');
  });
});

describe('UX-2 定稿：图例默认收起（无首访自动展开）', () => {
  it('静态默认 is-collapsed + aria-expanded=false；渲染层无自动展开计时器', () => {
    expect(indexHtml).toMatch(/id="legend-panel"[^>]*is-collapsed/);
    expect(indexHtml).toMatch(/aria-expanded="false"/);
    expect(consoleJs).not.toContain('autoTimer');
    expect(consoleJs).toMatch(/默认收起/);
    expect(consoleJs).toMatch(/apply\(localStorage\.getItem\('mebular_legend_collapsed'\) !== '0'\)/);
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

  it('行内验证闭环：接入 → 待生效 → 「我已重载，验证」；不替用户发 reload', () => {
    expect(assistantsJs).toContain('我已重载，验证');
    expect(assistantsJs).toContain('已接好——重启');
    expect(assistantsJs).toContain('我们不会替你重启它');
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
    // S3：结果面板从 renderInvite 抽成 showInviteResult（low 直接出；medium/high 门槛通过后复用）
    expect(consoleJs).toMatch(/function showInviteResult\(res\)/);
    expect(consoleJs).toContain('令牌即入网权限');
    expect(consoleJs).toContain('扫码即通');
    expect(consoleJs).toContain('data-settings-fold="invite"');
    expect(consoleJs).toContain("foldLabel('invite')");
    expect(consoleJs).toContain('invite-endpoint');
  });

  it('重新生成收详情且二次确认（旧令牌失效是不可逆方向）', () => {
    expect(consoleJs).toContain('invite-regen-inline');
    expect(consoleJs).toMatch(/invite-regen-inline[\s\S]{0,260}confirm\(/);
  });

  it('joinService 未启用 → 弹层内一键启用（复用设置写路径，不再指路常用）', () => {
    expect(consoleJs).toContain('join_disabled');
    expect(consoleJs).toContain('invite-enable-service');
    expect(consoleJs).not.toContain('invite-to-settings');
  });
});

// ---------------------------------------------------------------------------
// UX-2 轮 B 收口：轮 A 注册表接线（状态机 / 行内 verify / 自定义助手 CRUD）
// ---------------------------------------------------------------------------

import { normalizeClient, assistantStatus, assistantsPanelHtml, assistantAddFormHtml } from '../../packages/console/assistants.js';

describe('UX-2 收口 ① normalizeClient：轮 A 新形状优先，旧形状兜底', () => {
  it('state/kind(type)/hasVerify/activation 全量对接；manual 与 custom 正确归类', () => {
    const file = normalizeClient({
      id: 'opencode', name: 'OpenCode', kind: 'builtin', type: 'file',
      state: 'not-connected', hasVerify: true,
      activation: { kind: 'user-reload' }, evidence: [{ kind: 'config-path', detail: 'hit' }],
      landing: { primaryPath: '/x/opencode.json', format: 'opencode' },
    });
    expect(file).toMatchObject({ id: 'opencode', manual: false, custom: false, installed: true, connected: false, hasVerify: true });
    expect(file.configPath).toBe('/x/opencode.json');

    const manual = normalizeClient({ id: 'g', name: 'G', kind: 'custom', type: 'snippet', state: 'manual', writer: { strategy: 'manual' } });
    expect(manual).toMatchObject({ manual: true, custom: true, installed: true, connected: false });

    // 旧形状兜底（无 state）：installed/connected 推导
    const legacy = normalizeClient({ id: 'old', name: 'Old', installed: true, connected: true });
    expect(legacy).toMatchObject({ installed: true, connected: true, manual: false });

    // 检测失败不算已安装
    expect(normalizeClient({ id: 'd', state: 'detect-failed' }).installed).toBe(false);
  });
});

describe('UX-2 收口 ② assistantStatus：verify 三态接入状态词（补丁 3 增补：clientRestart 降为提示层）', () => {
  const base = normalizeClient({ id: 'c', name: 'C', state: 'not-connected', hasVerify: true });
  it('verify-failed → 验证未过；verify pending-restart → 待生效（唯一来源）；connected 仍看落面', () => {
    expect(assistantStatus(base, { clientVerify: { c: { state: 'verify-failed' } } })).toMatchObject({ key: 'verify-failed', label: '验证未过', tone: 'todo' });
    expect(assistantStatus(base, { clientVerify: { c: { state: 'pending-restart' } } })).toMatchObject({ key: 'pending-reload', label: '待生效' });
    expect(assistantStatus(normalizeClient({ id: 'c', state: 'connected' }), {})).toMatchObject({ key: 'connected', label: '已接入 ✓' });
    expect(assistantStatus(base, {})).toMatchObject({ key: 'not-connected' });
    expect(assistantStatus(normalizeClient({ id: 'm', state: 'manual' }), {})).toMatchObject({ key: 'manual', label: '需手动' });
  });

  it('补丁 3 增补：clientRestart（已写入记忆）不再驱动「待生效」——服务端 connected → 已接入 ✓ + reloadHint 提示层', () => {
    // 用户真机事故回归：服务端已 connected 时 UI 永远不得显示「待生效」
    const conn = normalizeClient({ id: 'c', state: 'connected' });
    const st = assistantStatus(conn, { clientRestart: { c: true } });
    expect(st).toMatchObject({ key: 'connected', label: '已接入 ✓', reloadHint: true });
    expect(st.label).not.toBe('待生效');
    // 写入后 list 尚未刷到 connected 的窗口期：hint 存疑但不冒充状态词
    expect(assistantStatus(base, { clientRestart: { c: true } })).toMatchObject({ key: 'not-connected', reloadHint: false });
  });
});

describe('UX-2 收口 ③ 行内 verify 动作与 steps[] 渲染', () => {
  const clients = [
    { id: 'c', name: 'C', state: 'not-connected', hasVerify: true, landing: { primaryPath: '/x.json' } },
    { id: 'm', name: 'M', state: 'manual', type: 'snippet', writer: { strategy: 'manual' } },
  ];
  it('manual（粘片段）行永不出现自动写「接入」；not-connected 行主操作=接入', () => {
    const html = assistantsPanelHtml({ clients, ui: {} });
    const manualRow = html.match(/<div class="asst-row" data-asst-row="m">[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(manualRow).toContain('查看片段 ›');
    expect(manualRow).not.toContain('data-cli-action="connect"');
    const fileRow = html.match(/<div class="asst-row" data-asst-row="c">[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(fileRow).toContain('data-cli-action="connect"');
  });

  it('hasVerify → 详情内有「验证」；verify-failed → 黄态一行 + 重新验证 + 详情含输出', () => {
    const ui = {
      clientOpen: { c: true },
      clientVerify: { c: { state: 'verify-failed', steps: [
        { name: 'readback', label: '回读校验', ok: true, detail: '命中' },
        { name: 'cli', label: 'CLI 验证', ok: false, detail: '未通过（rc=1）', output: 'some cli stderr' },
      ] } },
    };
    const html = assistantsPanelHtml({ clients, ui });
    expect(html).toContain('data-cli-action="verify"');
    expect(html).toContain('重新验证');
    expect(html).toContain('回读校验');
    expect(html).toContain('CLI 验证');
    expect(html).toContain('验证未过');
    expect(html).toContain('some cli stderr'); // 详情含输出
  });

  it('pending-restart → 待生效一行 + 「我已重载，验证」= verify-confirm', () => {
    const ui = { clientVerify: { c: { state: 'pending-restart', steps: [] } } };
    const html = assistantsPanelHtml({ clients, ui });
    expect(html).toContain('待生效');
    expect(html).toContain('data-cli-action="verify-confirm"');
    expect(html).toContain('我已重载，验证');
  });
});

describe('UX-2 收口 ④ ＋新增助手 CRUD 表单与端点接线', () => {
  it('表单：选文件 / 粘片段双模式 + 全字段 id；编辑模式禁改 id', () => {
    const blank = assistantAddFormHtml();
    for (const token of ['asst-add-form', 'asst-add-name', 'asst-add-id', 'asst-add-path', 'asst-add-format', 'asst-add-submit', 'asst-add-cancel', 'name="asst-mode"']) {
      expect(blank).toContain(token);
    }
    expect(blank).toContain('选文件');
    expect(blank).toContain('粘片段');
    const edit = assistantAddFormHtml({ edit: { id: 'my-asst', name: '我的助手', landing: { format: 'mcpServers', primaryPath: '/a.json' }, writer: { strategy: 'merge-key' } } });
    expect(edit).toContain('data-edit-id="my-asst"');
    expect(edit).toMatch(/id="asst-add-id"[^>]*disabled/);
    expect(edit).toContain('value="/a.json"');
  });

  it('自定义行：详情内含「编辑」「移除」，且带「自定义」标记', () => {
    const html = assistantsPanelHtml({
      clients: [{ id: 'mine', name: 'Mine', kind: 'custom', state: 'not-connected', landing: { primaryPath: '/m.json' } }],
      ui: { clientOpen: { mine: true } },
    });
    expect(html).toContain('自定义');
    expect(html).toContain('data-asst-edit="mine"');
    expect(html).toContain('data-asst-remove="mine"');
  });

  it('console.js 接轮 A 端点：POST 新增 / PUT 更新 / POST remove / verify（userConfirmedReload）', () => {
    expect(consoleJs).toMatch(/api\('\/admin\/api\/assistants',\s*\{\s*method:\s*'POST'/);
    expect(consoleJs).toMatch(/api\(`\/admin\/api\/assistants\/\$\{encodeURIComponent\(read\.editId\)\}`,\s*\{\s*method:\s*'PUT'/);
    expect(consoleJs).toMatch(/api\(`\/admin\/api\/assistants\/\$\{encodeURIComponent\(id\)\}\/remove`/);
    expect(consoleJs).toMatch(/api\(`\/admin\/api\/clients\/\$\{id\}\/verify`/);
    expect(consoleJs).toMatch(/userConfirmedReload:\s*true/);
  });

  it('粘片段模式生成 manual descriptor（不出现自动写入面）；选文件模式生成 merge-key descriptor', () => {
    const fn = consoleJs.match(/function readAssistantForm[\s\S]*?\n}/)?.[0] ?? '';
    expect(fn).toContain("writer: { strategy: 'manual' }");
    expect(fn).toContain("writer: { strategy: 'merge-key', backup: 'byte-level' }");
    expect(fn).toContain("landing: { format: 'generic', primaryPath: null }");
    expect(fn).toContain("verify: { configReadback: true }");
  });

  it('移除需二次确认（window.confirm）', () => {
    const fn = consoleJs.match(/async function assistantRemove[\s\S]*?\n}/)?.[0] ?? '';
    expect(fn).toContain('window.confirm');
  });
});

// ---------------------------------------------------------------------------
// UX-2 补丁 4 · 滚动条主题化 + 拖拽区 + 交通灯避让（控制台侧契约）
// ---------------------------------------------------------------------------

describe('UX-2 补丁 4 · 控制台：滚动条/拖拽区/交通灯避让（静态契约）', () => {
  const consoleCss = readFileSync(join(here, '..', '..', 'packages', 'console', 'console.css'), 'utf-8');

  it('滚动条主题化：细 10px / 透明轨道 / 契约色 thumb / hover 微亮 / corner 清理（不隐藏滚动条）', () => {
    expect(consoleCss).toMatch(/::-webkit-scrollbar \{[^}]*width: 10px/);
    expect(consoleCss).toMatch(/::-webkit-scrollbar-track \{[^}]*transparent/);
    expect(consoleCss).toMatch(/::-webkit-scrollbar-thumb \{[^}]*rgba\(140, 255, 200/);
    expect(consoleCss).toMatch(/::-webkit-scrollbar-thumb:hover/);
    expect(consoleCss).toMatch(/::-webkit-scrollbar-corner \{[^}]*transparent/);
  });

  it('滚动手感：主滚动容器 scrollbar-gutter stable（html + panel-view/设置体 + 弹层等）', () => {
    expect(consoleCss).toMatch(/html \{ scrollbar-gutter: stable/);
    // 走查修复：由逐视图 ID 改为 .panel-view 类（审计/域视图此前漏配）
    expect(consoleCss).toMatch(/\.panel-view[^}]*scrollbar-gutter: stable/);
    expect(consoleCss).toMatch(/\.settings-scroll[^}]*scrollbar-gutter: stable/);
    expect(consoleCss).toMatch(/\.modal[^}]*scrollbar-gutter: stable/);
  });

  it('U-3 设置壳：提示在标题下 + 仅内容区滚动 + 右上角 X（无底部关闭）', () => {
    expect(consoleCss).toMatch(/\.modal-head \.settings-apply-note\s*\{[^}]*font-size:\s*11px/);
    expect(consoleCss).toMatch(/\.modal-box\.modal-settings\s*\{[^}]*overflow:\s*hidden/);
    expect(consoleCss).toMatch(/\.settings-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(consoleCss).toMatch(/\.settings-scroll[^}]*scrollbar-gutter:\s*stable/);
    expect(consoleCss).toMatch(/\.settings-scroll::-webkit-scrollbar\s*\{[^}]*width:\s*6px/);
    const start = indexHtml.indexOf('<div id="settings"');
    const end = indexHtml.indexOf('<div id="about"', start);
    const block = indexHtml.slice(start, end);
    expect(block).toContain('modal-heading');
    expect(block).toContain('class="settings-apply-note muted"');
    expect(block).toContain('id="settings-close"');
    expect(block).toContain('class="modal-x"');
    expect(block).not.toContain('modal-actions');
    expect(block).not.toContain('>关闭</button>');
  });

  it('走查修复：弹层顶部锚定（切设置选项卡时整层不再垂直跳）', () => {
    expect(consoleCss).toMatch(/\.modal \{[^}]*align-items: flex-start/);
  });

  it('拖拽区：顶栏可拖 + 可点元素 no-drag；macOS 壳交通灯安全区（shell-desktop-darwin）', () => {
    expect(consoleCss).toMatch(/\.topbar \{[^}]*-webkit-app-region: drag/);
    expect(consoleCss).toMatch(/\.topbar button[^{]*\{[^}]*-webkit-app-region: no-drag/);
    expect(consoleCss).toMatch(/\.shell-desktop-darwin \.topbar \{[^}]*padding-left: 84px/);
    expect(consoleJs).toContain('shell-desktop-darwin');
    expect(consoleJs).toMatch(/window\.mebularDesktop\?\.platform === 'darwin'/);
    // 走查修复 B：首帧前就位——shell-boot.js 同步于 <head>（先于样式/首帧），且已登记服务白名单
    const bootJs = readFileSync(join(here, '..', '..', 'packages', 'console', 'shell-boot.js'), 'utf-8');
    expect(bootJs).toContain("document.documentElement.classList.add('shell-desktop-darwin')");
    expect(indexHtml.indexOf('./shell-boot.js')).toBeGreaterThan(-1);
    expect(indexHtml.indexOf('./shell-boot.js')).toBeLessThan(indexHtml.indexOf('./console.css'));
    expect(serveSrc).toContain("'shell-boot.js'");
  });
  });
// UX-2 补丁 3：接入失败反馈语义 + 在途禁用（控制台 · 设置 · AI 助手）
// ---------------------------------------------------------------------------

describe('UX-2 补丁 3 · 控制台：接入失败语义（绝不落入「待生效」）', () => {
  const base = normalizeClient({ id: 'c', name: 'C', state: 'not-connected', hasVerify: true, landing: { primaryPath: '/x.json' } });

  it('connect 失败 →「接入失败」+ 重试；rolledBack → 「已自动还原原配置」+ 备份/命令摘要（内联）', () => {
    const ui = { clientFailed: { c: { kind: 'connect', reason: '写入失败（mcp_servers.mebular）已回滚', rolledBack: true, backupPath: '/x.json.bak-1', commands: [{ cmd: 'cfg set x', code: 1 }] } } };
    expect(assistantStatus(base, ui)).toMatchObject({ key: 'connect-failed', label: '接入失败', tone: 'todo' });
    const html = assistantsPanelHtml({ clients: [{ id: 'c', name: 'C', state: 'not-connected', hasVerify: true, landing: { primaryPath: '/x.json' } }], ui });
    expect(html).toContain('接入失败');
    expect(html).toContain('重试');
    expect(html).toContain('写入失败（mcp_servers.mebular）已回滚');
    expect(html).toContain('已自动还原原配置');
    expect(html).not.toContain('查看详情');
    expect(html).toContain('/x.json.bak-1');
    expect(html).toContain('cfg set x');
  });

  it('未回滚的失败（解析失败等）→「接入失败」+ 原因，无「还原」行；与 pending 并存时失败优先', () => {
    const ui = { clientFailed: { c: { kind: 'connect', reason: '配置无法解析（不自动改写）' } } };
    const html = assistantsPanelHtml({ clients: [{ id: 'c', name: 'C', state: 'not-connected' }], ui });
    expect(html).toContain('接入失败');
    expect(html).toContain('配置无法解析');
    expect(html).not.toContain('已自动还原');
    // 防御：failed + restart 同帧 → 接入失败优先（待生效 = 仅写入成功且待重载）
    expect(assistantStatus(base, { clientFailed: { c: { kind: 'connect', reason: 'x' } }, clientRestart: { c: true } }).label).toBe('接入失败');
  });

  it('在途 busy →「写入中…/验证中…」+ 按钮禁用；busy 优先于失败态', () => {
    expect(assistantStatus(base, { clientBusy: { c: 'connect' } })).toMatchObject({ key: 'busy', label: '写入中…' });
    expect(assistantStatus(base, { clientBusy: { c: 'verify' } })).toMatchObject({ key: 'busy', label: '验证中…' });
    expect(assistantStatus(base, { clientBusy: { c: 'connect' }, clientFailed: { c: { kind: 'connect', reason: 'x' } } }).key).toBe('busy');
    const html = assistantsPanelHtml({ clients: [{ id: 'c', name: 'C', state: 'not-connected' }], ui: { clientBusy: { c: 'connect' } } });
    const row = html.match(/<div class="asst-row" data-asst-row="c">[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(row).toContain('disabled');
    expect(row).not.toContain('data-cli-action='); // 在途不给任何可点动作
  });

  it('「待生效」新语义（补丁 3 增补）：仅服务端 verify pending-restart；clientRestart 是提示层', () => {
    expect(assistantStatus(base, { clientVerify: { c: { state: 'pending-restart' } } })).toMatchObject({ key: 'pending-reload', label: '待生效' });
    // clientRestart（写入记忆）+ 服务端 connected → 已接入 ✓（提示层小字，不覆盖状态词）
    const conn = normalizeClient({ id: 'c', state: 'connected' });
    expect(assistantStatus(conn, { clientRestart: { c: true } })).toMatchObject({ key: 'connected', reloadHint: true });
  });

  it('console.js 接线契约：clientFailed 取自 error.payload（reason/rolledBack/backupPath/commands）+ busy 包裹 + 签名含两者', () => {
    expect(consoleJs).toMatch(/state\.clientFailed\[id\] = \{[\s\S]{0,220}rolledBack: p\.rolledBack === true/);
    expect(consoleJs).toMatch(/state\.clientBusy\[id\] = action/);
    expect(consoleJs).toMatch(/delete state\.clientBusy\[id\]/);
    expect(consoleJs).toMatch(/state\.clientBusy \?\? null/);
    expect(consoleJs).toMatch(/state\.clientFailed \?\? null/);
    // recheck/成功清失败态
    expect(consoleJs).toMatch(/delete state\.clientFailed\[id\]/);
  });
});

describe('简化轮 · 术语净化（内部机制不上屏）', () => {
  it('主页三视图无内部术语（metadata/CSRF/scope/英文装饰副标）；记忆说明人话化', () => {
    expect(indexHtml).not.toContain('SECTOR SCAN');
    expect(indexHtml).not.toContain('SIGNAL LOG');
    expect(indexHtml).not.toContain('MEMORY CELLS');
    expect(indexHtml).not.toContain('metadata.archivedAt');
    expect(indexHtml).not.toContain('memory.admin');
    expect(indexHtml).not.toContain('CSRF');
    expect(indexHtml).toContain('收起来不再出现在回忆');
    expect(indexHtml).toContain('不可逆');
  });

  it('设置页不出订阅域/反熵细节（settings-ia 单一真源）；诊断并入高级', async () => {
    const ia = await import('../../packages/console/settings-ia.js');
    expect(ia.IA_TABS.map((t) => t.id)).toEqual(['common', 'security', 'assistants', 'mcp', 'advanced']);
    expect(ia.IA_MIGRATION['sync.namespaces']).toBe('domains');
    expect(ia.IA_EDITOR_RENDER_PATHS).not.toContain('sync.namespaces');
    for (const hidden of ['sync.antiEntropy.intervalMs', 'sync.antiEntropy.jitterRatio', 'sync.snapshotThreshold', 'semantic.minScore', 'sync.peerWhitelist']) {
      expect(ia.IA_EDITOR_RENDER_PATHS).not.toContain(hidden);
    }
    expect(ia.IA_EDITOR_RENDER_PATHS.length).toBe(13);
    expect(consoleJs).toContain('diag-fold');
  });
});

describe('简化轮 · stale 状态语义（#116 F-FIX-B：stdio 已写入需升级为直连）', () => {
  it('state=stale → 「已写入·需升级为直连」（todo 黄色），不得显示「未接入」或「待生效」', async () => {
    const { projectAssistantStatus } = await import('../../packages/console/assistant-status.js');
    const st = projectAssistantStatus({ id: 'x', state: 'stale', installed: true }, {});
    expect(st).toMatchObject({ key: 'stale', label: '已写入·需升级为直连', tone: 'todo' });
    expect(st.label).not.toBe('未接入');
    expect(st.label).not.toBe('待生效');
    // 两面一致（向导同一 helper）
    const { wizardRowStatus } = await import('../../apps/desktop/src/renderer/wizard-view.mjs');
    expect(wizardRowStatus({ id: 'x', state: 'stale', installed: true }, {})).toMatchObject({ key: 'stale', label: '已写入·需升级为直连' });
  });
});
