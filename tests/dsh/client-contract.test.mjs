// P2 · @mebular/dsh-plugin client 契约：ModuleLoader 包装、slot 形状、无 JSX/构建依赖、无 Mebular import。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', '..', 'packages', 'dsh-plugin', 'client.js');
const source = readFileSync(clientPath, 'utf-8');

function loadClientModule(hostConfig) {
  let registration = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
  };
  if (hostConfig !== undefined) fakeWindow.__MEBULAR_DSH__ = hostConfig;
  runInNewContext(source, { window: fakeWindow }, { filename: clientPath });
  expect(registration).not.toBeNull();
  return registration;
}

function fakeReact() {
  return {
    createElement() {
      return null;
    },
  };
}

describe('P2 @mebular/dsh-plugin client：静态契约', () => {
  it('使用 window.__ModuleLoader__.load 手写包装，id 为包名', () => {
    expect(source).toContain('window.__ModuleLoader__.load({');
    expect(source).toMatch(/id:\s*'@mebular\/dsh-plugin'/);
    expect(source).toMatch(/factory:\s*\(require\)\s*=>/);
  });

  it('只 require react，不 require DSH/Mebular 包或 JSX runtime', () => {
    const required = [...source.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2]);
    expect(required).toEqual(['react']);
    expect(source).not.toContain('react/jsx-runtime');
    expect(source).not.toMatch(/from\s+['"]react['"]/);
    expect(source).toContain('React.createElement');
  });

  it('没有 JSX 语法，不需要构建步骤', () => {
    expect(source).not.toMatch(/<[A-Za-z][A-Za-z0-9]*[\s/>]/);
    expect(source).not.toMatch(/\.jsx?['"]/);
  });

  it('注册 sidebar.panellist（id）与根级 main（key）', () => {
    expect(source).toContain("ctx.slots.inject('sidebar.panellist'");
    expect(source).toContain("name: 'sidebar.panellist'");
    expect(source).toContain("id: 'mebular'");
    expect(source).toContain('order: 10');
    expect(source).toContain("label: 'Mebular'");
    expect(source).toContain("ctx.slots.inject('main'");
    expect(source).toContain("name: 'main'");
    expect(source).toContain("key: 'mebular'");
  });

  it('iframe 使用 embed=dsh、sandbox 白名单与固定发现路由', () => {
    expect(source).toContain("/mebular/embed-info");
    expect(source).toContain('?embed=dsh');
    expect(source).toContain("sandbox: 'allow-scripts allow-same-origin allow-forms'");
    expect(source).toContain('referrerPolicy:');
    expect(source).toContain('在浏览器打开 Console');
    expect(source).toContain('frameFailed');
  });

  it('handles starting / managed_cli_missing / managed_start_failed; only fixed routes may POST', () => {
    expect(source).toContain("info?.status === 'starting'");
    expect(source).toContain('startingTitle');
    expect(source).toContain('startingBody');
    expect(source).toContain('managed_cli_missing');
    expect(source).toContain('managed_start_failed');
    expect(source).toContain('cliMissingTitle');
    expect(source).toContain("'/mebular/runtime/install'");
    expect(source).toContain("'/mebular/runtime/upgrade'");
    expect(source).toMatch(/method:\s*'POST'/);
    expect(source).not.toContain('mebular:request');
    expect(source).not.toContain('postMessage');
    expect((source.match(/method:\s*'POST'/g) ?? [])).toHaveLength(1);
    expect((source.match(/method:\s*'(?:PUT|PATCH|DELETE)'/g) ?? [])).toHaveLength(0);
    expect(source).toMatch(/body:\s*JSON\.stringify\(\{\s*action\s*\}\)/);
    expect(source).not.toMatch(/JSON\.stringify\(\{[^}]*version/);
  });

  it('折叠 DSH 侧栏时为顶栏控制按钮保留安全区', () => {
    expect(source).toContain('data-sidebar-collapsed="true"');
    expect(source).toContain('headerSidebarCollapsed');
    expect(source).toContain('paddingLeft: 172');
    expect(source).toContain("'data-mebular-panel-header': 'true'");
  });

  it('渲染共享更新 banner、稍后/跳过/更新与紧凑 header 操作', () => {
    expect(source).toContain('function updateView');
    expect(source).toContain("kind: 'available'");
    expect(source).toContain("actions: ['update', 'later', 'skip']");
    expect(source).toContain("actions: ['update', 'later']");
    expect(source).toContain('dismissedVersion');
    expect(source).toContain('data-mebular-update');
    expect(source).toContain("'data-mebular-action': 'open-console'");
    expect(source).toContain("'data-mebular-action': 'refresh'");
    expect(source).not.toContain('serviceHint');
    expect(source).toContain('updateFailedTitle');
    expect(source).toContain('updateBusy');
  });

  it('只有主面板实际渲染 banner 后才确认 prompted，每版本一次', () => {
    expect(source).toContain('function confirmPrompted');
    expect(source).toContain("postAction(RUNTIME_UPGRADE_PATH, 'prompted'");
    expect(source).toContain('const promptedSent = new Set()');
    expect(source).toMatch(/promptLatest[\s\S]{0,240}?confirmPrompted/);
    expect(source).toContain('promptWarning');
    expect(source).not.toMatch(/function presentUpdate/);
  });

  it('读取 host tapIndex 注入的 panel 全局，且只在 panel === false 时跳过注册', () => {
    expect(source).toContain('__MEBULAR_DSH__');
    expect(source).toMatch(/panel\s*===\s*false/);
    expect(source).toContain('if (!panelEnabled()) return;');
  });

  it('版本不兼容时显示升级提示，并要求 embedProtocol === 1', () => {
    expect(source).toContain('info?.embedProtocol === 1');
    expect(source).toContain('embed_protocol_unsupported');
    expect(source).toContain('升级插件或 Mebular');
  });

  it('sidebar 状态点与面板共用同一个模块级 store，只有一处轮询', () => {
    expect(source).toContain('function createEmbedInfoStore');
    expect(source).toContain('const embedInfoStore = createEmbedInfoStore();');
    expect(source).toContain('function useEmbedInfo()');
    expect(source).toMatch(/function MebularStatusIcon[\s\S]*?useEmbedInfo\(\)/);
    expect(source).toMatch(/function MebularPanel[\s\S]*?useEmbedInfo\(\)/);
    expect(source).toContain('embedInfoStore.refresh()');
    expect((source.match(/setInterval\(/g) ?? []).length).toBe(1);
    expect(source).not.toContain('window.setInterval(tick');
  });

  it('状态点保留可读 title，并继续使用 label 作为 DSH 按钮名称', () => {
    expect(source).toContain('function statusTitle');
    expect(source).toContain('title: statusTitle(t, status)');
    expect(source).toContain("'data-mebular-status': status");
    expect(source).toContain("label: 'Mebular'");
    expect(source).toContain("'aria-hidden': 'true'");
    expect(source).toContain("'aria-label': t.openConsole");
    expect(source).toContain("'aria-label': t.refresh");
  });

  it('daemon down 文案说明 MCP 工具暂不可用且会自动恢复', () => {
    expect(source).toContain('MCP tools are unavailable until it starts');
    expect(source).toContain('MCP 工具暂时不可用');
    expect(source).toContain('tools recover automatically');
    expect(source).toContain('工具会自动恢复');
  });

  it('不 import @mebular/* 或 Console 资源', () => {
    const specifiers = [
      ...[...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]),
      ...[...source.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      ),
    ];
    expect(specifiers.filter((specifier) => specifier.startsWith('@mebular/'))).toEqual([]);
    expect(source).not.toMatch(/packages\/console/);
    expect(source).not.toContain('console.js');
  });
});

describe('P2 @mebular/dsh-plugin client：运行时注册形状', () => {
  it('factory 暴露 apply + inject，apply 注册两个槽位', () => {
    const registration = loadClientModule();
    expect(registration.id).toBe('@mebular/dsh-plugin');
    expect(typeof registration.factory).toBe('function');

    const exportsObject = registration.factory((name) => {
      expect(name).toBe('react');
      return fakeReact();
    });
    expect(exportsObject.inject).toEqual(['slots']);
    expect(typeof exportsObject.apply).toBe('function');

    const events = [];
    const ctx = {
      slots: {
        inject(name, factory) {
          events.push({ type: 'inject', name });
          const dispose = factory();
          events.push({ type: 'dispose', value: typeof dispose });
          return dispose;
        },
        register(options) {
          events.push({ type: 'register', options });
          return () => {};
        },
      },
    };

    exportsObject.apply(ctx);

    expect(events.filter((event) => event.type === 'inject').map((event) => event.name)).toEqual([
      'sidebar.panellist',
      'main',
    ]);
    const registrations = events.filter((event) => event.type === 'register').map((event) => event.options);
    expect(registrations).toHaveLength(2);
    expect(registrations[0]).toMatchObject({
      name: 'sidebar.panellist',
      id: 'mebular',
      order: 10,
      label: 'Mebular',
    });
    expect(registrations[1]).toMatchObject({
      name: 'main',
      key: 'mebular',
    });
    expect(events.filter((event) => event.type === 'dispose').every((event) => event.value === 'function')).toBe(true);
  });

  it('host 全局 panel:false 时 apply 不注册 sidebar/main；缺省仍注册', () => {
    for (const [hostConfig, expectedCalls] of [
      [{ panel: false }, 0],
      [{ panel: true }, 2],
      [undefined, 2],
      [{ panel: 'false' }, 2],
    ]) {
      const registration = loadClientModule(hostConfig);
      const exportsObject = registration.factory((name) => {
        expect(name).toBe('react');
        return fakeReact();
      });
      const events = [];
      const ctx = {
        slots: {
          inject(name, factory) {
            events.push({ type: 'inject', name });
            factory();
          },
          register() {
            events.push({ type: 'register' });
            return () => {};
          },
        },
      };
      exportsObject.apply(ctx);
      expect(events.filter((event) => event.type === 'inject')).toHaveLength(expectedCalls);
      expect(events.filter((event) => event.type === 'register')).toHaveLength(expectedCalls);
    }
  });
});
