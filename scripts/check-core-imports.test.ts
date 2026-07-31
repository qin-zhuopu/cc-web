import { describe, it, expect } from 'vitest';
// @ts-expect-error - .mjs 零依赖脚本无类型声明，测试仅消费其导出的纯函数。
import { extractModuleSpecifiers, scanContent } from './check-core-imports.mjs';

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
