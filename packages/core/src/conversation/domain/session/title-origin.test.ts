import { describe, it, expect } from 'vitest';
import { canOverrideTitle, type TitleOrigin } from './title-origin.js';

// AC-3：canOverrideTitle 的 3x3 全矩阵。
// 优先级 default < ai < user；incoming 优先级 >= current 才可覆盖。
// 逐组合列出期望结果（[current, incoming, expected]）。
const MATRIX: ReadonlyArray<readonly [TitleOrigin, TitleOrigin, boolean]> = [
  // current = default：可被任何来源覆盖。
  ['default', 'default', true],
  ['default', 'ai', true],
  ['default', 'user', true],
  // current = ai：可被 ai / user 覆盖，不被 default 覆盖。
  ['ai', 'default', false],
  ['ai', 'ai', true],
  ['ai', 'user', true],
  // current = user：仅可被 user 覆盖，严禁被 default / ai 覆盖。
  ['user', 'default', false],
  ['user', 'ai', false],
  ['user', 'user', true],
];

describe('canOverrideTitle 覆盖优先级谓词', () => {
  it.each(MATRIX)(
    'current=%s incoming=%s -> %s',
    (current, incoming, expected) => {
      expect(canOverrideTitle(current, incoming)).toBe(expected);
    },
  );

  it('全矩阵恰好 9 组组合（3x3）', () => {
    expect(MATRIX).toHaveLength(9);
  });
});
