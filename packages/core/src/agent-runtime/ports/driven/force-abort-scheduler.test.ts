// agent-runtime/ports/driven/force-abort-scheduler.test.ts
// C2 · AgentRuntime —— ForceAbortScheduler 端口契约测试（c2-5-1）。
// 对齐 SPEC CAP-1、architecture §4.2（clock-based-timeout）、PRD FR-3.2 / AC-4。
//
// 用一个最小内联假 scheduler 实现 ForceAbortScheduler 契约，断言：
//   1. schedule 记录被安排的 callback / delayMs（AC-4：安排可 spy）。
//   2. 可手动 fire 触发回调（模拟延时到期，配合假 Clock，不依赖真实 setTimeout）。
//   3. cancel 后再 fire 不再触发（取消未到期安排）。
// 生产 setTimeout 实现属 c2-7，本测试只验端口契约；核心零框架不 import node:timers。

import { describe, expect, it, vi } from 'vitest';
import type { ForceAbortScheduler } from './force-abort-scheduler.js';
import { FORCE_ABORT_MS } from './force-abort-scheduler.js';

/**
 * makeManualScheduler —— 最小内联假 ForceAbortScheduler：手动触发（不依赖真实定时器）。
 * 记录每次 schedule 的 callback / delayMs，暴露 fire(index) 手动触发到期回调；
 * cancel 后该安排被标记取消，fire 对其 no-op（对齐生产 setTimeout + clearTimeout 语义）。
 */
function makeManualScheduler(): {
  scheduler: ForceAbortScheduler;
  scheduled: ReadonlyArray<{ readonly callback: () => void; readonly delayMs: number; cancelled: boolean }>;
  fire(index: number): void;
} {
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const scheduler: ForceAbortScheduler = {
    schedule(callback: () => void, delayMs: number): () => void {
      const entry = { callback, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return {
    scheduler,
    scheduled,
    fire(index: number): void {
      const entry = scheduled[index];
      if (entry && !entry.cancelled) entry.callback();
    },
  };
}

describe('ForceAbortScheduler 契约：schedule 记录安排（AC-4 安排可 spy）', () => {
  it('schedule 被调后记录 callback 与 delayMs', () => {
    const { scheduler, scheduled } = makeManualScheduler();
    const cb = () => {};
    scheduler.schedule(cb, FORCE_ABORT_MS);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.callback).toBe(cb);
    expect(scheduled[0]?.delayMs).toBe(FORCE_ABORT_MS);
  });

  it('schedule 返回一个 cancel 函数', () => {
    const { scheduler } = makeManualScheduler();
    const cancel = scheduler.schedule(() => {}, 1000);
    expect(typeof cancel).toBe('function');
  });
});

describe('ForceAbortScheduler 契约：手动 fire 触发到期回调（模拟延时到期）', () => {
  it('fire 后 callback 被触发', () => {
    const { scheduler, fire } = makeManualScheduler();
    const cb = vi.fn();
    scheduler.schedule(cb, FORCE_ABORT_MS);
    expect(cb).not.toHaveBeenCalled(); // 未到期不触发
    fire(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('ForceAbortScheduler 契约：cancel 后 fire 不再触发（取消未到期安排）', () => {
  it('cancel 后 fire 对该安排 no-op', () => {
    const { scheduler, fire } = makeManualScheduler();
    const cb = vi.fn();
    const cancel = scheduler.schedule(cb, FORCE_ABORT_MS);
    cancel();
    fire(0);
    expect(cb).not.toHaveBeenCalled();
  });

  it('多个安排：只 cancel 其一，另一仍可 fire', () => {
    const { scheduler, fire } = makeManualScheduler();
    const cb0 = vi.fn();
    const cb1 = vi.fn();
    const cancel0 = scheduler.schedule(cb0, 1000);
    scheduler.schedule(cb1, 2000);
    cancel0();
    fire(0);
    fire(1);
    expect(cb0).not.toHaveBeenCalled();
    expect(cb1).toHaveBeenCalledTimes(1);
  });
});

describe('FORCE_ABORT_MS 常量', () => {
  it('为正数毫秒值（缺省延时窗口，可由构造注入覆盖）', () => {
    expect(typeof FORCE_ABORT_MS).toBe('number');
    expect(FORCE_ABORT_MS).toBeGreaterThan(0);
  });
});
