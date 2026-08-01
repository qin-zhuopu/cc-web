// conversation/usecases/append-message.test.ts
// AppendMessageService.append 的单元测试（vitest）。
// 全用内存假替身 + 冻结时钟 + 序列 id 生成器，断言：
//   - 用注入的 IdGenerator/Clock（AC-7）；
//   - message.createdAt === 会话被 touch 的 updatedAt（同一 now，AC-7 / NFR-7）；
//   - 消息进了 repo；
//   - tokenUsage 无值时 undefined、有值时原样保留（AC-10 反假数据）。

import { describe, it, expect, beforeEach } from 'vitest';
import { AppendMessageService } from './append-message.js';
import type { SessionRepository } from '../ports/driven/session-repository.js';
import type { MessageRepository } from '../ports/driven/message-repository.js';
import type {
  ChatSession,
  SessionId,
  SessionStatus as SessionStatusType,
} from '../domain/session/chat-session.js';
import {
  SessionMode,
  SessionSource,
  SessionStatus,
} from '../domain/session/chat-session.js';
import type { TitleOrigin } from '../domain/session/title-origin.js';
import type { Message, MessageId } from '../domain/message/message.js';
import type { StreamStatus } from '../domain/message/stream-status.js';
import type { TokenUsage } from '../domain/message/token-usage.js';
import type { HistoryQuery } from '../ports/driving/get-session-history-usecase.js';
import { textContent } from '../domain/message/message-content.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';

// —— 假替身 ——

/** 内存会话仓储：Map 存储，touch 只改 updatedAt。 */
class FakeSessionRepository implements SessionRepository {
  readonly store = new Map<SessionId, ChatSession>();
  touchCalls: Array<{ id: SessionId; updatedAt: number }> = [];

  async listAll(): Promise<ReadonlyArray<ChatSession>> {
    return [...this.store.values()];
  }
  async getById(id: SessionId): Promise<ChatSession | undefined> {
    return this.store.get(id);
  }
  async save(session: ChatSession): Promise<void> {
    this.store.set(session.id, session);
  }
  async touch(id: SessionId, updatedAt: number): Promise<void> {
    this.touchCalls.push({ id, updatedAt });
    const cur = this.store.get(id);
    if (cur) this.store.set(id, { ...cur, updatedAt });
  }
  async setTitle(
    id: SessionId,
    title: string,
    origin: TitleOrigin,
  ): Promise<void> {
    const cur = this.store.get(id);
    if (cur) this.store.set(id, { ...cur, title, titleOrigin: origin });
  }
  async setStatus(id: SessionId, status: SessionStatusType): Promise<void> {
    const cur = this.store.get(id);
    if (cur) this.store.set(id, { ...cur, status });
  }
  async delete(id: SessionId): Promise<void> {
    this.store.delete(id);
  }
}

/** 内存消息仓储：Map<SessionId, Message[]>。 */
class FakeMessageRepository implements MessageRepository {
  readonly store = new Map<SessionId, Message[]>();
  /** 记录 updateStreamStatus 调用，便于断言「非法推进不写库」。 */
  updateCalls: Array<{
    id: MessageId;
    status: StreamStatus;
    tokenUsage?: TokenUsage;
  }> = [];

  async listBySession(query: HistoryQuery): Promise<ReadonlyArray<Message>> {
    return this.store.get(query.sessionId) ?? [];
  }
  async getById(id: MessageId): Promise<Message | undefined> {
    for (const list of this.store.values()) {
      const found = list.find((m) => m.id === id);
      if (found) return found;
    }
    return undefined;
  }
  async append(message: Message): Promise<void> {
    const list = this.store.get(message.sessionId) ?? [];
    list.push(message);
    this.store.set(message.sessionId, list);
  }
  async updateStreamStatus(
    id: MessageId,
    status: StreamStatus,
    tokenUsage?: TokenUsage,
  ): Promise<void> {
    this.updateCalls.push({ id, status, tokenUsage });
    // 落地新状态，便于按 id 读回后续断言。
    for (const [sessionId, list] of this.store.entries()) {
      const idx = list.findIndex((m) => m.id === id);
      const cur = idx >= 0 ? list[idx] : undefined;
      if (cur) {
        list[idx] = {
          ...cur,
          streamStatus: status,
          ...(tokenUsage !== undefined ? { tokenUsage } : {}),
        };
        this.store.set(sessionId, list);
        return;
      }
    }
  }
  async deleteBySession(sessionId: SessionId): Promise<number> {
    const n = this.store.get(sessionId)?.length ?? 0;
    this.store.delete(sessionId);
    return n;
  }
}

/** 冻结时钟：now 恒返回注入的固定时刻。 */
class FrozenClock implements Clock {
  constructor(private readonly fixed: number) {}
  now(): number {
    return this.fixed;
  }
}

/** 序列 id 生成器：依次返回 'id-1'、'id-2'……，便于确定性断言。 */
class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
}

// —— 测试 ——

describe('AppendMessageService.append', () => {
  let sessions: FakeSessionRepository;
  let messages: FakeMessageRepository;
  let clock: FrozenClock;
  let ids: SequentialIdGenerator;
  let service: AppendMessageService;
  const NOW = 1_700_000_000_000;
  const SESSION_ID = 's1';

  // 预置一条会话，updatedAt 取远小于 NOW 的旧值，便于断言 touch 抬升到 NOW。
  function seedSession(): void {
    sessions.store.set(SESSION_ID, {
      id: SESSION_ID,
      title: '会话',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '/repo/app',
      projectName: 'app',
      createdAt: 1,
      updatedAt: 1,
    });
  }

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    messages = new FakeMessageRepository();
    clock = new FrozenClock(NOW);
    ids = new SequentialIdGenerator();
    service = new AppendMessageService(messages, sessions, clock, ids);
    seedSession();
  });

  it('用注入的 IdGenerator 生成 id、Clock 作 createdAt', async () => {
    const m = await service.append({
      sessionId: SESSION_ID,
      role: 'user',
      content: textContent('你好'),
    });
    expect(m.id).toBe('id-1');
    expect(m.createdAt).toBe(NOW);
  });

  it('AC-7：message.createdAt === 会话被 touch 的 updatedAt（同一 now）', async () => {
    const m = await service.append({
      sessionId: SESSION_ID,
      role: 'user',
      content: textContent('你好'),
    });
    // touch 用的正是同一 now。
    expect(sessions.touchCalls).toEqual([{ id: SESSION_ID, updatedAt: NOW }]);
    // 会话 updatedAt 被抬升到 createdAt 一致的值。
    const after = sessions.store.get(SESSION_ID)!;
    expect(after.updatedAt).toBe(m.createdAt);
    expect(after.updatedAt).toBe(NOW);
  });

  it('消息进了 MessageRepository（可经 listBySession 取回）', async () => {
    const m = await service.append({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: textContent('回复'),
    });
    const list = await messages.listBySession({ sessionId: SESSION_ID });
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(m);
  });

  it('AC-10：tokenUsage 无值时字段为 undefined（不落假 0）', async () => {
    const m = await service.append({
      sessionId: SESSION_ID,
      role: 'user',
      content: textContent('你好'),
    });
    expect(m.tokenUsage).toBeUndefined();
    expect('tokenUsage' in m).toBe(false);
  });

  it('tokenUsage 有值时原样保留（只存不算）', async () => {
    const usage: TokenUsage = { inputTokens: 12, outputTokens: 34 };
    const m = await service.append({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: textContent('回复'),
      tokenUsage: usage,
    });
    expect(m.tokenUsage).toEqual(usage);
  });

  it('AC-10：tokenUsage 完整字段往返原样保留（不派生、不改写）', async () => {
    const usage: TokenUsage = {
      inputTokens: 12,
      outputTokens: 34,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 7,
    };
    const m = await service.append({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: textContent('回复'),
      tokenUsage: usage,
    });
    // 逐字段一致，且经 listBySession 取回仍完全相同（无求和/补 total）。
    expect(m.tokenUsage).toEqual(usage);
    const [stored] = await messages.listBySession({ sessionId: SESSION_ID });
    expect(stored?.tokenUsage).toEqual(usage);
    // 未派生任何汇总字段（如 totalTokens），投影键集与输入严格一致。
    expect(Object.keys(m.tokenUsage!).sort()).toEqual(
      ['cacheCreationInputTokens', 'cacheReadInputTokens', 'inputTokens', 'outputTokens'],
    );
  });

  it('AC-10：部分 tokenUsage（仅 inputTokens）→ 其余字段 undefined 不补 0', async () => {
    const partial: TokenUsage = { inputTokens: 5 };
    const m = await service.append({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: textContent('回复'),
      tokenUsage: partial,
    });
    // 传入项原样保留。
    expect(m.tokenUsage?.inputTokens).toBe(5);
    // 未传入项一律 undefined（未记录），绝不补 0。
    expect(m.tokenUsage?.outputTokens).toBeUndefined();
    expect(m.tokenUsage?.cacheCreationInputTokens).toBeUndefined();
    expect(m.tokenUsage?.cacheReadInputTokens).toBeUndefined();
    // 缺省项以「键缺席」而非「0 值」体现（0 与未记录语义不同）。
    expect('outputTokens' in m.tokenUsage!).toBe(false);
    expect(Object.keys(m.tokenUsage!)).toEqual(['inputTokens']);
    // 往返一致：取回后仍是同一部分投影，未被补齐。
    const [stored] = await messages.listBySession({ sessionId: SESSION_ID });
    expect(stored?.tokenUsage).toEqual(partial);
  });

  it('isHeartbeatAck 缺省 false、显式传值时采用', async () => {
    const a = await service.append({
      sessionId: SESSION_ID,
      role: 'user',
      content: textContent('a'),
    });
    expect(a.isHeartbeatAck).toBe(false);

    const b = await service.append({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: textContent('b'),
      isHeartbeatAck: true,
    });
    expect(b.isHeartbeatAck).toBe(true);
  });

  it('taskRunId 无值时字段缺席、有值时保留', async () => {
    const a = await service.append({
      sessionId: SESSION_ID,
      role: 'user',
      content: textContent('a'),
    });
    expect('taskRunId' in a).toBe(false);

    const b = await service.append({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: textContent('b'),
      taskRunId: 'task-9',
    });
    expect(b.taskRunId).toBe('task-9');
  });

  it('streamStatus 缺省 completed、显式 streaming 时采用', async () => {
    const a = await service.append({
      sessionId: SESSION_ID,
      role: 'user',
      content: textContent('a'),
    });
    expect(a.streamStatus).toBe('completed');

    const b = await service.append({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: textContent('b'),
      streamStatus: 'streaming',
    });
    expect(b.streamStatus).toBe('streaming');
  });

  it('不变式（§3.3）：非 assistant 消息传非 completed 的 streamStatus 被拒绝', async () => {
    // user + streaming 是非法组合：只有 assistant 才有流式生命周期。
    await expect(
      service.append({
        sessionId: SESSION_ID,
        role: 'user',
        content: textContent('x'),
        streamStatus: 'streaming',
      }),
    ).rejects.toThrow();
    // 拒绝后不应有消息落库。
    const stored = messages.store.get(SESSION_ID) ?? [];
    expect(stored).toHaveLength(0);
  });

  it('id 随每次追加递增（用序列生成器）', async () => {
    const a = await service.append({
      sessionId: SESSION_ID,
      role: 'user',
      content: textContent('a'),
    });
    const b = await service.append({
      sessionId: SESSION_ID,
      role: 'user',
      content: textContent('b'),
    });
    expect(a.id).toBe('id-1');
    expect(b.id).toBe('id-2');
  });
});

describe('AppendMessageService.updateStreamStatus（经 canTransition 守卫）', () => {
  let sessions: FakeSessionRepository;
  let messages: FakeMessageRepository;
  let clock: FrozenClock;
  let ids: SequentialIdGenerator;
  let service: AppendMessageService;
  const NOW = 1_700_000_000_000;
  const SESSION_ID = 's1';

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    messages = new FakeMessageRepository();
    clock = new FrozenClock(NOW);
    ids = new SequentialIdGenerator();
    service = new AppendMessageService(messages, sessions, clock, ids);
    sessions.store.set(SESSION_ID, {
      id: SESSION_ID,
      title: '会话',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '/repo/app',
      projectName: 'app',
      createdAt: 1,
      updatedAt: 1,
    });
  });

  /** 追加一条 streaming 的 assistant 消息，返回其 id。 */
  async function seedStreamingMessage(): Promise<MessageId> {
    const m = await service.append({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: textContent('流式中'),
      streamStatus: 'streaming',
    });
    return m.id;
  }

  it('AC-8：streaming → completed 合法推进，委托 repo 落库', async () => {
    const id = await seedStreamingMessage();
    await service.updateStreamStatus(id, 'completed');
    expect(messages.updateCalls).toEqual([
      { id, status: 'completed', tokenUsage: undefined },
    ]);
    const after = await messages.getById(id);
    expect(after?.streamStatus).toBe('completed');
  });

  it('AC-8：streaming → interrupted 合法推进', async () => {
    const id = await seedStreamingMessage();
    await service.updateStreamStatus(id, 'interrupted');
    expect(messages.updateCalls).toHaveLength(1);
    expect(messages.updateCalls[0]).toMatchObject({ id, status: 'interrupted' });
  });

  it('AC-8：streaming → error 合法推进', async () => {
    const id = await seedStreamingMessage();
    await service.updateStreamStatus(id, 'error');
    expect(messages.updateCalls).toHaveLength(1);
    expect(messages.updateCalls[0]).toMatchObject({ id, status: 'error' });
  });

  it('收尾可选透传 tokenUsage（只存不算，无值不落）', async () => {
    const id = await seedStreamingMessage();
    const usage: TokenUsage = { inputTokens: 12, outputTokens: 34 };
    await service.updateStreamStatus(id, 'completed', usage);
    expect(messages.updateCalls[0]?.tokenUsage).toEqual(usage);
    const after = await messages.getById(id);
    expect(after?.tokenUsage).toEqual(usage);
  });

  it('AC-8：终态 completed → streaming 回退被拒绝，且不写库', async () => {
    const id = await seedStreamingMessage();
    // 先合法推进到终态 completed。
    await service.updateStreamStatus(id, 'completed');
    messages.updateCalls = []; // 清空，仅观察后续非法推进是否写库。

    await expect(service.updateStreamStatus(id, 'streaming')).rejects.toThrow();
    // 非法推进：repo.updateStreamStatus 未被调用（canTransition=false）。
    expect(messages.updateCalls).toEqual([]);
    // 状态保持终态，未被回退。
    const after = await messages.getById(id);
    expect(after?.streamStatus).toBe('completed');
  });

  it('AC-8：终态 completed → error 亦被拒绝（终态不可再改写），不写库', async () => {
    const id = await seedStreamingMessage();
    await service.updateStreamStatus(id, 'completed');
    messages.updateCalls = [];

    await expect(service.updateStreamStatus(id, 'error')).rejects.toThrow();
    expect(messages.updateCalls).toEqual([]);
  });

  it('消息不存在时抛错且不写库', async () => {
    await expect(
      service.updateStreamStatus('no-such-id', 'completed'),
    ).rejects.toThrow();
    expect(messages.updateCalls).toEqual([]);
  });
});
