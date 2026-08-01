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
    // 预先挂一个订阅者（模拟另一个 GET /:id/stream 连接）。
    const received: AgentStreamEvent[] = [];
    hub.subscribe('sess-bc', (e) => received.push(e));

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

    expect(received).toEqual([
      { type: 'text', text: 'X' },
      { type: 'result' },
    ]);
  });
});
