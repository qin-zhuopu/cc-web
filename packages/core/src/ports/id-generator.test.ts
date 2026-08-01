// ports/id-generator.test.ts
// 用内联测试替身验证 IdGenerator 端口的语义契约（对齐 AC-9）。
// 测试替身 SequentialIdGenerator 仅存在于本文件内，返回确定性序列。
import { describe, it, expect } from 'vitest';
import type { IdGenerator } from './id-generator.js';

/**
 * 测试替身：确定性 ID 序列生成器。
 * next() 依次返回 'id-1','id-2','id-3',...，便于断言与预期序列一致。
 */
class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}

describe('IdGenerator 端口语义契约', () => {
  it('注入确定性序列后，连续 next() 结果与预期序列一致（AC-9）', () => {
    const generator: IdGenerator = new SequentialIdGenerator();

    const generated = [generator.next(), generator.next(), generator.next()];

    expect(generated).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('每次 next() 都返回全局唯一 ID（序列内不重复）', () => {
    const generator: IdGenerator = new SequentialIdGenerator();

    const ids = Array.from({ length: 100 }, () => generator.next());

    expect(new Set(ids).size).toBe(ids.length);
  });
});
