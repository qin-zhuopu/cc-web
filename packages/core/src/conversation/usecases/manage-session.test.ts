// conversation/usecases/manage-session.test.ts
// C1 会话生命周期用例服务 create / getById 的单元测试（vitest）。
// 全用内存假替身 + 冻结时钟 + 序列 id 生成器，断言编排走注入端口、缺省语义、反假数据（AC-10）。

import { describe, it, expect, beforeEach } from 'vitest';
import { ManageSessionService } from './manage-session.js';
import type {
  ChatSession,
  SessionId,
} from '../domain/session/chat-session.js';
import {
  SessionMode,
  SessionSource,
  SessionStatus,
} from '../domain/session/chat-session.js';
import type { SessionStatus as SessionStatusType } from '../domain/session/chat-session.js';
import type { TitleOrigin } from '../domain/session/title-origin.js';
import { C1_MESSAGE_KEYS } from '../domain/message-keys.js';
import type { SessionRepository } from '../ports/driven/session-repository.js';
import type { MessageRepository } from '../ports/driven/message-repository.js';
import type { Message } from '../domain/message/message.js';
import type { HistoryQuery } from '../ports/driving/get-session-history-usecase.js';
import type { MessageId } from '../domain/message/message.js';
import type { StreamStatus } from '../domain/message/stream-status.js';
import type { TokenUsage } from '../domain/message/token-usage.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';

// —— 假替身 ——

/** 内存会话仓储：Map 存储，记录 save 调用次数供断言。 */
class FakeSessionRepository implements SessionRepository {
  readonly store = new Map<SessionId, ChatSession>();
  saveCalls = 0;

  async listAll(): Promise<ReadonlyArray<ChatSession>> {
    return [...this.store.values()];
  }
  async getById(id: SessionId): Promise<ChatSession | undefined> {
    return this.store.get(id);
  }
  async save(session: ChatSession): Promise<void> {
    this.saveCalls += 1;
    this.store.set(session.id, session);
  }
  async touch(id: SessionId, updatedAt: number): Promise<void> {
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

/** 内存消息仓储：Map<SessionId, Message[]>，本故事仅需满足契约。 */
class FakeMessageRepository implements MessageRepository {
  readonly store = new Map<SessionId, Message[]>();

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
    _id: MessageId,
    _status: StreamStatus,
    _tokenUsage?: TokenUsage,
  ): Promise<void> {
    // 本故事无需实现细节。
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

/** 可推进时钟：now 返回当前值，set 可改时刻，供 touch 前后取不同时间戳。 */
class MutableClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  set(next: number): void {
    this.current = next;
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

describe('ManageSessionService.create', () => {
  let sessions: FakeSessionRepository;
  let messages: FakeMessageRepository;
  let clock: FrozenClock;
  let ids: SequentialIdGenerator;
  let service: ManageSessionService;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    messages = new FakeMessageRepository();
    clock = new FrozenClock(NOW);
    ids = new SequentialIdGenerator();
    service = new ManageSessionService(sessions, messages, clock, ids);
  });

  it('用注入的 IdGenerator 生成 id、Clock 作 createdAt=updatedAt', async () => {
    const s = await service.create({});
    expect(s.id).toBe('id-1');
    expect(s.createdAt).toBe(NOW);
    expect(s.updatedAt).toBe(NOW);
  });

  it('缺 title 时走默认标题 key + titleOrigin=default', async () => {
    const s = await service.create({});
    expect(s.title).toBe(C1_MESSAGE_KEYS.sessionDefaultTitle);
    expect(s.titleOrigin).toBe('default');
  });

  it('显式给 title 时采用给定文案（origin 非 default）', async () => {
    const s = await service.create({ title: '我的会话' });
    expect(s.title).toBe('我的会话');
    expect(s.titleOrigin).not.toBe('default');
  });

  it('缺省 mode=code、source=user、status=active', async () => {
    const s = await service.create({});
    expect(s.mode).toBe(SessionMode.CODE);
    expect(s.source).toBe(SessionSource.USER);
    expect(s.status).toBe(SessionStatus.ACTIVE);
  });

  it('mode/source/workingDirectory/projectName 取自 input', async () => {
    const s = await service.create({
      mode: SessionMode.PLAN,
      source: SessionSource.TASK,
      workingDirectory: '/repo/app',
      projectName: 'app',
    });
    expect(s.mode).toBe(SessionMode.PLAN);
    expect(s.source).toBe(SessionSource.TASK);
    expect(s.workingDirectory).toBe('/repo/app');
    expect(s.projectName).toBe('app');
  });

  it('调用 SessionRepository.save 并可经 getById 取回', async () => {
    const s = await service.create({});
    expect(sessions.saveCalls).toBe(1);
    const got = await service.getById(s.id);
    expect(got).toEqual(s);
  });

  it('id 随每次创建递增（用序列生成器）', async () => {
    const a = await service.create({});
    const b = await service.create({});
    expect(a.id).toBe('id-1');
    expect(b.id).toBe('id-2');
  });

  it('AC-10 反假数据：无值可选字段不预填假数据（保持契约默认，不出现 undefined 字段）', async () => {
    // 会话本体 10 字段非可选，缺省由用例落真实默认；断言无残留 undefined 值。
    const s = await service.create({});
    for (const [key, value] of Object.entries(s)) {
      expect(value, `字段 ${key} 不应为 undefined`).not.toBeUndefined();
    }
  });
});

describe('ManageSessionService.list', () => {
  let sessions: FakeSessionRepository;
  let messages: FakeMessageRepository;
  let clock: FrozenClock;
  let ids: SequentialIdGenerator;
  let service: ManageSessionService;

  // 直接向假仓储预置数据，绕开 create 的时钟约束，精确控制 updatedAt/source/status。
  function seed(session: Partial<ChatSession> & Pick<ChatSession, 'id'>): void {
    const full: ChatSession = {
      title: '会话',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '',
      projectName: '',
      createdAt: 0,
      updatedAt: 0,
      ...session,
    };
    sessions.store.set(full.id, full);
  }

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    messages = new FakeMessageRepository();
    clock = new FrozenClock(1);
    ids = new SequentialIdGenerator();
    service = new ManageSessionService(sessions, messages, clock, ids);
  });

  it('结果按 updatedAt 倒序（最近更新置顶）', async () => {
    seed({ id: 'a', updatedAt: 100 });
    seed({ id: 'b', updatedAt: 300 });
    seed({ id: 'c', updatedAt: 200 });
    const list = await service.list();
    expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('默认过滤掉 source=task 的会话（FR-1.6）', async () => {
    seed({ id: 'u1', source: SessionSource.USER, updatedAt: 10 });
    seed({ id: 't1', source: SessionSource.TASK, updatedAt: 20 });
    seed({ id: 'u2', source: SessionSource.USER, updatedAt: 30 });
    const list = await service.list();
    expect(list.map((s) => s.id)).toEqual(['u2', 'u1']);
    expect(list.some((s) => s.source === SessionSource.TASK)).toBe(false);
  });

  it('query.sources 显式含 task 时才返回 task 源会话', async () => {
    seed({ id: 'u1', source: SessionSource.USER, updatedAt: 10 });
    seed({ id: 't1', source: SessionSource.TASK, updatedAt: 20 });
    const list = await service.list({
      sources: [SessionSource.USER, SessionSource.TASK],
    });
    expect(list.map((s) => s.id)).toEqual(['t1', 'u1']);
  });

  it('query.sources 仅指定 task 时只返回 task 源', async () => {
    seed({ id: 'u1', source: SessionSource.USER, updatedAt: 10 });
    seed({ id: 't1', source: SessionSource.TASK, updatedAt: 20 });
    const list = await service.list({ sources: [SessionSource.TASK] });
    expect(list.map((s) => s.id)).toEqual(['t1']);
  });

  it('query.status 过滤指定状态', async () => {
    seed({ id: 'a', status: SessionStatus.ACTIVE, updatedAt: 10 });
    seed({ id: 'b', status: SessionStatus.ARCHIVED, updatedAt: 20 });
    const list = await service.list({ status: SessionStatus.ARCHIVED });
    expect(list.map((s) => s.id)).toEqual(['b']);
  });

  it('query.limit 截取排序后的前 N 条', async () => {
    seed({ id: 'a', updatedAt: 100 });
    seed({ id: 'b', updatedAt: 300 });
    seed({ id: 'c', updatedAt: 200 });
    const list = await service.list({ limit: 2 });
    expect(list.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('空仓储返回空数组', async () => {
    const list = await service.list();
    expect(list).toEqual([]);
  });
});

describe('ManageSessionService.getById', () => {
  it('不存在的 id 返回 undefined（不抛）', async () => {
    const service = new ManageSessionService(
      new FakeSessionRepository(),
      new FakeMessageRepository(),
      new FrozenClock(1),
      new SequentialIdGenerator(),
    );
    await expect(service.getById('missing')).resolves.toBeUndefined();
  });
});

describe('ManageSessionService.archive / unarchive', () => {
  let sessions: FakeSessionRepository;
  let messages: FakeMessageRepository;
  let service: ManageSessionService;
  const NOW = 1_700_000_000_000;

  // 预置一条会话，updatedAt 取远小于 NOW 的旧值，便于断言 touch 抬升到 NOW。
  function seedSession(over: Partial<ChatSession> & Pick<ChatSession, 'id'>): void {
    const full: ChatSession = {
      title: '会话',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '',
      projectName: '',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    };
    sessions.store.set(full.id, full);
  }

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    messages = new FakeMessageRepository();
    service = new ManageSessionService(
      sessions,
      messages,
      new FrozenClock(NOW),
      new SequentialIdGenerator(),
    );
  });

  it('archive：仅 status→archived，不 touch updatedAt（归档非活动，不顶前）', async () => {
    seedSession({ id: 's1', status: SessionStatus.ACTIVE, updatedAt: 1 });
    await service.archive('s1');
    const s = sessions.store.get('s1')!;
    expect(s.status).toBe(SessionStatus.ARCHIVED);
    // 规格：archive 只改状态，updatedAt 保持原值（不因归档抬升）。
    expect(s.updatedAt).toBe(1);
  });

  it('unarchive：仅 status→active，不 touch updatedAt', async () => {
    seedSession({ id: 's1', status: SessionStatus.ARCHIVED, updatedAt: 1 });
    await service.unarchive('s1');
    const s = sessions.store.get('s1')!;
    expect(s.status).toBe(SessionStatus.ACTIVE);
    expect(s.updatedAt).toBe(1);
  });
});

describe('ManageSessionService.touch（仅更新 updatedAt）', () => {
  let sessions: FakeSessionRepository;
  let messages: FakeMessageRepository;
  let clock: MutableClock;
  let service: ManageSessionService;
  const T0 = 1_700_000_000_000;
  const T1 = 1_700_000_009_999;

  // 预置一条完整会话，updatedAt=T0，其余字段固定以便断言 touch 只改 updatedAt。
  function seedSession(
    over: Partial<ChatSession> & Pick<ChatSession, 'id'>,
  ): void {
    const full: ChatSession = {
      title: '会话',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '/repo/app',
      projectName: 'app',
      createdAt: T0,
      updatedAt: T0,
      ...over,
    };
    sessions.store.set(full.id, full);
  }

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    messages = new FakeMessageRepository();
    clock = new MutableClock(T0);
    service = new ManageSessionService(
      sessions,
      messages,
      clock,
      new SequentialIdGenerator(),
    );
  });

  it('touch 后仅 updatedAt 变为 Clock.now()，其余字段恒等', async () => {
    seedSession({ id: 's1' });
    const before = sessions.store.get('s1')!;

    clock.set(T1);
    await service.touch('s1');

    const after = sessions.store.get('s1')!;
    expect(after.updatedAt).toBe(T1);
    // 除 updatedAt 外全部字段与 touch 前一致。
    expect({ ...after, updatedAt: 0 }).toEqual({ ...before, updatedAt: 0 });
  });

  it('touch 不改 createdAt（仅顶前 updatedAt）', async () => {
    seedSession({ id: 's1' });
    clock.set(T1);
    await service.touch('s1');
    const after = sessions.store.get('s1')!;
    expect(after.createdAt).toBe(T0);
    expect(after.updatedAt).toBe(T1);
  });

  it('touch 不存在会话为无害（仓储按无操作处理，不抛且不新建）', async () => {
    clock.set(T1);
    await expect(service.touch('missing')).resolves.toBeUndefined();
    expect(sessions.store.has('missing')).toBe(false);
  });
});

describe('ManageSessionService.delete（级联删消息）', () => {
  let sessions: FakeSessionRepository;
  let messages: FakeMessageRepository;
  let service: ManageSessionService;

  function seedSession(id: SessionId): void {
    sessions.store.set(id, {
      id,
      title: '会话',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '',
      projectName: '',
      createdAt: 1,
      updatedAt: 1,
    });
  }

  // 仅本组测试关心 sessionId 归属，其余 Message 字段以最小合法投影充数。
  function seedMessages(sessionId: SessionId, count: number): void {
    const list: Message[] = [];
    for (let i = 0; i < count; i += 1) {
      list.push({ sessionId } as unknown as Message);
    }
    messages.store.set(sessionId, list);
  }

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    messages = new FakeMessageRepository();
    service = new ManageSessionService(
      sessions,
      messages,
      new FrozenClock(1),
      new SequentialIdGenerator(),
    );
  });

  it('删除后会话与其消息都不存在（级联清空该会话消息）', async () => {
    seedSession('s1');
    seedMessages('s1', 3);
    expect(messages.store.get('s1')).toHaveLength(3);

    await service.delete('s1');

    expect(sessions.store.has('s1')).toBe(false);
    expect(await messages.listBySession({ sessionId: 's1' } as HistoryQuery)).toEqual([]);
  });

  it('只删目标会话消息，不误删其他会话消息', async () => {
    seedSession('s1');
    seedSession('s2');
    seedMessages('s1', 2);
    seedMessages('s2', 4);

    await service.delete('s1');

    expect(sessions.store.has('s1')).toBe(false);
    expect(sessions.store.has('s2')).toBe(true);
    expect(messages.store.get('s1')).toBeUndefined();
    expect(messages.store.get('s2')).toHaveLength(4);
  });

  it('删不存在的会话为幂等无害（两侧仓储均不抛）', async () => {
    await expect(service.delete('missing')).resolves.toBeUndefined();
    expect(sessions.store.has('missing')).toBe(false);
  });
});
