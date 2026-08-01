// ports/redactor.test.ts
// 端口只定义接口无实现，故用内联测试替身验证 Redactor 的语义契约：
//   - AC-3：含 API Key / Bearer token / 邮箱的输入经 redactString 后，原始敏感值不出现在输出。
//   - AC-4：redact 一个对象后返回新副本，原对象未被修改（引用不同、字段不变）。
//   - 脱敏输出中出现占位符 ***REDACTED***，保留可读结构。
// 测试替身仅存在于本测试文件内，不进 src 生产代码。
import { describe, it, expect } from 'vitest';
import type { Redactor } from './redactor.js';

const PLACEHOLDER = '***REDACTED***';

/**
 * 最小脱敏替身：把匹配 API Key（sk- 前缀）/ Bearer token / 邮箱的样式
 * 替换为占位符 ***REDACTED***。仅用于验证端口语义契约，非生产规则集。
 */
class FakeRedactor implements Redactor {
  private static readonly patterns: readonly RegExp[] = [
    /sk-[A-Za-z0-9_-]+/g, // API Key（sk- 前缀）
    /Bearer\s+[A-Za-z0-9._-]+/g, // Bearer token
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // 邮箱
  ];

  redactString(input: string): string {
    return FakeRedactor.patterns.reduce(
      (acc, pattern) => acc.replace(pattern, PLACEHOLDER),
      input,
    );
  }

  redact<T>(input: T): T {
    if (typeof input === 'string') {
      return this.redactString(input) as T;
    }
    if (Array.isArray(input)) {
      return input.map((item) => this.redact(item)) as T;
    }
    if (input !== null && typeof input === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        result[key] = this.redact(value);
      }
      return result as T;
    }
    return input;
  }
}

describe('Redactor 端口语义契约 — redactString', () => {
  it('AC-3：API Key 原始值不出现在脱敏输出中', () => {
    const redactor: Redactor = new FakeRedactor();
    const secret = 'sk-abc123DEF456ghi';
    const output = redactor.redactString(`使用密钥 ${secret} 调用接口`);
    expect(output).not.toContain(secret);
    expect(output).toContain(PLACEHOLDER);
  });

  it('AC-3：Bearer token 原始值不出现在脱敏输出中', () => {
    const redactor: Redactor = new FakeRedactor();
    const token = 'Bearer eyJhbGciOi.JIUzI1NiIs.InR5cCI6IkpXVCJ9';
    const output = redactor.redactString(`Authorization: ${token}`);
    expect(output).not.toContain(token);
    expect(output).toContain(PLACEHOLDER);
  });

  it('AC-3：邮箱原始值不出现在脱敏输出中', () => {
    const redactor: Redactor = new FakeRedactor();
    const email = 'alice@example.com';
    const output = redactor.redactString(`联系 ${email} 获取帮助`);
    expect(output).not.toContain(email);
    expect(output).toContain(PLACEHOLDER);
  });

  it('保留可读结构：非敏感文本原样保留', () => {
    const redactor: Redactor = new FakeRedactor();
    const output = redactor.redactString('前缀 sk-secret000 后缀');
    expect(output).toBe(`前缀 ${PLACEHOLDER} 后缀`);
  });
});

describe('Redactor 端口语义契约 — redact', () => {
  it('AC-4：返回新副本，原对象未被修改', () => {
    const redactor: Redactor = new FakeRedactor();
    const original = {
      apiKey: 'sk-topsecret123',
      email: 'bob@example.com',
      nested: { note: 'plain text' },
    };
    const snapshot = JSON.parse(JSON.stringify(original));

    const result = redactor.redact(original);

    // 返回对象为不同引用
    expect(result).not.toBe(original);
    expect(result.nested).not.toBe(original.nested);

    // 原对象字段保持不变
    expect(original).toEqual(snapshot);
    expect(original.apiKey).toBe('sk-topsecret123');
    expect(original.email).toBe('bob@example.com');

    // 返回副本已脱敏
    expect(result.apiKey).toBe(PLACEHOLDER);
    expect(result.email).toBe(PLACEHOLDER);
    expect(result.nested.note).toBe('plain text');
  });

  it('占位符 ***REDACTED*** 出现在脱敏后的对象字段中', () => {
    const redactor: Redactor = new FakeRedactor();
    const result = redactor.redact({ token: 'Bearer abc.def.ghi' });
    expect(result.token).toContain(PLACEHOLDER);
  });
});
