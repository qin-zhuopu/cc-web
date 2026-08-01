// conversation/usecases/get-session-history.test.ts
// GetSessionHistoryService.getHistory 的单元测试（vitest）。
// 全用内存假替身，断言：
//   - getHistory 按 createdAt 升序返回；
//   - 分页（limit/beforeRowId）由仓储负责，用例透传查询；
//   - 空会话返回空数组。

import { describe, it, expect, beforeEach } from 'vitest';
import { GetSessionHistoryService } from './get-session-history.js';
import type { MessageRepository } from '../ports/driven/message-repository.js';
import type { SessionId } from '../domain/session/chat-session.js';
import type { Message, MessageId } from '../domain/message/message.js';
import type { StreamStatus } from '../domain/message/stream-status.js';
import type { TokenUsage } from '../domain/message/token-usage.js';
import type { HistoryQuery } from '../ports/driving/get-session-history-usecase.js';
import { textContent } from '../domain/message/message-content.js';

// —— 假替身 ——

/**
 * 内存消息仓储：Map<SessionId, Message[]>。
 *
 * listBySession 按 HistoryQuery 应用 limit/beforeRowId 分页（模拟适配器 rowid 游标）：
 * 用插入次序（数组下标 + 1）充当 rowid，返回 rowid < beforeRowId 的更早消息、
 * 尾部取 limit 条（贴合「取最新一页」语义）。用例只透传查询、不重复分页。
 */
class FakeMessageRepository implements MessageRepository {
  readonly store = new Map<SessionId, Message[]>();
  /** 记录 listBySession 收到的查询，断言用例原样透传。 */
  listCalls: HistoryQuery[] = [];

  async listBySession(query: HistoryQuery): Promise<ReadonlyArray<Message>> {
    this.listCalls.push(query);
    const all = this.store.get(query.sessionId) ?? [];
    // rowid = 插入下标 + 1（稳定游标）。
    let rows = all.map((m, i) => ({ m, rowid: i + 1 }));
    if (query.beforeRowId !== undefined) {
      rows = rows.filter((r) => r.rowid < query.beforeRowId!);
    }
    if (query.limit !== undefined) {
      // 取最新一页：尾部 limit 条。
      rows = rows.slice(-query.limit);
    }
    return rows.map((r) => r.m);
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
    // 本故事不涉及，占位。
  }
  async deleteBySession(sessionId: SessionId): Promise<number> {
    const n = this.store.get(sessionId)?.length ?? 0;
    this.store.delete(sessionId);
    return n;
  }
}

// —— 测试辅助 ——

const SESSION_ID = 's1';

/** 便捷构造一条消息，仅指定 id 与 createdAt（其余取合理缺省）。 */
function makeMessage(id: MessageId, createdAt: number): Message {
  return {
    id,
    sessionId: SESSION_ID,
    role: 'user',
    content: textContent(id),
    createdAt,
    streamStatus: 'completed',
    isHeartbeatAck: false,
  };
}

/** 构造一条心跳应答消息（isHeartbeatAck=true，render-only 噪音）。 */
function makeHeartbeatAck(id: MessageId, createdAt: number): Message {
  return { ...makeMessage(id, createdAt), isHeartbeatAck: true };
}

/** 构造一条带 taskRunId 关联的 render-only join marker 消息。 */
function makeTaskRunMarker(
  id: MessageId,
  createdAt: number,
  taskRunId: string,
): Message {
  return { ...makeMessage(id, createdAt), taskRunId };
}

// —— 测试 ——

describe('GetSessionHistoryService.getHistory', () => {
  let messages: FakeMessageRepository;
  let service: GetSessionHistoryService;

  beforeEach(() => {
    messages = new FakeMessageRepository();
    service = new GetSessionHistoryService(messages);
  });

  it('按 createdAt 升序返回（无论入库顺序）', async () => {
    // 故意乱序入库：createdAt 300、100、200。
    messages.store.set(SESSION_ID, [
      makeMessage('c', 300),
      makeMessage('a', 100),
      makeMessage('b', 200),
    ]);

    const list = await service.getHistory({ sessionId: SESSION_ID });

    expect(list.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(list.map((m) => m.createdAt)).toEqual([100, 200, 300]);
  });

  it('空会话返回空数组', async () => {
    const list = await service.getHistory({ sessionId: SESSION_ID });
    expect(list).toEqual([]);
  });

  it('limit 分页由仓储负责：透传查询并取最新一页，结果仍升序', async () => {
    // 入库 5 条，createdAt 递增；取 limit=2 → 最新两条（400、500）。
    messages.store.set(SESSION_ID, [
      makeMessage('m1', 100),
      makeMessage('m2', 200),
      makeMessage('m3', 300),
      makeMessage('m4', 400),
      makeMessage('m5', 500),
    ]);

    const list = await service.getHistory({ sessionId: SESSION_ID, limit: 2 });

    // 用例把 query 原样透传给仓储（分页归仓储）。
    expect(messages.listCalls).toEqual([{ sessionId: SESSION_ID, limit: 2 }]);
    // 最新两条，且升序。
    expect(list.map((m) => m.id)).toEqual(['m4', 'm5']);
  });

  it('beforeRowId 游标分页由仓储负责：取更早消息，结果升序', async () => {
    messages.store.set(SESSION_ID, [
      makeMessage('m1', 100),
      makeMessage('m2', 200),
      makeMessage('m3', 300),
      makeMessage('m4', 400),
    ]);

    // beforeRowId=3 → 只取 rowid 1、2（m1、m2）。
    const list = await service.getHistory({
      sessionId: SESSION_ID,
      beforeRowId: 3,
    });

    expect(messages.listCalls).toEqual([
      { sessionId: SESSION_ID, beforeRowId: 3 },
    ]);
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('createdAt 相等者保持仓储原有次序（稳定排序）', async () => {
    // 两条同 createdAt，入库序 x 在 y 前，升序后仍 x 在 y 前。
    messages.store.set(SESSION_ID, [
      makeMessage('x', 100),
      makeMessage('y', 100),
    ]);

    const list = await service.getHistory({ sessionId: SESSION_ID });
    expect(list.map((m) => m.id)).toEqual(['x', 'y']);
  });

  it('不修改仓储返回的底层数组（拷贝后排序）', async () => {
    const stored = [makeMessage('c', 300), makeMessage('a', 100)];
    messages.store.set(SESSION_ID, stored);

    await service.getHistory({ sessionId: SESSION_ID });

    // 原数组次序未被排序副作用改动。
    expect(stored.map((m) => m.id)).toEqual(['c', 'a']);
  });
});

describe('GetSessionHistoryService.getPromptView', () => {
  let messages: FakeMessageRepository;
  let service: GetSessionHistoryService;

  beforeEach(() => {
    messages = new FakeMessageRepository();
    service = new GetSessionHistoryService(messages);
  });

  it('剥离 isHeartbeatAck 心跳应答消息：getHistory 全含、getPromptView 剔除（AC-9 两者不同）', async () => {
    // 普通消息 a/c 与心跳应答 hb 交错入库。
    messages.store.set(SESSION_ID, [
      makeMessage('a', 100),
      makeHeartbeatAck('hb', 200),
      makeMessage('c', 300),
    ]);

    const history = await service.getHistory({ sessionId: SESSION_ID });
    const prompt = await service.getPromptView({ sessionId: SESSION_ID });

    // getHistory 全含（含心跳），升序。
    expect(history.map((m) => m.id)).toEqual(['a', 'hb', 'c']);
    // getPromptView 剥离心跳应答，只留真正进上下文的消息。
    expect(prompt.map((m) => m.id)).toEqual(['a', 'c']);
    // AC-9：含 render-only 标记时两者返回不同。
    expect(prompt.map((m) => m.id)).not.toEqual(history.map((m) => m.id));
  });

  it('剥离 taskRunId 关联的 render-only join marker 消息', async () => {
    messages.store.set(SESSION_ID, [
      makeMessage('a', 100),
      makeTaskRunMarker('mk', 200, 'run-1'),
      makeMessage('c', 300),
    ]);

    const history = await service.getHistory({ sessionId: SESSION_ID });
    const prompt = await service.getPromptView({ sessionId: SESSION_ID });

    expect(history.map((m) => m.id)).toEqual(['a', 'mk', 'c']);
    expect(prompt.map((m) => m.id)).toEqual(['a', 'c']);
    expect(prompt.map((m) => m.id)).not.toEqual(history.map((m) => m.id));
  });

  it('纯普通消息：getHistory 与 getPromptView 一致', async () => {
    messages.store.set(SESSION_ID, [
      makeMessage('a', 100),
      makeMessage('b', 200),
      makeMessage('c', 300),
    ]);

    const history = await service.getHistory({ sessionId: SESSION_ID });
    const prompt = await service.getPromptView({ sessionId: SESSION_ID });

    expect(prompt.map((m) => m.id)).toEqual(history.map((m) => m.id));
    expect(prompt.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('prompt 视图仍保持 createdAt 升序（复用 getHistory 排序）', async () => {
    // 乱序入库、混入心跳与 marker，断言剥离后仍升序。
    messages.store.set(SESSION_ID, [
      makeMessage('c', 300),
      makeHeartbeatAck('hb', 250),
      makeMessage('a', 100),
      makeTaskRunMarker('mk', 150, 'run-2'),
      makeMessage('b', 200),
    ]);

    const prompt = await service.getPromptView({ sessionId: SESSION_ID });

    expect(prompt.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(prompt.map((m) => m.createdAt)).toEqual([100, 200, 300]);
  });

  it('空会话返回空数组', async () => {
    const prompt = await service.getPromptView({ sessionId: SESSION_ID });
    expect(prompt).toEqual([]);
  });
});
