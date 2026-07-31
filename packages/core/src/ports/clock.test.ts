// ports/clock.test.ts
// 端口只定义接口无实现，故用内联测试替身验证 Clock 的语义契约：
//   - FrozenClock：now() 恒返回注入的固定值（对应 AC-8：冻结时钟两次取值相同）。
//   - MutableClock：演示可推进语义（时刻随外部推进而变化）。
// 这些替身仅存在于测试文件内，不进 src 生产代码。
import { describe, it, expect } from 'vitest';
import type { Clock } from './clock.js';

/** 冻结时钟：now() 恒返回构造时注入的固定时刻。 */
class FrozenClock implements Clock {
  constructor(private readonly fixed: number) {}
  now(): number {
    return this.fixed;
  }
}

/** 可推进时钟：now() 返回当前内部时刻，可通过 advance 推进。 */
class MutableClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  /** 将内部时刻推进指定毫秒数。 */
  advance(ms: number): void {
    this.current += ms;
  }
}

describe('Clock 端口语义契约 — FrozenClock', () => {
  it('AC-8：冻结时钟两次取值相同', () => {
    const clock: Clock = new FrozenClock(1_700_000_000_000);
    const first = clock.now();
    const second = clock.now();
    expect(first).toBe(second);
    expect(first).toBe(1_700_000_000_000);
  });

  it('多次连续取值始终等于注入的固定时刻', () => {
    const fixed = 42;
    const clock: Clock = new FrozenClock(fixed);
    for (let i = 0; i < 100; i++) {
      expect(clock.now()).toBe(fixed);
    }
  });
});

describe('Clock 端口语义契约 — MutableClock', () => {
  it('推进后 now() 反映新的时刻', () => {
    const clock = new MutableClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.advance(500);
    expect(clock.now()).toBe(2_000);
  });

  it('未推进时两次取值相同', () => {
    const clock = new MutableClock(7);
    expect(clock.now()).toBe(clock.now());
  });
});
