// apps/api/src/shared-kernel/adapters/regex-redactor.ts
// Redactor 端口的最小占位适配器（供 DI 图装配，后续 epic 用完整规则集替换）。
//
// 本轮仅做最小占位脱敏：命中 sk- 前缀密钥与 Bearer token 两类，替换为占位符，
// 保留可读结构（FR-3.3）。纯函数、不修改原输入（AC-4/FR-3.1）。
// 完整规则集（邮箱 / 路径用户名段 / 各云厂商前缀等）留待后续 story。
import type { Redactor } from '@codepilot/core';

/** 脱敏占位符，保留结构可读性。 */
const PLACEHOLDER = '***REDACTED***';

/** 最小占位规则：sk- 密钥、Bearer token。 */
const RULES: ReadonlyArray<RegExp> = [
  /sk-[A-Za-z0-9]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

/** 生产 Redactor 的最小占位实现：字符串与结构化对象深度脱敏，返回新副本。 */
export class RegexRedactor implements Redactor {
  redactString(input: string): string {
    let output = input;
    for (const rule of RULES) {
      output = output.replace(rule, PLACEHOLDER);
    }
    return output;
  }

  redact<T>(input: T): T {
    return this.redactValue(input) as T;
  }

  /** 深度脱敏：字符串走规则、数组/对象递归、其余原样返回；不修改原输入。 */
  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = this.redactValue(item);
      }
      return result;
    }
    return value;
  }
}
