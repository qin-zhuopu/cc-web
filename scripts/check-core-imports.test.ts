import { describe, it, expect } from 'vitest';
// @ts-expect-error - .mjs 零依赖脚本无类型声明，测试仅消费其导出的纯函数。
import { extractModuleSpecifiers, scanContent, isConversationFile } from './check-core-imports.mjs';

/** 断言 violations 中存在指定 rule 前缀且 detail 命中。 */
function hasRule(violations, rulePrefix) {
  return violations.some((v) => v.rule.startsWith(rulePrefix));
}

describe('extractModuleSpecifiers', () => {
  it('提取副作用 import 的说明符', () => {
    expect(extractModuleSpecifiers(`import '@nestjs/common';`)).toEqual(['@nestjs/common']);
  });

  it('提取 from 说明符', () => {
    expect(extractModuleSpecifiers(`import { X } from '@nestjs/core';`)).toEqual(['@nestjs/core']);
  });

  it('提取动态 import 与 require 说明符', () => {
    expect(extractModuleSpecifiers(`const a = import('better-sqlite3');`)).toEqual(['better-sqlite3']);
    expect(extractModuleSpecifiers(`const b = require('uuid');`)).toEqual(['uuid']);
  });

  it('无 import 的普通行返回空数组', () => {
    expect(extractModuleSpecifiers(`const x = 1;`)).toEqual([]);
  });
});

describe('scanContent — 禁用 import 模块规则', () => {
  it(`import '@nestjs/common' 命中 @nestjs/* 规则`, () => {
    expect(hasRule(scanContent(`import '@nestjs/common';`), '禁用 import: @nestjs/*')).toBe(true);
  });

  it(`from '@nestjs/core' 命中 @nestjs/* 规则`, () => {
    expect(hasRule(scanContent(`import { A } from '@nestjs/core';`), '禁用 import: @nestjs/*')).toBe(true);
  });

  it(`import('better-sqlite3') 命中 better-sqlite3 规则`, () => {
    expect(hasRule(scanContent(`const db = import('better-sqlite3');`), '禁用 import: better-sqlite3')).toBe(true);
  });

  it(`require('uuid') 命中 uuid 规则`, () => {
    expect(hasRule(scanContent(`const u = require('uuid');`), '禁用 import: uuid')).toBe(true);
  });

  it(`from '@anthropic-ai/sdk' 命中 @anthropic-ai/* 规则`, () => {
    expect(hasRule(scanContent(`import Anthropic from '@anthropic-ai/sdk';`), '禁用 import: @anthropic-ai/*')).toBe(true);
  });
});

describe('scanContent — 禁用运行时 API 规则', () => {
  it('Date.now( 命中 API 规则', () => {
    expect(hasRule(scanContent(`const t = Date.now();`), '禁用运行时 API: Date.now(')).toBe(true);
  });

  it('randomUUID 命中 API 规则', () => {
    expect(hasRule(scanContent(`const id = randomUUID();`), '禁用运行时 API: randomUUID')).toBe(true);
  });

  it('无参 new Date() 命中 API 规则', () => {
    expect(hasRule(scanContent(`const d = new Date();`), '禁用运行时 API: new Date()')).toBe(true);
    // 允许空白：new  Date ( ) 仍应命中
    expect(hasRule(scanContent(`const d = new  Date ( );`), '禁用运行时 API: new Date()')).toBe(true);
  });
});

describe('scanContent — 不误报', () => {
  it('干净的相对路径 import 0 命中', () => {
    expect(scanContent(`import { ErrorCode } from './error-code.js';`)).toHaveLength(0);
  });

  it(`非 uuid 包（如 'uuidx'）不误报为 uuid 规则`, () => {
    expect(hasRule(scanContent(`import x from 'uuidx';`), '禁用 import: uuid')).toBe(false);
    // 边界锁定：uuidx 不应产生任何 violation。
    expect(scanContent(`import x from 'uuidx';`)).toHaveLength(0);
  });

  it('行内 // 注释里提及 Date.now() / randomUUID 不误报', () => {
    expect(scanContent(`// 注意不要用 Date.now()`)).toHaveLength(0);
    expect(scanContent(`const x = 1; // 后续可换成 randomUUID`)).toHaveLength(0);
  });
});

describe('scanContent — 禁用 crypto import 规则', () => {
  it(`import 'crypto' 命中 crypto 规则`, () => {
    expect(hasRule(scanContent(`import { createHash } from 'crypto';`), '禁用 import: crypto')).toBe(true);
  });

  it(`import 'node:crypto' 命中 crypto 规则`, () => {
    expect(hasRule(scanContent(`import { randomUUID } from 'node:crypto';`), '禁用 import: crypto')).toBe(true);
  });

  it(`'crypto-js' 等他包不误报为 crypto 规则`, () => {
    expect(hasRule(scanContent(`import CryptoJS from 'crypto-js';`), '禁用 import: crypto')).toBe(false);
  });
});

describe('scanContent — C1 禁 phase 守卫（仅 conversation 子树）', () => {
  const asConv = { isConversation: true };

  it('conversation 样本含 StreamSession 被拦', () => {
    expect(
      hasRule(scanContent(`import type { StreamSession } from '../runtime.js';`, asConv), '禁用 phase 标识: StreamSession'),
    ).toBe(true);
  });

  it('conversation 样本含 .phase 成员访问被拦', () => {
    expect(hasRule(scanContent(`if (session.phase === 'active') {}`, asConv), '禁用 phase 标识: .phase')).toBe(true);
  });

  it(`conversation 样本含 'settling' / 'terminal' 相位字面量被拦`, () => {
    expect(hasRule(scanContent(`const p = 'settling';`, asConv), `禁用 phase 标识: 'settling'`)).toBe(true);
    expect(hasRule(scanContent(`const p = 'terminal';`, asConv), `禁用 phase 标识: 'terminal'`)).toBe(true);
  });

  it('干净 conversation 样本（ChatSession / SessionStatus）通过', () => {
    // 'active' 是 C1 SessionStatus 合法取值，绝不能被禁；ChatSession 非 StreamSession，不应误伤。
    const clean = [
      `export enum SessionStatus { ACTIVE = 'active', ARCHIVED = 'archived' }`,
      `export interface ChatSession { readonly status: SessionStatus; }`,
      `const withRuntimeStatus = { ...good, runtimeStatus: 'active' };`,
    ].join('\n');
    expect(scanContent(clean, asConv)).toHaveLength(0);
  });

  it('conversation 注释里提及相位词不误报', () => {
    expect(scanContent(`// 这属于 C2 的 StreamSession.phase，C1 不建模 settling/terminal`, asConv)).toHaveLength(0);
  });

  it('phaseName / multiphase 等无关标识不被 .phase 规则误伤', () => {
    expect(scanContent(`const phaseName = 'x'; const multiphase = true;`, asConv)).toHaveLength(0);
  });

  it('phase 规则对非 conversation 文件（SK / apps）0 生效', () => {
    // 默认 isConversation=false：即便文本含相位标识也不拦，确保 SK / apps 0 误伤。
    expect(scanContent(`const s: StreamSession = x; if (s.phase === 'settling') {}`)).toHaveLength(0);
  });
});

describe('isConversationFile', () => {
  it('命中 conversation 子树路径', () => {
    expect(isConversationFile('packages/core/src/conversation/domain/message/message.ts')).toBe(true);
  });

  it('SK 路径不命中', () => {
    expect(isConversationFile('packages/core/src/domain/error/error-code.ts')).toBe(false);
    expect(isConversationFile('apps/api/src/main.ts')).toBe(false);
  });
});
