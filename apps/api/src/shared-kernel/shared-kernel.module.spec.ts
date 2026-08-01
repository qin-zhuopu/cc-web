// apps/api/src/shared-kernel/shared-kernel.module.spec.ts
// 验证 SharedKernelModule 能装配，且 7 个端口 token 都能解析出实现实例；
// 并验证 ERROR_CLASSIFIER 解析出的实现可 classify（复用核心 defaultErrorClassifier）。
//
// NestJS + vitest 前置：顶部 import 'reflect-metadata'（装饰器元数据依赖它）；
// tsconfig 已开 experimentalDecorators/emitDecoratorMetadata。
// 无 @nestjs/testing，改用 @nestjs/core 的 NestFactory.createApplicationContext 编程式装配。
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type {
  Clock,
  ErrorClassifier,
  IdGenerator,
  Platform,
  Redactor,
  RuntimeLog,
} from '@codepilot/core';
import { SharedKernelModule } from './shared-kernel.module.js';
import {
  CLOCK,
  ERROR_CLASSIFIER,
  ID_GENERATOR,
  PLATFORM,
  REDACTOR,
  RUNTIME_LOG,
  TRANSLATION_PORT,
} from './sk-tokens.js';

describe('SharedKernelModule', () => {
  let context: INestApplicationContext;

  beforeEach(async () => {
    // 编程式装配整个模块 DI 图；logger 关闭以保持测试输出干净。
    context = await NestFactory.createApplicationContext(SharedKernelModule, {
      logger: false,
    });
  });

  afterEach(async () => {
    await context.close();
  });

  it('能装配并解析出全部 7 个端口 token 的实现实例', () => {
    // 逐一从容器解析，均应得到非空实例。
    expect(context.get(ERROR_CLASSIFIER)).toBeDefined();
    expect(context.get(CLOCK)).toBeDefined();
    expect(context.get(ID_GENERATOR)).toBeDefined();
    expect(context.get(PLATFORM)).toBeDefined();
    expect(context.get(REDACTOR)).toBeDefined();
    expect(context.get(RUNTIME_LOG)).toBeDefined();
    expect(context.get(TRANSLATION_PORT)).toBeDefined();
  });

  it('ERROR_CLASSIFIER 解析出的实现可 classify（复用核心 defaultErrorClassifier）', () => {
    const classifier = context.get<ErrorClassifier>(ERROR_CLASSIFIER);
    const result = classifier.classify(new Error('boom'));
    // 任意输入都应得到结构化结果，且永不抛出；此处只断言字段齐备。
    expect(result.code).toBeDefined();
    expect(result.messageKey).toBeDefined();
    expect(typeof result.retryable).toBe('boolean');
  });

  it('端口实现具备各自最小行为（冒烟）', () => {
    // Clock：返回数值时刻。
    expect(typeof context.get<Clock>(CLOCK).now()).toBe('number');
    // IdGenerator：返回非空字符串。
    expect(context.get<IdGenerator>(ID_GENERATOR).next().length).toBeGreaterThan(0);
    // Platform：runtime 恒为 'node'。
    expect(context.get<Platform>(PLATFORM).info().runtime).toBe('node');
    // Redactor：命中 sk- 密钥被替换。
    expect(context.get<Redactor>(REDACTOR).redactString('key sk-ABCDEFGH12345')).toContain(
      '***REDACTED***',
    );
    // RuntimeLog：append 后 snapshot 可见，且注入了 timestamp。
    const log = context.get<RuntimeLog>(RUNTIME_LOG);
    log.append({ level: 'info', source: 'test', message: 'hello' });
    const snap = log.snapshot();
    expect(snap).toHaveLength(1);
    expect(typeof snap[0]?.timestamp).toBe('number');
  });
});
