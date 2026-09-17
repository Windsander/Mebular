// Fleet M4：OpenChamber 适配器（基于注入的 seam；不接真实通道）。

import { describe, it, expect } from '@jest/globals';
import { OpenChamberAgent, type OpenChamberSessionSeam } from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';
import { reduceTaskEvents } from '../../packages/fleet/src/index.js';

const task = (intent: string) =>
  reduceTaskEvents([mkEvent('created', `oc-${intent}`, { to: { device: 'device-B', agent: 'openchamber' }, intent, trace: { chain: [] } })])!;

describe('OpenChamberAgent（seam 接口）', () => {
  it('成功：结果=文本、reason=session', async () => {
    const seam: OpenChamberSessionSeam = { prompt: async () => ({ text: 'OC_RESULT', sessionId: 'ses-1' }) };
    expect(await new OpenChamberAgent(seam).execute(task('hi'))).toEqual({ ok: true, reason: 'session:ses-1', resultRef: 'OC_RESULT' });
  });

  it('seam 返回 error → failed(OPENCHAMBER_ERROR)', async () => {
    const seam: OpenChamberSessionSeam = { prompt: async () => ({ text: '', error: 'no seam' }) };
    const outcome = await new OpenChamberAgent(seam).execute(task('hi'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('OPENCHAMBER_ERROR: no seam');
  });

  it('seam 抛错 → failed(OPENCHAMBER_ERROR)', async () => {
    const seam: OpenChamberSessionSeam = {
      prompt: async () => {
        throw new Error('boom');
      },
    };
    const outcome = await new OpenChamberAgent(seam).execute(task('hi'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('OPENCHAMBER_ERROR: boom');
  });

  it('传递 options（cwd/model/agent/timeout）与截断', async () => {
    let seen: Record<string, unknown> = {};
    const seam: OpenChamberSessionSeam = {
      prompt: async (input) => {
        seen = input as unknown as Record<string, unknown>;
        return { text: 'y'.repeat(5000) };
      },
    };
    const outcome = await new OpenChamberAgent(seam, { cwd: '/tmp', model: 'm', agent: 'build', timeoutMs: 1234, maxOutputBytes: 100 }).execute(task('hi'));
    expect(seen).toMatchObject({ prompt: 'hi', cwd: '/tmp', model: 'm', agent: 'build', timeoutMs: 1234 });
    expect(outcome.ok).toBe(true);
    expect(outcome.resultRef).toContain('[truncated');
  });
});
