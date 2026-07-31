// conversation/ports/ports.test.ts
// C1 端口的类型层断言：构造符合各端口输入/契约的对象通过编译，
// 并对反假数据（可选字段留 undefined）与类型收敛做静态断言。
// 纯类型/编译期测试，不含用例运行逻辑（实现属 c1-3/4/5）。

import { describe, expect, it } from 'vitest';
import type {
  CreateSessionInput,
  ListSessionsQuery,
  ManageSessionUseCase,
} from './driving/manage-session-usecase.js';
import type { AppendMessageInput } from './driving/append-message-usecase.js';
import type { HistoryQuery } from './driving/get-session-history-usecase.js';
import type { SessionRepository } from './driven/session-repository.js';
import type { MessageRepository } from './driven/message-repository.js';
import type {
  TitleGenerationInput,
  TitleGeneratorPort,
} from './driven/title-generator-port.js';
import { SessionMode, SessionSource, SessionStatus } from '../domain/session/chat-session.js';
import type { MessageContent } from '../domain/message/message-content.js';

// MessageContent 在本波次为占位类型（unknown，编解码属 c1-2）。
// 端口类型层测试仅需一个占位内容值，用最小对象充当。
const stubContent: MessageContent = { blocks: [] };

describe('C1 驱动端口输入类型（对齐 architecture §4）', () => {
  it('CreateSessionInput 可全缺省，也可含合法字段', () => {
    const empty: CreateSessionInput = {};
    const full: CreateSessionInput = {
      title: 'New Chat',
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '/repo/demo',
      projectName: 'demo',
    };
    expect(empty).toBeDefined();
    expect(full.mode).toBe('code');
  });

  it('ListSessionsQuery 支持来源集合与状态过滤', () => {
    const q: ListSessionsQuery = {
      sources: [SessionSource.USER],
      status: SessionStatus.ACTIVE,
      limit: 20,
    };
    expect(q.sources?.[0]).toBe('user');
  });

  it('AppendMessageInput 可选字段无值时保持 undefined（反假数据 AC-10）', () => {
    const input: AppendMessageInput = {
      sessionId: 's-1',
      role: 'user',
      content: stubContent,
    };
    // 未提供的可选字段应为 undefined，绝不预填假 0 / 假空串。
    expect(input.tokenUsage).toBeUndefined();
    expect(input.taskRunId).toBeUndefined();
    expect(input.streamStatus).toBeUndefined();
    expect(input.isHeartbeatAck).toBeUndefined();
  });

  it('HistoryQuery 支持分页游标', () => {
    const q: HistoryQuery = { sessionId: 's-1', limit: 50, beforeRowId: 1000 };
    expect(q.beforeRowId).toBe(1000);
  });
});

describe('C1 端口契约可被结构化对象满足（编译期通过即达标）', () => {
  it('ManageSessionUseCase 方法集齐全', () => {
    // 仅编译期检查：方法名/签名一处不符即无法通过 tsc --build。
    const shape: Pick<ManageSessionUseCase, 'create' | 'list'> = {
      create: async (input: CreateSessionInput) => ({
        id: 's-1',
        title: input.title ?? 'New Chat',
        titleOrigin: 'default',
        status: SessionStatus.ACTIVE,
        mode: input.mode ?? SessionMode.CODE,
        source: input.source ?? SessionSource.USER,
        workingDirectory: input.workingDirectory ?? '/repo',
        projectName: input.projectName ?? 'demo',
        createdAt: 1,
        updatedAt: 1,
      }),
      list: async () => [],
    };
    expect(shape.create).toBeTypeOf('function');
  });

  it('出站端口可由内存假实现满足（Repository 契约）', () => {
    const sessionRepo: Pick<SessionRepository, 'getById' | 'touch'> = {
      getById: async () => undefined,
      touch: async (_id, updatedAt) => {
        // updatedAt 为 number（epoch 毫秒），与 ChatSession 对齐。
        expect(updatedAt).toBeTypeOf('number');
      },
    };
    const messageRepo: Pick<MessageRepository, 'deleteBySession'> = {
      deleteBySession: async () => 0,
    };
    expect(sessionRepo.getById).toBeTypeOf('function');
    expect(messageRepo.deleteBySession).toBeTypeOf('function');
  });

  it('TitleGeneratorPort 可由假实现满足（C1 只消费契约，不 import C2 实现）', () => {
    const input: TitleGenerationInput = {
      sessionId: 's-1',
      recentMessages: [{ role: 'user', text: '你好' }],
    };
    const fake: TitleGeneratorPort = {
      generateTitle: async (i) => `标题:${i.recentMessages.length}`,
    };
    expect(input.recentMessages).toHaveLength(1);
    expect(fake.generateTitle).toBeTypeOf('function');
  });
});
