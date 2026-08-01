// apps/api/src/agent-runtime/controllers/chat.controller.spec.ts
// ChatController 单测（c2-7-5）。用假驱动用例 spy 断言：
//   POST /api/chat → StartStreamUseCase.start 被调、入参忠实透传、归一事件逐条写为 SSE 帧（透传不伪造）；
//   POST /api/chat/interrupt → AbortStreamUseCase.abort 被调、streamId 透传。

import { describe, it, expect, vi } from 'vitest';
import type {
  StartStreamUseCase,
  StartStreamInput,
  StartStreamResult,
  AbortStreamUseCase,
  AgentStreamEvent,
} from '@codepilot/core';
import { ChatController } from './chat.controller.js';

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
  return {
    res,
    frames,
    getHead: () => head,
    isEnded: () => ended,
  };
}

describe('ChatController —— 回合发起（SSE）/ 中断', () => {
  it('POST /api/chat：start 被调、入参忠实透传、事件逐条写为 SSE 帧', async () => {
    const streamEvents: ReadonlyArray<AgentStreamEvent> = [
      { type: 'text', text: '你好' },
      { type: 'result' },
    ];
    const startSpy = vi.fn(
      async (_input: StartStreamInput): Promise<StartStreamResult> => ({
        streamId: 'stream-1',
        events: eventsOf(streamEvents),
      }),
    );
    const startStream: StartStreamUseCase = { start: startSpy };
    const abortStream: AbortStreamUseCase = { abort: vi.fn(async () => {}) };
    const controller = new ChatController(startStream, abortStream);
    const { res, frames, getHead, isEnded } = makeFakeRes();

    await controller.start(
      {
        sessionId: 'sess-1',
        content: '请帮我写代码',
        mode: 'code',
        model: 'claude-sonnet-4-5',
        providerId: 'anthropic-1',
      },
      res as never,
    );

    // start 被调一次，入参必填字段忠实透传、未提供可选字段不出现（反假数据）。
    expect(startSpy).toHaveBeenCalledOnce();
    const passed = startSpy.mock.calls[0]![0]!;
    expect(passed).toEqual({
      sessionId: 'sess-1',
      content: '请帮我写代码',
      mode: 'code',
      model: 'claude-sonnet-4-5',
      providerId: 'anthropic-1',
    });

    // SSE 响应头就位。
    expect(getHead()?.status).toBe(200);
    expect(getHead()?.headers['Content-Type']).toBe('text/event-stream');

    // 首帧透传 streamId；随后归一事件逐条写帧（type 作 event 名、整条事件作 data，透传不伪造）。
    expect(frames[0]).toBe(
      `event: stream_started\ndata: ${JSON.stringify({ streamId: 'stream-1' })}\n\n`,
    );
    expect(frames[1]).toBe(`event: text\ndata: ${JSON.stringify({ type: 'text', text: '你好' })}\n\n`);
    expect(frames[2]).toBe(`event: result\ndata: ${JSON.stringify({ type: 'result' })}\n\n`);
    expect(isEnded()).toBe(true);
  });

  it('POST /api/chat：可选字段（thinking/context1m 等）存在时忠实透传', async () => {
    const startSpy = vi.fn(
      async (_input: StartStreamInput): Promise<StartStreamResult> => ({
        streamId: 'stream-2',
        events: eventsOf([]),
      }),
    );
    const controller = new ChatController(
      { start: startSpy },
      { abort: vi.fn(async () => {}) },
    );
    const { res } = makeFakeRes();

    await controller.start(
      {
        sessionId: 'sess-2',
        content: 'hi',
        mode: 'ask',
        model: 'm',
        providerId: 'p',
        thinking: { type: 'enabled', budgetTokens: 2048 },
        context1m: true,
        selectedSkills: ['skill-a'],
        autoTrigger: false,
      },
      res as never,
    );

    const passed = startSpy.mock.calls[0]![0]!;
    expect(passed).toEqual({
      sessionId: 'sess-2',
      content: 'hi',
      mode: 'ask',
      model: 'm',
      providerId: 'p',
      thinking: { type: 'enabled', budgetTokens: 2048 },
      context1m: true,
      selectedSkills: ['skill-a'],
      autoTrigger: false,
    });
  });

  it('POST /api/chat/interrupt：abort 被调、streamId 透传', async () => {
    const abortSpy = vi.fn(async (_streamId: string) => {});
    const controller = new ChatController(
      { start: vi.fn() as unknown as StartStreamUseCase['start'] },
      { abort: abortSpy },
    );

    const res = await controller.interrupt({ streamId: 'stream-9' });

    expect(res).toEqual({ ok: true });
    expect(abortSpy).toHaveBeenCalledOnce();
    expect(abortSpy).toHaveBeenCalledWith('stream-9');
  });
});
