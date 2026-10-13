// R-1 PR-B · 向导③邀请改走 /admin/api/invite（中-8）+ 默认窗宽（小-12）
// 红→绿要点：无 fleet.config.json 的 fresh home 也能出邀请（不碰 fleet CLI，纯 HTTP 直调）。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inviteViaApi } from '../../apps/desktop/src/main/wizard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'index.mjs'), 'utf-8');

const http = { host: '127.0.0.1', port: 7331 };

/** mock fetch：GET 给 CSRF 头；POST 记录请求头并回 201 令牌。 */
function mockFetchOk(captured) {
  return async (url, opts = {}) => {
    if ((opts.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, headers: { get: (h) => (h === 'x-mebular-csrf' ? 'csrf-1' : null) }, json: async () => ({}) };
    }
    captured.headers = opts.headers;
    captured.url = url;
    return { ok: true, status: 201, json: async () => ({ token: 'tok-1', qrSvg: '<svg/>', endpoint: 'http://192.168.1.20:4002' }) };
  };
}

describe('R-1 中-8 邀请走 /admin/api/invite（fresh home 无 fleet.config.json 也可出邀请）', () => {
  it('成功：先取 CSRF 再带头发 POST，返回 token/qrSvg/endpoint', async () => {
    const captured = {};
    const res = await inviteViaApi(mockFetchOk(captured), http);
    expect(res.token).toBe('tok-1');
    expect(res.qrSvg).toBe('<svg/>');
    expect(res.endpoint).toBe('http://192.168.1.20:4002');
    expect(captured.url).toBe('http://127.0.0.1:7331/admin/api/invite');
    expect(captured.headers['x-mebular-csrf']).toBe('csrf-1');
  });

  it('409 join_disabled → 人话指引（不抛黑话）；网络失败 → warning 兜底', async () => {
    const disabled = await inviteViaApi(async () => ({ ok: false, status: 409, headers: { get: () => null }, json: async () => ({ error: 'join_disabled' }) }), http);
    expect(disabled.token).toBeNull();
    expect(disabled.warning).toContain('加入服务');
    const down = await inviteViaApi(async () => { throw new Error('ECONNREFUSED'); }, http);
    expect(down.token).toBeNull();
    expect(down.warning).toContain('邀请失败');
  });

  it('接线：createInvite 用 inviteViaApi（不再 spawn fleet CLI）', () => {
    const createInvite = indexSrc.match(/async function createInvite[\s\S]*?\n}/)?.[0] ?? '';
    expect(createInvite).toContain('inviteViaApi');
    expect(createInvite).not.toContain('spawnSync');
  });
});

describe('R-1 小-12 默认窗宽', () => {
  it('BrowserWindow width 1280（1180 临界拥挤）', () => {
    expect(indexSrc).toMatch(/width:\s*1280/);
  });
});
