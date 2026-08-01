// apps/api/src/agent-runtime/agent-runtime.module.spec.ts
// AgentRuntimeModule DI 装配 + C1↔C2 forwardRef 解环测试（epic-c2-7 / c2-7-4，对齐 SPEC CAP-3、architecture §8）。
//
// 沿用 conversation.module.spec.ts 的范式：NestFactory.createApplicationContext + reflect-metadata。
// DB 用 :memory:（ConversationModule 侧仓储需 DATABASE，经根 DatabaseModule.forRoot(':memory:') 装配）。
//
// 断言：
//   - C2 用例 token 均可解析：START_STREAM_USECASE / ABORT_STREAM_USECASE / TITLE_GENERATOR / AGENT_RUNTIME_PORT。
//   - C1↔C2 双向依赖经 forwardRef 解环：应用上下文能整体装配（无 Nest 循环依赖报错），
//     且 C1 的 SET_SESSION_TITLE_USECASE（消费 C2 的 TitleGenerator）可解析。
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import type {
  StartStreamUseCase,
  AbortStreamUseCase,
  TitleGenerator,
  AgentRuntimePort,
  SetSessionTitleUseCase,
} from '@codepilot/core';
import { DatabaseModule } from '../database/database.module.js';
import { AgentRuntimeModule } from './agent-runtime.module.js';
import { ConversationModule } from '../conversation/conversation.module.js';
import {
  START_STREAM_USECASE,
  ABORT_STREAM_USECASE,
  TITLE_GENERATOR,
  AGENT_RUNTIME_PORT,
} from './agent-runtime.tokens.js';
import { SET_SESSION_TITLE_USECASE } from '../conversation/conversation.tokens.js';

// 测试根 Module：内存 DB + C2（AgentRuntimeModule）+ C1（ConversationModule 经 C2 的 forwardRef 传递装配）。
@Module({
  imports: [DatabaseModule.forRoot(':memory:'), AgentRuntimeModule, ConversationModule],
})
class TestRootModule {}

describe('AgentRuntimeModule DI 装配 + C1↔C2 forwardRef 解环', () => {
  let context: INestApplicationContext;

  beforeEach(async () => {
    context = await NestFactory.createApplicationContext(TestRootModule, {
      logger: false,
    });
  });

  afterEach(async () => {
    await context.close();
  });

  it('C2 四个导出 token 均可解析出实现', () => {
    expect(context.get<StartStreamUseCase>(START_STREAM_USECASE)).toBeDefined();
    expect(context.get<AbortStreamUseCase>(ABORT_STREAM_USECASE)).toBeDefined();
    expect(context.get<TitleGenerator>(TITLE_GENERATOR)).toBeDefined();
    expect(context.get<AgentRuntimePort>(AGENT_RUNTIME_PORT)).toBeDefined();
  });

  it('START_STREAM_USECASE / ABORT_STREAM_USECASE 暴露正确的用例形状', () => {
    const start = context.get<StartStreamUseCase>(START_STREAM_USECASE);
    const abort = context.get<AbortStreamUseCase>(ABORT_STREAM_USECASE);
    expect(typeof start.start).toBe('function');
    expect(typeof abort.abort).toBe('function');
  });

  it('TITLE_GENERATOR 绑定 C2 GenerateTitleService（暴露 generateTitle）', () => {
    const titleGenerator = context.get<TitleGenerator>(TITLE_GENERATOR);
    expect(typeof titleGenerator.generateTitle).toBe('function');
  });

  it('C1↔C2 经 forwardRef 解环：C1 的 SetSessionTitle 用例（消费 C2 的 TitleGenerator）可解析', () => {
    // 应用上下文能整体装配（beforeEach 未抛循环依赖）已证明双向 forwardRef 解环；
    // 再断言 C1 侧消费 C2.TitleGenerator 的用例确实拿到了注入实现。
    const setTitle = context.get<SetSessionTitleUseCase>(SET_SESSION_TITLE_USECASE, {
      strict: false,
    });
    expect(setTitle).toBeDefined();
  });

  it('AGENT_RUNTIME_PORT 暴露 AgentRuntimePort 契约方法（供 C3 复用）', () => {
    const runtime = context.get<AgentRuntimePort>(AGENT_RUNTIME_PORT);
    expect(typeof runtime.run).toBe('function');
    expect(typeof runtime.interrupt).toBe('function');
    expect(typeof runtime.forceKillTurn).toBe('function');
    expect(typeof runtime.availability).toBe('function');
    expect(typeof runtime.resolvePermission).toBe('function');
  });
});
