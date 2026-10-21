// StarStage 省电暂停（F-PERF-1）逻辑断言：
// setPaused(true) 必须取消 rAF 循环；恢复后续跑；意图（start/stop）与挂起正交。
// 运行环境为 node，注入最小 DOM/rAF 假件；CPU 实测数据另入性能报告（不做 flaky 断言）。

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { StarStage, crtGlitchLevel } from '../../packages/console/starfield.js';

function makeCtx(canvas) {
  return new Proxy(
    { canvas },
    {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        return () => undefined;
      },
      set: (target, prop, value) => {
        target[prop] = value;
        return true;
      },
    },
  );
}

function makeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    listeners: {},
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
    addEventListener(type, cb) { this.listeners[type] = cb; },
    removeEventListener(type) { delete this.listeners[type]; },
    parentElement: { querySelector: () => null },
  };
  canvas.getContext = () => makeCtx(canvas);
  return canvas;
}

function makeRaf() {
  const pending = new Map();
  let seq = 0;
  return {
    pending,
    request: (cb) => { seq += 1; pending.set(seq, cb); return seq; },
    cancel: (id) => { pending.delete(id); },
    count: () => pending.size,
    flush: (now) => {
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb(now);
    },
  };
}

describe('StarStage.setPaused（F-PERF-1 空闲省电）', () => {
  let raf;
  let stage;

  beforeEach(() => {
    raf = makeRaf();
    globalThis.requestAnimationFrame = raf.request;
    globalThis.cancelAnimationFrame = raf.cancel;
    globalThis.window = {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    stage = new StarStage(makeCanvas());
  });

  afterEach(() => {
    stage.destroy();
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
    delete globalThis.window;
  });

  test('start() 持有 rAF 循环；setPaused(true) 取消且不再排新帧', () => {
    stage.start();
    expect(stage.running).toBe(true);
    expect(raf.count()).toBe(1);

    stage.setPaused(true);
    expect(stage.running).toBe(false);
    expect(raf.count()).toBe(0);

    // 挂起中即使偶发回调也不应自我续排
    raf.flush(performance.now());
    expect(raf.count()).toBe(0);
  });

  test('setPaused(false) 在已 start 时自动续跑', () => {
    stage.start();
    stage.setPaused(true);
    stage.setPaused(false);
    expect(stage.running).toBe(true);
    expect(raf.count()).toBe(1);

    // 续排后帧循环自持
    raf.flush(performance.now());
    expect(raf.count()).toBe(1);
  });

  test('挂起期间 start() 只记录意图，不抢跑；恢复后才运行', () => {
    stage.setPaused(true);
    stage.start();
    expect(stage.running).toBe(false);
    expect(raf.count()).toBe(0);

    stage.setPaused(false);
    expect(stage.running).toBe(true);
    expect(raf.count()).toBe(1);
  });

  test('stop() 清除意图：恢复可见后不复活', () => {
    stage.start();
    stage.setPaused(true);
    stage.stop();
    stage.setPaused(false);
    expect(stage.running).toBe(false);
    expect(raf.count()).toBe(0);
  });

  test('幂等：重复 setPaused(true/false) 不产生多余 rAF', () => {
    stage.start();
    stage.setPaused(true);
    stage.setPaused(true);
    expect(raf.count()).toBe(0);
    stage.setPaused(false);
    stage.setPaused(false);
    expect(stage.running).toBe(true);
    expect(raf.count()).toBe(1);
  });

  test('恢复后清零 lastTickAt，避免长挂起首帧触发画质误降级', () => {
    stage.start();
    raf.flush(1000);
    stage.lastTickAt = 1000;
    stage.setPaused(true);
    stage.setPaused(false);
    expect(stage.lastTickAt).toBe(0);
    expect(stage.degradeStreak).toBe(0);
  });
});

describe('P6A 锁定态 CRT 地球仪：干扰毛刺节律（crtGlitchLevel）', () => {
  test('安静期无干扰；约每 4.2s 一次短促撕裂，随后归零', () => {
    expect(crtGlitchLevel(0)).toBe(0);
    expect(crtGlitchLevel(1)).toBe(0);
    expect(crtGlitchLevel(2.5)).toBe(0);
    expect(crtGlitchLevel(4.2)).toBe(1);
    expect(crtGlitchLevel(4.26)).toBeGreaterThan(0.5);
    expect(crtGlitchLevel(4.45)).toBe(0);
  });

  test('第二轮短闪独立存在，且不会持续抖动', () => {
    expect(crtGlitchLevel(5.15)).toBeGreaterThan(0.7);
    expect(crtGlitchLevel(5.25)).toBe(0);
    expect(crtGlitchLevel(8.4)).toBe(1);
    expect(crtGlitchLevel(8.7)).toBe(0);
  });
});
