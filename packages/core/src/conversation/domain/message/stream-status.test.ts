// conversation/domain/message/stream-status.test.ts
// StreamStatus 生命周期迁移矩阵全量断言。

import { describe, it, expect } from 'vitest';
import { canTransition, type StreamStatus } from './stream-status.js';

const ALL: readonly StreamStatus[] = [
  'streaming',
  'completed',
  'interrupted',
  'error',
];

const TERMINAL: readonly StreamStatus[] = ['completed', 'interrupted', 'error'];

describe('canTransition', () => {
  // streaming → 三终态各合法
  it('streaming 可迁往任一终态（completed/interrupted/error）', () => {
    for (const to of TERMINAL) {
      expect(canTransition('streaming', to)).toBe(true);
    }
  });

  // streaming → streaming 幂等合法
  it('streaming → streaming 视为幂等，合法', () => {
    expect(canTransition('streaming', 'streaming')).toBe(true);
  });

  // 三终态 → 任何状态一律非法（含回退到 streaming、迁往其他终态、以及自身）
  it('任一终态迁往任何状态均非法（终态不可回退、不可改写）', () => {
    for (const from of TERMINAL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  // 全量矩阵：显式覆盖 4×4=16 种组合，逐一断言
  it('全量 4×4 迁移矩阵断言', () => {
    const expected: Record<StreamStatus, Record<StreamStatus, boolean>> = {
      streaming: {
        streaming: true,
        completed: true,
        interrupted: true,
        error: true,
      },
      completed: {
        streaming: false,
        completed: false,
        interrupted: false,
        error: false,
      },
      interrupted: {
        streaming: false,
        completed: false,
        interrupted: false,
        error: false,
      },
      error: {
        streaming: false,
        completed: false,
        interrupted: false,
        error: false,
      },
    };

    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(expected[from][to]);
      }
    }
  });
});
