// conversation/domain/message/message.test.ts
// Message 实体 + MessageRole + TokenUsage 投影的类型与不可变语义断言。

import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Message, MessageId, MessageRole } from './message.js';
import type { TokenUsage } from './token-usage.js';
import { textContent } from './message-content.js';
import type { StreamStatus } from './stream-status.js';

describe('MessageRole', () => {
  it('覆盖 user / assistant 两种角色字面量（对齐 architecture §3.3）', () => {
    const roles: readonly MessageRole[] = ['user', 'assistant'];
    expect(roles).toEqual(['user', 'assistant']);
    expectTypeOf<'user'>().toMatchTypeOf<MessageRole>();
    expectTypeOf<'assistant'>().toMatchTypeOf<MessageRole>();
  });
});

describe('Message 合法字面量', () => {
  it('可构造一条最小合法 assistant 消息（省略可选字段）', () => {
    const msg: Message = {
      id: 'msg-1',
      sessionId: 'sess-1',
      role: 'assistant',
      content: textContent('hi'), // MessageContent 已在 c1-2 落成富类型
      createdAt: 1_700_000_000_000,
      streamStatus: 'streaming',
      isHeartbeatAck: false,
    };

    expect(msg.id).toBe('msg-1');
    expect(msg.sessionId).toBe('sess-1');
    expect(msg.role).toBe('assistant');
    expect(msg.createdAt).toBe(1_700_000_000_000);
    expect(msg.streamStatus).toBe('streaming');
    expect(msg.isHeartbeatAck).toBe(false);
  });

  it('省略 tokenUsage / taskRunId 时二者恒为 undefined（不落假0/假空串，AC-10）', () => {
    const msg: Message = {
      id: 'msg-2',
      sessionId: 'sess-1',
      role: 'user',
      content: textContent('hi'),
      createdAt: 1_700_000_000_001,
      streamStatus: 'completed',
      isHeartbeatAck: false,
    };

    expect(msg.tokenUsage).toBeUndefined();
    expect(msg.taskRunId).toBeUndefined();
    // 显式确认没有以 0 / '' 冒充「未记录」
    expect(msg.tokenUsage).not.toBe(0);
    expect(msg.taskRunId).not.toBe('');
  });

  it('可携带完整 tokenUsage 与 taskRunId', () => {
    const msg: Message = {
      id: 'msg-3',
      sessionId: 'sess-1',
      role: 'assistant',
      content: textContent('hi'),
      createdAt: 1_700_000_000_002,
      streamStatus: 'completed',
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 34,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 6,
      },
      isHeartbeatAck: true,
      taskRunId: 'run-abc',
    };

    expect(msg.tokenUsage?.inputTokens).toBe(12);
    expect(msg.tokenUsage?.outputTokens).toBe(34);
    expect(msg.isHeartbeatAck).toBe(true);
    expect(msg.taskRunId).toBe('run-abc');
  });
});

describe('类型引用正确性', () => {
  it('MessageId 为 string 别名', () => {
    expectTypeOf<MessageId>().toEqualTypeOf<string>();
  });

  it('Message.streamStatus 引用 StreamStatus 类型', () => {
    expectTypeOf<Message['streamStatus']>().toEqualTypeOf<StreamStatus>();
  });

  it('Message.createdAt 为 number（epoch 毫秒，来自 SK.Clock）', () => {
    expectTypeOf<Message['createdAt']>().toEqualTypeOf<number>();
  });

  it('Message.tokenUsage 为可选 TokenUsage', () => {
    expectTypeOf<Message['tokenUsage']>().toEqualTypeOf<TokenUsage | undefined>();
  });
});

describe('TokenUsage 投影（只存不算，AC-10）', () => {
  it('全部字段可选，空对象合法且各字段为 undefined', () => {
    const usage: TokenUsage = {};
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
    expect(usage.cacheCreationInputTokens).toBeUndefined();
    expect(usage.cacheReadInputTokens).toBeUndefined();
  });

  it('可只记录部分字段，未记录项保持 undefined（不补假0）', () => {
    const usage: TokenUsage = { inputTokens: 100 };
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBeUndefined();
    expect(usage.outputTokens).not.toBe(0);
  });
});
