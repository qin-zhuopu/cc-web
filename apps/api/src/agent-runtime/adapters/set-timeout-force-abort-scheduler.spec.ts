// apps/api/src/agent-runtime/adapters/set-timeout-force-abort-scheduler.spec.ts
// c2-7-3 · SetTimeoutForceAbortScheduler 的行为规格（vitest + vi.useFakeTimers）。
// 覆盖：到期触发 callback、cancel 后推进不触发、重复 cancel 不抛。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetTimeoutForceAbortScheduler } from './set-timeout-force-abort-scheduler.js';

describe('SetTimeoutForceAbortScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedule 后推进到到期时刻触发 callback', () => {
    const scheduler = new SetTimeoutForceAbortScheduler();
    const callback = vi.fn();

    scheduler.schedule(callback, 5000);

    // 未到期不触发
    vi.advanceTimersByTime(4999);
    expect(callback).not.toHaveBeenCalled();

    // 到期触发一次
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cancel 后再推进不触发 callback', () => {
    const scheduler = new SetTimeoutForceAbortScheduler();
    const callback = vi.fn();

    const cancel = scheduler.schedule(callback, 5000);
    cancel();

    vi.advanceTimersByTime(10000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('重复 cancel 不抛（幂等 no-op）', () => {
    const scheduler = new SetTimeoutForceAbortScheduler();
    const callback = vi.fn();

    const cancel = scheduler.schedule(callback, 5000);
    cancel();

    expect(() => cancel()).not.toThrow();
    expect(() => cancel()).not.toThrow();

    vi.advanceTimersByTime(10000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('已到期/已触发后再 cancel 为 no-op（不抛、不重复清理）', () => {
    const scheduler = new SetTimeoutForceAbortScheduler();
    const callback = vi.fn();

    const cancel = scheduler.schedule(callback, 5000);

    // 先到期触发
    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledTimes(1);

    // 触发后再 cancel：no-op，不抛、不影响已触发结果
    expect(() => cancel()).not.toThrow();
    vi.advanceTimersByTime(10000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
