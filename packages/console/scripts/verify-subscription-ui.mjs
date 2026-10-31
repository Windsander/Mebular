#!/usr/bin/env node
// W-B：控制台订阅语义静态验收（无需守护/网络）。
//   - 用户可见术语：订阅 / 已订阅 / 未订阅 / 新建记忆域 / 退出并交接；
//   - 用户可见「授权 / 签发 / 成员制 / 参与」为 0；
//   - 旧授权端点（grants / policy-issuers / memberships）为 0；
//   - 新订阅端点（subscriptions / namespaces / restore）存在。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${root}/index.html`, 'utf-8');
const js = readFileSync(`${root}/console.js`, 'utf-8');
const ia = readFileSync(`${root}/settings-ia.js`, 'utf-8');
// i18n：用户可见文案真源在 locales/zh-CN/console.json；静态检查与 JS 源码合并。
const zhCopy = JSON.parse(readFileSync(`${root}/../../locales/zh-CN/console.json`, 'utf-8')).messages;
const all = `${html}\n${js}\n${ia}\n${Object.values(zhCopy).join('\n')}`;

const checks = [];
const check = (name, ok, detail = undefined) => {
  checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

check('共享页含订阅三态文案', /订阅/.test(all) && /已订阅/.test(all) && /未订阅/.test(all));
check('共享页含新建记忆域与退出并交接', html.includes('新建记忆域') && html.includes('退出并交接'));
check('共享页头部唯一 CTA = 新建记忆域（无空态按钮/邀请）',
  html.includes('id="namespace-new"') && !html.includes('domains-empty-new')
  && !html.includes('domains-empty-invite')
  && !/domains-empty[\s\S]{0,800}邀请设备/.test(html));
check('空态文案：只有本机也可以新建并记录', html.includes('只有本机也可以新建记忆域并开始记录'));
const domainsSection = html.slice(html.indexOf('id="domains-view"'), html.indexOf('id="audit-view"'));
check('邀请设备只在顶栏/邀请弹层（共享页无 CTA）',
  html.includes('id="invite-device"') && domainsSection.length > 0 && !/邀请设备/.test(domainsSection));
check('新建域默认自订阅（create 请求 subscribe:true + toast）', /createNamespace[\s\S]{0,600}subscribe:\s*true/.test(js) && /已创建并订阅/.test(all));
check('全站无「添加设备」', !all.includes('添加设备'));
check('peerWhitelist 不在 GUI 可编辑面', !ia.includes("'sync.peerWhitelist'"));
check('用户可见「授权/签发/成员制/参与」为 0', !/授权|签发|成员制|参与/.test(all), {
  matches: (all.match(/授权|签发|成员制|参与/g) ?? []).slice(0, 5),
});
check('旧授权端点已删除', !/\/admin\/api\/(grants|policy-issuers|memberships)/.test(js));
check('订阅端点存在', js.includes('/admin/api/subscriptions') && js.includes('/admin/api/namespaces'));
check('恢复设备端点存在', js.includes('/restore') && js.includes('restore-device'));
check('审计动作只含新策略事件', html.includes('namespace_subscription') && html.includes('device_restore') && !html.includes('namespace_' + 'grant'));

const failed = checks.filter((c) => !c.ok);
console.log(`CONSOLE_SUMMARY ${JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed: failed.map((c) => c.name) })}`);
process.exit(failed.length === 0 ? 0 : 1);
