// apps/api/src/conversation/conversation.module.spec.ts
// ConversationModule DI 装配 + 端到端往返测试（epic-c1-6）。
// 沿用 shared-kernel.module.spec.ts 的范式：NestFactory.createApplicationContext + reflect-metadata。
// DB 用 :memory:，各测试隔离、不落盘。
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import type {
  ManageSessionUseCase,
  AppendMessageUseCase,
  GetSessionHistoryUseCase,
  SetSessionTitleUseCase,
} from '@codepilot/core';
import { DatabaseModule } from '../database/database.module.js';
import { ConversationModule } from './conversation.module.js';
import {
  MANAGE_SESSION_USECASE,
  APPEND_MESSAGE_USECASE,
  GET_SESSION_HISTORY_USECASE,
  SET_SESSION_TITLE_USECASE,
  SESSION_REPOSITORY,
  MESSAGE_REPOSITORY,
} from './conversation.tokens.js';

// 测试根 Module：用内存 DB 装配 DatabaseModule + ConversationModule。
@Module({
  imports: [DatabaseModule.forRoot(':memory:'), ConversationModule],
})
class TestRootModule {}

// 下游消费 Module：只 import ConversationModule（模拟 C2/C5 依赖 C1 的方式）。
// 用于验证「导出面」：只有被 exports 的用例 token 对下游可见，仓储写端口 token 不可见。
@Module({
  imports: [ConversationModule],
})
class DownstreamModule {}

@Module({
  imports: [DatabaseModule.forRoot(':memory:'), DownstreamModule],
})
class DownstreamRootModule {}

describe('ConversationModule DI 装配', () => {
  let context: INestApplicationContext;

  beforeEach(async () => {
    context = await NestFactory.createApplicationContext(TestRootModule, {
      logger: false,
    });
  });

  afterEach(async () => {
    await context.close();
  });

  it('四个用例 token 均可解析出实现', () => {
    expect(context.get(MANAGE_SESSION_USECASE)).toBeDefined();
    expect(context.get(APPEND_MESSAGE_USECASE)).toBeDefined();
    expect(context.get(GET_SESSION_HISTORY_USECASE)).toBeDefined();
    expect(context.get(SET_SESSION_TITLE_USECASE)).toBeDefined();
  });

  it('会话创建 → 读回往返（真 SQLite）', async () => {
    const manage = context.get<ManageSessionUseCase>(MANAGE_SESSION_USECASE);
    const created = await manage.create({ title: '测试会话', workingDirectory: '/tmp/x' });
    expect(created.id).toBeTruthy();
    expect(created.title).toBe('测试会话');

    const fetched = await manage.getById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe('测试会话');
  });

  it('追加消息 → 历史读回（append 后 getHistory 含该消息）', async () => {
    const manage = context.get<ManageSessionUseCase>(MANAGE_SESSION_USECASE);
    const append = context.get<AppendMessageUseCase>(APPEND_MESSAGE_USECASE);
    const history = context.get<GetSessionHistoryUseCase>(GET_SESSION_HISTORY_USECASE);

    const session = await manage.create({ title: 'S' });
    const msg = await append.append({
      sessionId: session.id,
      role: 'user',
      content: { blocks: [{ type: 'text', text: '你好' }], toPlainText: () => '你好' },
    });
    expect(msg.id).toBeTruthy();

    const rows = await history.getHistory({ sessionId: session.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content.toPlainText()).toBe('你好');
  });

  it('删除会话级联删消息（delete 后消息为空）', async () => {
    const manage = context.get<ManageSessionUseCase>(MANAGE_SESSION_USECASE);
    const append = context.get<AppendMessageUseCase>(APPEND_MESSAGE_USECASE);
    const history = context.get<GetSessionHistoryUseCase>(GET_SESSION_HISTORY_USECASE);

    const session = await manage.create({ title: 'S' });
    await append.append({
      sessionId: session.id,
      role: 'user',
      content: { blocks: [{ type: 'text', text: 'x' }], toPlainText: () => 'x' },
    });
    await manage.delete(session.id);

    const rows = await history.getHistory({ sessionId: session.id });
    expect(rows).toHaveLength(0);
    expect(await manage.getById(session.id)).toBeUndefined();
  });

  it('消费方契约：下游只能拿到用例 token，拿不到仓储写端口（c1-6-4）', async () => {
    // 从下游 Module（只 import ConversationModule）的视角解析：
    // NestJS 里，一个 provider 只有被 exports 才对 import 方可见。
    // { strict: true } 让 get 限定在解析所在的 Module 上下文，未导出的 token 会抛。
    const downstream = await NestFactory.createApplicationContext(
      DownstreamRootModule,
      { logger: false },
    );
    try {
      // 用例 token 被 exports → 下游可解析。
      expect(downstream.get(MANAGE_SESSION_USECASE, { strict: false })).toBeDefined();
      expect(downstream.get(GET_SESSION_HISTORY_USECASE, { strict: false })).toBeDefined();
      // 仓储写端口未被 exports → 下游 DownstreamModule 上下文严格解析应抛。
      expect(() => downstream.get(SESSION_REPOSITORY, { strict: true })).toThrow();
      expect(() => downstream.get(MESSAGE_REPOSITORY, { strict: true })).toThrow();
    } finally {
      await downstream.close();
    }
  });
});
