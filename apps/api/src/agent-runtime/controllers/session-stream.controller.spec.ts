// apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts
// SessionStreamController 单测（accept-4 / SPEC CAP-4）。用假 C1 建会话用例 + 假 C2 StartStream +
//   真实 SessionSseHub + tmpdir FileEventLog 断言：
//   - 首个 SSE 事件回推新 sessionId（{ type:'session', sessionId }）；
//   - 后续归一事件逐帧带单调递增 seq（id: 1, 2, ...，从 1 起严格 +1）；
//   - options（mode/model/providerId/thinking/... + 首句）正确透传给 StartStream，sessionId 用新建会话回填；
//   - 每事件一式三份：写进文件日志（可 readAfter 回放）、广播给挂在该会话上的订阅者。
//   真第一轮需真实 litellm（属 accept-9），本故事用 stub runtime（假 events 序列）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ManageSessionUseCase,
  CreateSessionInput,
  StartStreamUseCase,
  StartStreamInput,
  StartStreamResult,
  AgentStreamEvent,
  ChatSession,
} from '@codepilot/core';
import { SessionStreamController } from './session-stream.controller.js';
import { SessionSseHub } from '../adapters/session-sse-hub.js';
import { FileEventLog } from '../adapters/file-event-log.js';

/** 把一组事件包成 StartStreamResult.events 的 AsyncIterable。 */
function eventsOf(events: ReadonlyArray<AgentStreamEvent>): AsyncIterable<AgentStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        yield e;
      }
    },
  };
}

/** 假 express Response：记录 writeHead / write / end 调用，供断言 SSE 帧。 */
function makeFakeRes() {
  const frames: string[] = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  let ended = false;
  const res = {
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      head = { status, headers };
      return res;
    }),
    write: vi.fn((chunk: string) => {
      frames.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      ended = true;
      return res;
    }),
  };
  return { res, frames, getHead: () => head, isEnded: () => ended };
}

/** 造一个最小 ChatSession（只填断言用到的 id，其余给合理默认，反假数据仅测试夹具）。 */
function fakeSession(id: string): ChatSession {
  return {
    id,
    title: '默认标题',
    titleOrigin: 'default' as ChatSession['titleOrigin'],
    status: 'active' as ChatSession['status'],
    mode: 'code' as ChatSession['mode'],
    source: 'user' as ChatSession['source'],
    workingDirectory: '/tmp/ws',
    projectName: 'ws',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('SessionStreamController —— POST /api/sessions/stream 新建 + 首轮流式', () => {
  let baseDir: string;
  let eventLog: FileEventLog;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'accept4-'));
    eventLog = new FileEventLog(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('首帧回推新 sessionId；后续事件带从 1 起严格 +1 的 seq；options 透传', async () => {
    const streamEvents: ReadonlyArray<AgentStreamEvent> = [
      { type: 'text', text: '你好' },
      { type: 'thinking', delta: '想一下' },
      { type: 'result' },
    ];
    const createSpy = vi.fn(
      async (_input: CreateSessionInput): Promise<ChatSession> => fakeSession('new-sess-1'),
    );
    const startSpy = vi.fn(
      async (_input: StartStreamInput): Promise<StartStreamResult> => ({
        streamId: 'stream-1',
        events: eventsOf(streamEvents),
      }),
    );
    const manageSession = { create: createSpy } as unknown as ManageSessionUseCase;
    const startStream: StartStreamUseCase = { start: startSpy };
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);
    const { res, frames, getHead, isEnded } = makeFakeRes();

    await controller.createAndStream(
      {
        content: '请帮我写代码',
        model: 'Jereh-Kimi-K2.6',
        providerId: 'anthropic-1',
        mode: 'plan' as never,
        thinking: { type: 'enabled', budgetTokens: 2048 },
        context1m: true,
        selectedSkills: ['skill-a'],
        workingDirectory: '/tmp/ws',
      },
      res as never,
    );

    // 建会话被调一次。
    expect(createSpy).toHaveBeenCalledOnce();

    // SSE 头就位。
    expect(getHead()?.status).toBe(200);
    expect(getHead()?.headers['Content-Type']).toBe('text/event-stream');

    // 首帧回推新 sessionId（不带 seq）。
    expect(frames[0]).toBe(
      `event: session\ndata: ${JSON.stringify({ type: 'session', sessionId: 'new-sess-1' })}\n\n`,
    );

    // 后续归一事件逐帧带 id: seq，从 1 起严格 +1，透传不伪造。
    expect(frames[1]).toBe(
      `id: 1\nevent: text\ndata: ${JSON.stringify({ type: 'text', text: '你好' })}\n\n`,
    );
    expect(frames[2]).toBe(
      `id: 2\nevent: thinking\ndata: ${JSON.stringify({ type: 'thinking', delta: '想一下' })}\n\n`,
    );
    expect(frames[3]).toBe(
      `id: 3\nevent: result\ndata: ${JSON.stringify({ type: 'result' })}\n\n`,
    );
    expect(isEnded()).toBe(true);

    // options 透传给 StartStream：sessionId 用新建会话回填，可选字段忠实带上，缺省不出现（反假数据）。
    expect(startSpy).toHaveBeenCalledOnce();
    const passed = startSpy.mock.calls[0]![0]!;
    expect(passed).toEqual({
      sessionId: 'new-sess-1',
      content: '请帮我写代码',
      mode: 'plan',
      model: 'Jereh-Kimi-K2.6',
      providerId: 'anthropic-1',
      thinking: { type: 'enabled', budgetTokens: 2048 },
      context1m: true,
      selectedSkills: ['skill-a'],
    });
  });

  it('每事件写进文件日志（可 readAfter 回放，seq 与 SSE id 一致）', async () => {
    const streamEvents: ReadonlyArray<AgentStreamEvent> = [
      { type: 'text', text: 'A' },
      { type: 'result' },
    ];
    const manageSession = {
      create: vi.fn(async () => fakeSession('sess-log')),
    } as unknown as ManageSessionUseCase;
    const startStream: StartStreamUseCase = {
      start: vi.fn(async () => ({ streamId: 's', events: eventsOf(streamEvents) })),
    };
    const controller = new SessionStreamController(
      manageSession,
      startStream,
      new SessionSseHub(),
      eventLog,
    );
    const { res } = makeFakeRes();

    await controller.createAndStream(
      { content: 'hi', model: 'm', providerId: 'p' },
      res as never,
    );

    const replayed: Array<{ seq: number; event: AgentStreamEvent }> = [];
    for await (const entry of eventLog.readAfter('sess-log', 0)) {
      replayed.push(entry);
    }
    expect(replayed).toEqual([
      { seq: 1, event: { type: 'text', text: 'A' } },
      { seq: 2, event: { type: 'result' } },
    ]);
  });

  it('每事件广播给挂在该会话上的订阅者（一式三份的广播那份）', async () => {
    const streamEvents: ReadonlyArray<AgentStreamEvent> = [
      { type: 'text', text: 'X' },
      { type: 'result' },
    ];
    const manageSession = {
      create: vi.fn(async () => fakeSession('sess-bc')),
    } as unknown as ManageSessionUseCase;
    const startStream: StartStreamUseCase = {
      start: vi.fn(async () => ({ streamId: 's', events: eventsOf(streamEvents) })),
    };
    const hub = new SessionSseHub();
    // 预先挂一个订阅者（模拟另一个 GET /:id/stream 连接）。订阅者收到的是【已分配 seq 的信封】
    // { seq, event }（F1 修复后 listener 复用信封里的 seq、不再 append）。
    const received: Array<{ seq: number; event: AgentStreamEvent }> = [];
    hub.subscribe('sess-bc', (envelope) => received.push(envelope));

    const controller = new SessionStreamController(
      manageSession,
      startStream,
      hub,
      eventLog,
    );
    const { res } = makeFakeRes();

    await controller.createAndStream(
      { content: 'hi', model: 'm', providerId: 'p' },
      res as never,
    );

    // 广播的是信封：seq 与生产者侧 append 分配的一致（从 1 起 +1），event 为归一事件本体。
    expect(received).toEqual([
      { seq: 1, event: { type: 'text', text: 'X' } },
      { seq: 2, event: { type: 'result' } },
    ]);
  });
});

// ============================================================================
// accept-5 / SPEC CAP-5 —— GET /api/sessions/:id/stream 挂载已有会话的实时流。
// 用真实 SessionSseHub + tmpdir FileEventLog 断言：
//   - 先挂载再对同会话 publish → 该连接收到，SSE 帧带单调递增 seq（id: 字段）；
//   - 连接断开后中枢订阅者集合清空（unsubscribe 被调，无泄漏）；
//   - 不同会话互不串台；
//   - 挂载本身不触发新回合（StartStream 未被调）。
// ============================================================================

/**
 * 假 SSE 长连接 Response：记录 writeHead/write 帧并支持手动触发 'close' 事件（模拟客户端断开）。
 * 与 makeFakeRes 的差异：本连接是 GET 挂载的【长连接】，不期望 end() 被调（SSE 保持打开），
 * 且需能触发 close 以验证 unsubscribe。
 */
function makeFakeSseRes() {
  const frames: string[] = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  let ended = false;
  let closeListener: (() => void) | undefined;
  const res = {
    writeHead: vi.fn((status: number, headers: Record<string, string>) => {
      head = { status, headers };
      return res;
    }),
    write: vi.fn((chunk: string) => {
      frames.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      ended = true;
      return res;
    }),
    on: vi.fn((event: 'close', listener: () => void) => {
      if (event === 'close') {
        closeListener = listener;
      }
      return res;
    }),
  };
  return {
    res,
    frames,
    getHead: () => head,
    isEnded: () => ended,
    /** 触发已注册的 'close' 回调（模拟客户端断开）。未注册时不抛。 */
    close: () => {
      closeListener?.();
    },
  };
}

describe('SessionStreamController —— GET /api/sessions/:id/stream 挂载已有会话', () => {
  let baseDir: string;
  let eventLog: FileEventLog;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'accept5-'));
    eventLog = new FileEventLog(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  /** 造一个最小假 StartStream（accept-5 不应触发它；用 spy 断言未被调）。 */
  function unusedStartStream(): StartStreamUseCase {
    return { start: vi.fn(async () => ({ streamId: 'unused', events: eventsOf([]) })) };
  }

  /** 造一个最小假 ManageSession（accept-5 不应触发它）。 */
  function unusedManageSession(): ManageSessionUseCase {
    return { create: vi.fn(async () => fakeSession('unused')) } as unknown as ManageSessionUseCase;
  }

  it('先挂载再对同会话 publish → 该连接收到，帧带信封携带的 seq', async () => {
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(
      unusedManageSession(),
      unusedStartStream(),
      hub,
      eventLog,
    );
    const { res, frames, getHead, isEnded } = makeFakeSseRes();

    // 挂载该会话的实时流（GET）。attachStream 为 async（accept-7 补发需 await readAfter），
    // 此处无历史日志 → readAfter 返回空 → await 让出至多一个微任务后同步登记 listener 再返回。
    await controller.attachStream('sess-attach', undefined, res as never);

    // SSE 头就位。
    expect(getHead()?.status).toBe(200);
    expect(getHead()?.headers['Content-Type']).toBe('text/event-stream');

    // 挂载后对该会话 publish 两条【已分配 seq 的信封】（模拟生产者侧 append 后 publish）。
    //    listener 复用信封里的 seq 写帧、不再 append（F1 修复后行为）。
    hub.publish('sess-attach', { seq: 1, event: { type: 'text', text: '第一条' } });
    hub.publish('sess-attach', { seq: 2, event: { type: 'result' } });

    // 写帧是同步的（listener 内无异步 append 了），但 listener 经 hub fan-out 同步派发，
    // 故帧已落定；await 一个 tick 让控制返回。
    await waitForFrames(frames, 2);

    // 帧带 id: seq（== 信封携带的 seq，从 1 起严格 +1）+ event 名 + 透传整条归一事件 JSON。
    expect(frames).toEqual([
      `id: 1\nevent: text\ndata: ${JSON.stringify({ type: 'text', text: '第一条' })}\n\n`,
      `id: 2\nevent: result\ndata: ${JSON.stringify({ type: 'result' })}\n\n`,
    ]);

    // SSE 长连接保持打开（不调 end）。
    expect(isEnded()).toBe(false);
  });

  it('连接断开后中枢订阅者集合清空（unsubscribe 被调，无泄漏）', async () => {
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(
      unusedManageSession(),
      unusedStartStream(),
      hub,
      eventLog,
    );
    const { res, frames, close } = makeFakeSseRes();

    await controller.attachStream('sess-leak', undefined, res as never);
    // 挂载时中枢应登记了一个订阅者。
    hub.publish('sess-leak', { seq: 1, event: { type: 'text', text: 'before' } });
    await waitForFrames(frames, 1);
    expect(frames.length).toBe(1);

    // 模拟客户端断开 → 'close' 回调触发 unsubscribe。
    close();

    // 断开后再 publish 不应再有新帧（订阅者已摘除、集合空、无泄漏）。让出 tick 确认无增长。
    hub.publish('sess-leak', { seq: 2, event: { type: 'text', text: 'after' } });
    await settleTicks();
    expect(frames.length).toBe(1);
  });

  it('不同会话互不串台（挂载 A，对 B publish 不收到）', async () => {
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(
      unusedManageSession(),
      unusedStartStream(),
      hub,
      eventLog,
    );
    const { res, frames } = makeFakeSseRes();

    await controller.attachStream('sess-a', undefined, res as never);

    // 对另一个会话 publish 不应触达本连接。让出 tick 确认无增长。
    hub.publish('sess-b', { seq: 1, event: { type: 'text', text: '不该收到' } });
    await settleTicks();
    expect(frames.length).toBe(0);

    // 对自己挂载的会话 publish 才收到（信封 seq 即帧 id）。
    hub.publish('sess-a', { seq: 1, event: { type: 'text', text: '该收到' } });
    await waitForFrames(frames, 1);
    expect(frames).toEqual([
      `id: 1\nevent: text\ndata: ${JSON.stringify({ type: 'text', text: '该收到' })}\n\n`,
    ]);
  });

  it('挂载本身不触发新回合（StartStream / ManageSession 均未被调）', async () => {
    const hub = new SessionSseHub();
    const manageSession = unusedManageSession();
    const startStream = unusedStartStream();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);
    const { res } = makeFakeSseRes();

    await controller.attachStream('sess-no-turn', undefined, res as never);

    expect(manageSession.create).not.toHaveBeenCalled();
    expect(startStream.start).not.toHaveBeenCalled();
  });
});

// ============================================================================
// accept-6 / SPEC CAP-6 —— POST /api/sessions/:id/turn 发消息触发一轮 + 广播给所有挂载连接。
// 用真实 SessionSseHub + tmpdir FileEventLog + 假 StartStream（stub events）断言：
//   - POST 立即返回受理确认 { accepted:true, streamId }，不阻塞在事件流上（不等回合结束）；
//   - 入参 sessionId 用路径参数、content/model/providerId 正确透传给 StartStream；
//   - 两个挂在该会话的 GET stream 连接都收到该轮全部事件、seq 一致递增（fan-out）；
//   - 事件写进了文件日志（补发数据源，可 readAfter 回放）。
//   真回合需真实 litellm（属 accept-9），本故事用 stub runtime（假 events 序列）。
// ============================================================================

describe('SessionStreamController —— POST /api/sessions/:id/turn 发消息触发一轮 + 广播', () => {
  let baseDir: string;
  let eventLog: FileEventLog;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'accept6-'));
    eventLog = new FileEventLog(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  /** 造一个最小假 ManageSession（accept-6 不应触发它；用 spy 断言未被调）。 */
  function unusedManageSession(): ManageSessionUseCase {
    return { create: vi.fn(async () => fakeSession('unused')) } as unknown as ManageSessionUseCase;
  }

  it('立即返回受理确认 { accepted:true, streamId }，不阻塞在事件流上', async () => {
    // 用一个【永不结束】的 events 流验证 sendMessage 不会等它跑完才返回——
    // 若误 await 消费，本测试会挂到超时。
    const slowEvents: AsyncIterable<AgentStreamEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
        return {
          next: () =>
            new Promise<IteratorResult<AgentStreamEvent>>((resolve) => {
              // 永不 resolve：模拟一直挂着的回合事件流。
              // 故意不调 resolve；测试靠 sendMessage 立即返回证明未阻塞。
            }),
        };
      },
    };
    const startSpy = vi.fn(
      async (_input: StartStreamInput): Promise<StartStreamResult> => ({
        streamId: 'stream-post-1',
        events: slowEvents,
      }),
    );
    const startStream: StartStreamUseCase = { start: startSpy };
    const controller = new SessionStreamController(
      unusedManageSession(),
      startStream,
      new SessionSseHub(),
      eventLog,
    );

    // sendMessage 必须在 events 流未结束前就 resolve（立即返回受理确认）。
    const ack = await controller.sendMessage('sess-now', {
      content: '第二句',
      model: 'Jereh-Kimi-K2.6',
      providerId: 'anthropic-1',
    });

    expect(ack).toEqual({ accepted: true, streamId: 'stream-post-1' });

    // 入参透传：sessionId 用路径参数，content/model/providerId 忠实带上。
    expect(startSpy).toHaveBeenCalledOnce();
    const passed = startSpy.mock.calls[0]![0]!;
    expect(passed.sessionId).toBe('sess-now');
    expect(passed.content).toBe('第二句');
    expect(passed.model).toBe('Jereh-Kimi-K2.6');
    expect(passed.providerId).toBe('anthropic-1');
    // mode 缺省透传 'code'（对齐 CreateStream 默认；反假数据：未传字段不预填）。
    expect(passed.mode).toBe('code');
  });

  it('两个挂在 GET stream 的连接都收到该轮全部事件、seq 一致递增（fan-out）', async () => {
    const streamEvents: ReadonlyArray<AgentStreamEvent> = [
      { type: 'text', text: '回复一' },
      { type: 'thinking', delta: '想' },
      { type: 'result' },
    ];
    const startStream: StartStreamUseCase = {
      start: vi.fn(async () => ({ streamId: 'stream-post-2', events: eventsOf(streamEvents) })),
    };
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(unusedManageSession(), startStream, hub, eventLog);

    // 预先挂两个 GET stream 连接（模拟两个 CLI / curl 挂在同一会话上）。
    const connA = makeFakeSseRes();
    const connB = makeFakeSseRes();
    // 先挂两个 GET stream 连接（await 确保订阅在 POST 触发回合前登记完毕；attachStream 为 async）。
    await controller.attachStream('sess-fanout', undefined, connA.res as never);
    await controller.attachStream('sess-fanout', undefined, connB.res as never);

    // POST 触发一轮（立即返回）。
    const ack = await controller.sendMessage('sess-fanout', {
      content: '发一句',
      model: 'm',
      providerId: 'p',
    });
    expect(ack.accepted).toBe(true);

    // 后台消费完 3 条事件 → 中枢 fan-out 给两个连接 → listener 复用信封 seq 写帧。
    await waitForFrames(connA.frames, 3);
    await waitForFrames(connB.frames, 3);

    // 两个连接都【按相同顺序】收到该轮全部 3 条归一事件（事件 type 序列一致，data 透传不伪造）。
    const typesOf = (frames: string[]) =>
      frames.map((f) => {
        const m = /^event: (\S+)/m.exec(f);
        return m ? m[1] : null;
      });
    expect(typesOf(connA.frames)).toEqual(['text', 'thinking', 'result']);
    expect(typesOf(connB.frames)).toEqual(['text', 'thinking', 'result']);

    // data 透传：两连接首帧载荷一致（整条归一事件 JSON，不伪造）。
    const dataOf = (f: string) => /^data: (.+)$/m.exec(f)?.[1];
    expect(dataOf(connA.frames[0]!)).toBe(dataOf(connB.frames[0]!));

    // seq 在每个连接内严格单调递增（断 id: 字段）。F1 修复后 listener 复用生产者侧唯一分配的 seq，
    //   故【两个连接的 seq 序列完全一致】（同一事件信封带同一 seq 广播给所有订阅者）。
    const seqsOf = (frames: string[]) =>
      frames.map((f) => Number(/^id: (\d+)/m.exec(f)?.[1]));
    const assertStrictlyIncreasing = (seqs: number[]) => {
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
      }
    };
    assertStrictlyIncreasing(seqsOf(connA.frames));
    assertStrictlyIncreasing(seqsOf(connB.frames));
    // 两连接收到完全相同的 seq 序列（F1 修复前 listener 各自 append 会错位，修复后应严格一致）。
    expect(seqsOf(connA.frames)).toEqual(seqsOf(connB.frames));
  });

  it('事件写进了文件日志（补发数据源，可 readAfter 回放）', async () => {
    const streamEvents: ReadonlyArray<AgentStreamEvent> = [
      { type: 'text', text: '落日志' },
      { type: 'result' },
    ];
    const startStream: StartStreamUseCase = {
      start: vi.fn(async () => ({ streamId: 'stream-log', events: eventsOf(streamEvents) })),
    };
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(unusedManageSession(), startStream, hub, eventLog);

    // 【不挂任何 GET 连接】—— consumeInBackground 自身就落文件日志（一式三份的「补发数据源」那份），
    // 不依赖 listener。无 listener 时每个事件恰好一行，seq 从 1 起严格 +1。
    await controller.sendMessage('sess-flog', { content: 'hi', model: 'm', providerId: 'p' });
    // 等后台 consumeInBackground 消费完两事件落定（await sendMessage 仅返回 ack，不等消费）。
    await waitForLog(eventLog, 'sess-flog', 2);

    const replayed: Array<{ seq: number; event: AgentStreamEvent }> = [];
    for await (const entry of eventLog.readAfter('sess-flog', 0)) {
      replayed.push(entry);
    }
    expect(replayed).toEqual([
      { seq: 1, event: { type: 'text', text: '落日志' } },
      { seq: 2, event: { type: 'result' } },
    ]);
  });

  // ============================================================================
  // 【F1 回归】seq 双重分配致「文件日志写 N+1 行 / 断线补发重复」。
  //   评审 F1 指出的测试盲区：生产者侧（POST /:id/turn 的 consumeInBackground）每事件 append
  //   拿 seq 后 publish 信封；GET /:id/stream 挂载的订阅者 listener 收到信封后【若再次 append】，
  //   同一事件会被写进文件日志两次、分配两个不同 seq，破坏「一行一事件」与断线补发「不丢不重」。
  //   修复后 listener 复用信封携带的 seq 写帧、绝不二次 append——故 N 条事件恰好 N 行、seq 1..N 严格递增无重复。
  //   修复前此测试会失败（出现 N+1 行 / seq 序列出现重复或跳跃）。
  // ============================================================================
  it('[F1] 生产者 + 挂载订阅者并存：文件日志每事件恰好一行（seq 1..N 严格递增、无重复）', async () => {
    const N = 3;
    const streamEvents: ReadonlyArray<AgentStreamEvent> = [
      { type: 'text', text: 'e1' },
      { type: 'text', text: 'e2' },
      { type: 'result' },
    ];
    expect(streamEvents.length).toBe(N);
    const startStream: StartStreamUseCase = {
      start: vi.fn(async () => ({ streamId: 'stream-f1', events: eventsOf(streamEvents) })),
    };
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(unusedManageSession(), startStream, hub, eventLog);

    // 关键：先挂一个 GET /:id/stream 订阅者（F1 触发条件——订阅者与生产者侧 consumeInBackground 并存）。
    //    修复前 listener 收到 publish 后会再次 append，致每个事件被写 N+1 次。
    const sub = makeFakeSseRes();
    await controller.attachStream('sess-f1', undefined, sub.res as never);

    // POST 触发一轮（立即返回 ack；consumeInBackground 在后台消费 N 条事件，每条 append + publish 信封）。
    const ack = await controller.sendMessage('sess-f1', { content: 'hi', model: 'm', providerId: 'p' });
    expect(ack.accepted).toBe(true);

    // 等后台消费完 N 条事件落定（文件日志行数到位 + 订阅者收到 N 帧）。
    await waitForLog(eventLog, 'sess-f1', N);
    await waitForFrames(sub.frames, N);

    // —— 核心断言 1：文件日志恰好 N 行（不是 N+1）——
    //   修复前 listener 二次 append 会使日志多出 N 行（每事件被写两次 → 2N 行），或至少 > N。
    const logEntries: Array<{ seq: number; event: AgentStreamEvent }> = [];
    for await (const entry of eventLog.readAfter('sess-f1', 0)) {
      logEntries.push(entry);
    }
    expect(logEntries.length).toBe(N);

    // —— 核心断言 2：seq 为 1..N 严格递增、无重复 ——
    //   修复前同一事件被两次 append 会拿到不同 seq，致 seq 序列出现重复或与 1..N 不符。
    const seqs = logEntries.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(N);

    // —— 核心断言 3：日志里的事件本体与生产者发出的序列一致（无伪造 / 无错位）——
    expect(logEntries.map((e) => e.event)).toEqual([
      { type: 'text', text: 'e1' },
      { type: 'text', text: 'e2' },
      { type: 'result' },
    ]);

    // —— 旁证：订阅者 SSE 帧的 seq 与日志 seq 严格对齐（listener 复用信封 seq、不二次分配）——
    //   修复前订阅者帧的 seq（来自二次 append）会与日志 seq 错位、不一致。
    const subSeqs = sub.frames.map((f) => Number(/^id: (\d+)/m.exec(f)?.[1]));
    expect(subSeqs).toEqual(seqs);
  });

  // ============================================================================
  // 【F1 回归 · 补发侧】断线补发（Last-Event-ID: 0）也只收到每个事件一次。
  //   修复前若补发期间生产者对【已在日志里的事件】二次 publish（因 listener 二次 append 产生新 seq 行），
  //   断线重连补发会读到重复事件行。修复后每事件唯一 seq，补发 readAfter 只产出 N 条、seq 1..N 无重复。
  // ============================================================================
  it('[F1] 断线补发（Last-Event-ID: 0）只收到每个事件一次（seq 1..N 无重复）', async () => {
    const N = 2;
    const streamEvents: ReadonlyArray<AgentStreamEvent> = [
      { type: 'text', text: 'r1' },
      { type: 'result' },
    ];
    expect(streamEvents.length).toBe(N);
    const startStream: StartStreamUseCase = {
      start: vi.fn(async () => ({ streamId: 'stream-f1-replay', events: eventsOf(streamEvents) })),
    };
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(unusedManageSession(), startStream, hub, eventLog);

    // 第一阶段：先挂一个订阅者 + POST 触发一轮（同上 F1 主场景，致事件落日志）。
    const live = makeFakeSseRes();
    await controller.attachStream('sess-f1-replay', undefined, live.res as never);
    await controller.sendMessage('sess-f1-replay', { content: 'hi', model: 'm', providerId: 'p' });
    await waitForLog(eventLog, 'sess-f1-replay', N);
    await waitForFrames(live.frames, N);
    // 断开首个连接，避免它干扰第二阶段的补发读。
    live.close();

    // 第二阶段：另一客户端带 Last-Event-ID: 0 重连 → 应从头补发全部 N 条历史、每事件恰好一次。
    const replay = makeFakeSseRes();
    await controller.attachStream('sess-f1-replay', '0', replay.res as never);

    // 就地从帧里提取 (seq, type) 对（seqTypePairs helper 是 accept-7 块的局部函数，这里内联）。
    const replayPairs = replay.frames.map((f) => ({
      seq: Number(/^id: (\d+)/m.exec(f)?.[1]),
      type: /^event: (\S+)/m.exec(f)?.[1] ?? '',
    }));
    expect(replayPairs.length).toBe(N);
    expect(replayPairs.map((p) => p.seq)).toEqual([1, 2]);
    // 补发事件 type 序列与原生产一致、无重复 seq。
    expect(replayPairs.map((p) => p.type)).toEqual(['text', 'result']);
    const replaySeqs = replayPairs.map((p) => p.seq);
    expect(new Set(replaySeqs).size).toBe(N);

    // 让够异步时间窗，确认没有意外追加帧（修复前 listener 二次 append 产生的多余日志行
    //   会被后续补发读到，或实时衔接重复推送同一事件）。
    await settleTicks();
    expect(replay.frames.length).toBe(N);
  });
});

// ============================================================================
// accept-7 / SPEC CAP-7 —— Last-Event-ID 断线补发（从文件日志回放 seq 之后事件再接实时流）。
// 用真实 SessionSseHub + tmpdir FileEventLog 断言：
//   - 预置若干带 seq 的事件入日志 → 带 Last-Event-ID: k 连接 → 只收 seq>k 的事件、有序、不含 seq<=k；
//   - 无 Last-Event-ID / 非法值 → 从头补发全部历史（seq 从 1 起）；
//   - 补发完毕接实时流：衔接不丢不重（实时事件 seq 严格 > 补发末尾，去重成立）；
//   - 补发期间生产者未 publish 的事件（已在日志里）被回放，衔接实时新事件不重复。
// 纯文件日志 + 假中枢，不需真 AI。
// ============================================================================

describe('SessionStreamController —— GET /:id/stream Last-Event-ID 断线补发', () => {
  let baseDir: string;
  let eventLog: FileEventLog;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'accept7-'));
    eventLog = new FileEventLog(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  /** 造一个最小假 StartStream / ManageSession（accept-7 不应触发它们）。 */
  function unusedDeps() {
    const manageSession = {
      create: vi.fn(async () => fakeSession('unused')),
    } as unknown as ManageSessionUseCase;
    const startStream: StartStreamUseCase = {
      start: vi.fn(async () => ({ streamId: 'unused', events: eventsOf([]) })),
    };
    return { manageSession, startStream };
  }

  /** 预置若干事件入日志，返回分配到的 seq 列表。 */
  async function seedLog(sessionId: string, events: ReadonlyArray<AgentStreamEvent>): Promise<number[]> {
    const seqs: number[] = [];
    for (const e of events) {
      const { seq } = await eventLog.append(sessionId, e);
      seqs.push(seq);
    }
    return seqs;
  }

  /** 从一组 SSE 帧中提取 (seq, type) 对，保留顺序。 */
  function seqTypePairs(frames: string[]): Array<{ seq: number; type: string }> {
    return frames.map((f) => ({
      seq: Number(/^id: (\d+)/m.exec(f)?.[1]),
      type: /^event: (\S+)/m.exec(f)?.[1] ?? '',
    }));
  }

  it('带 Last-Event-ID: k → 只收 seq>k 的事件、有序、不含 seq<=k', async () => {
    const { manageSession, startStream } = unusedDeps();
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);
    const { res, frames } = makeFakeSseRes();

    // 预置 5 条历史事件（seq 1..5）。
    await seedLog('sess-replay', [
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
      { type: 'text', text: '三' },
      { type: 'text', text: '四' },
      { type: 'result' },
    ]);

    // 带 Last-Event-ID: 2 重连 → 应只补发 seq>2（即 3,4,5）。
    await controller.attachStream('sess-replay', '2', res as never);

    // 补发是同步 readAfter 后逐帧 res.write（attachStream await 返回时帧已写完）。
    expect(seqTypePairs(frames)).toEqual([
      { seq: 3, type: 'text' },
      { seq: 4, type: 'text' },
      { seq: 5, type: 'result' },
    ]);

    // 不含 seq<=2（即不回放一、二）。
    const seqs = seqTypePairs(frames).map((p) => p.seq);
    expect(seqs.every((s) => s > 2)).toBe(true);
  });

  it('无 Last-Event-ID → 从头补发全部历史（seq 从 1 起）', async () => {
    const { manageSession, startStream } = unusedDeps();
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);
    const { res, frames } = makeFakeSseRes();

    await seedLog('sess-full', [
      { type: 'text', text: '甲' },
      { type: 'result' },
    ]);

    // 无 header → 从头补发（约定：缺省按 0）。
    await controller.attachStream('sess-full', undefined, res as never);

    expect(seqTypePairs(frames)).toEqual([
      { seq: 1, type: 'text' },
      { seq: 2, type: 'result' },
    ]);
  });

  it('非法 Last-Event-ID（非整数 / 空串 / 负数前缀）→ 等价从头补发', async () => {
    const { manageSession, startStream } = unusedDeps();
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);

    await seedLog('sess-bad', [
      { type: 'text', text: 'x' },
      { type: 'result' },
    ]);

    for (const bad of ['', 'abc', '1.5', '-3', '7x']) {
      const { res, frames } = makeFakeSseRes();
      await controller.attachStream('sess-bad', bad, res as never);
      // 非法一律按 0 → 从头补发两条。
      expect(seqTypePairs(frames).map((p) => p.seq)).toEqual([1, 2]);
    }
  });

  it('补发完毕接实时流：衔接不丢不重（实时信封 seq 严格 > 补发末尾）', async () => {
    const { manageSession, startStream } = unusedDeps();
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);
    const { res, frames } = makeFakeSseRes();

    // 预置 seq 1..3 历史。
    await seedLog('sess-bridge', [
      { type: 'text', text: 'h1' },
      { type: 'text', text: 'h2' },
      { type: 'result' },
    ]);

    // 带 Last-Event-ID: 1 → 补发 seq 2,3。
    await controller.attachStream('sess-bridge', '1', res as never);
    expect(seqTypePairs(frames).map((p) => p.seq)).toEqual([2, 3]);

    // 补发完毕后切实时：对该会话 publish 两条【新】事件（信封携带 seq=4,5，模拟生产者侧 append 后广播）。
    //    listener 复用信封 seq（不再 append）；新 seq 严格 > maxSeq(=3)，去重判定通过，不丢；与历史不重复。
    hub.publish('sess-bridge', { seq: 4, event: { type: 'text', text: '新1' } });
    hub.publish('sess-bridge', { seq: 5, event: { type: 'result' } });
    await waitForFrames(frames, 4);

    expect(seqTypePairs(frames)).toEqual([
      // 补发历史（seq 2,3）。
      { seq: 2, type: 'text' },
      { seq: 3, type: 'result' },
      // 实时新事件（信封 seq 4,5）——衔接，不丢。
      { seq: 4, type: 'text' },
      { seq: 5, type: 'result' },
    ]);
    // 全程无重复 seq。
    const allSeqs = seqTypePairs(frames).map((p) => p.seq);
    expect(new Set(allSeqs).size).toBe(allSeqs.length);
  });

  it('补发期间已在日志里的事件被回放，不依赖实时 publish', async () => {
    const { manageSession, startStream } = unusedDeps();
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);
    const { res, frames } = makeFakeSseRes();

    // 预置 4 条事件后【不再 publish 任何实时事件】——验证补发纯靠日志回放。
    await seedLog('sess-pure-replay', [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
      { type: 'result' },
    ]);

    await controller.attachStream('sess-pure-replay', '1', res as never);

    // 只补发 seq>1（即 2,3,4），且后续无实时事件追加。
    expect(seqTypePairs(frames)).toEqual([
      { seq: 2, type: 'text' },
      { seq: 3, type: 'text' },
      { seq: 4, type: 'result' },
    ]);

    // 让够异步时间窗，确认没有意外追加帧（无实时 publish → 不应有新帧）。
    await settleTicks();
    expect(frames.length).toBe(3);
  });

  it('Last-Event-ID 大于等于文件末尾 seq → 不补发历史，仅接实时', async () => {
    const { manageSession, startStream } = unusedDeps();
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);
    const { res, frames } = makeFakeSseRes();

    await seedLog('sess-ahead', [
      { type: 'text', text: 'p1' },
      { type: 'result' },
    ]);

    // Last-Event-ID: 99（远大于文件末尾 seq=2）→ readAfter 无产出 → 直接接实时。
    await controller.attachStream('sess-ahead', '99', res as never);
    expect(frames.length).toBe(0);

    // 实时 publish 一条信封（seq=3，模拟生产者侧分配的新 seq）→ listener 复用该 seq 写帧。
    hub.publish('sess-ahead', { seq: 3, event: { type: 'text', text: 'live' } });
    await waitForFrames(frames, 1);

    expect(seqTypePairs(frames)).toEqual([{ seq: 3, type: 'text' }]);
  });

  it('不存在的会话（无日志）+ 无 Last-Event-ID → 不补发，直接接实时', async () => {
    const { manageSession, startStream } = unusedDeps();
    const hub = new SessionSseHub();
    const controller = new SessionStreamController(manageSession, startStream, hub, eventLog);
    const { res, frames } = makeFakeSseRes();

    await controller.attachStream('sess-empty', undefined, res as never);
    expect(frames.length).toBe(0);

    // 实时 publish 一条信封（seq=1）→ listener 复用 seq 写帧。
    hub.publish('sess-empty', { seq: 1, event: { type: 'text', text: '首条' } });
    await waitForFrames(frames, 1);
    expect(seqTypePairs(frames)).toEqual([{ seq: 1, type: 'text' }]);
  });
});

/**
 * 等待 listener 内异步 append（写链 + node:fs appendFile）落定后写帧。
 * append 涉及真实文件 I/O（首次访问 readFile 恢复末行 + mkdir + appendFile，多段异步），
 * 纯 setImmediate tick 数难以保证落定；改为确定性等待——轮询 frames 长度直到达到 expected
 * （含超时兜底，避免无限挂起）。
 */
async function waitForFrames(frames: string[], expected: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (frames.length < expected && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * 让出若干事件循环 tick（含 fs 宏任务），用于「断言某事件【不会】到达」的场景——
 * 等够异步 append 本应落定的时间窗，确认 frames 仍无增长，排除假阴性（事件其实还在路上）。
 */
async function settleTicks(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * 等待某会话文件日志落定到至少 expected 行（POST /:id/turn 的后台消费不阻塞 ack，
 * 消费期 append 是异步；这里轮询 readAfter 计数直到达到预期，含超时兜底）。
 */
async function waitForLog(
  log: FileEventLog,
  sessionId: string,
  expected: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  do {
    count = 0;
    for await (const _entry of log.readAfter(sessionId, 0)) {
      count++;
    }
    if (count >= expected) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (Date.now() < deadline);
}
