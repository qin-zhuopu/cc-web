// apps/api/src/agent-runtime/controllers/runtime.controller.spec.ts
// RuntimeController 单测（c2-7-5）。用假 AgentRuntimePort spy 断言：
//   GET /api/runtime/availability → availability() 被调、结果忠实投影；
//   未注册 Runtime 显 unavailable / unknown，【绝不伪造 ready】（反假数据，PRD §0）。

import { describe, it, expect, vi } from 'vitest';
import type { AgentRuntimePort, RuntimeAvailability } from '@codepilot/core';
import { RuntimeController } from './runtime.controller.js';

/** 假 AgentRuntimePort：只 spy availability，其余方法占位（本测不触达）。 */
function makeFakeRuntime(availabilityResult: RuntimeAvailability) {
  const availabilitySpy = vi.fn(async (): Promise<RuntimeAvailability> => availabilityResult);
  const runtime: AgentRuntimePort = {
    run: () => {
      throw new Error('not used in this test');
    },
    interrupt: async () => null,
    forceKillTurn: () => {},
    availability: availabilitySpy,
    resolvePermission: () => {},
  };
  return { runtime, availabilitySpy };
}

describe('RuntimeController —— 可用性投影（反假数据）', () => {
  it('ready：忠实投影 availability() 的 ready + version', async () => {
    const { runtime, availabilitySpy } = makeFakeRuntime({ kind: 'ready', version: '1.2.3' });
    const controller = new RuntimeController(runtime);

    const res = await controller.availability();

    expect(availabilitySpy).toHaveBeenCalledOnce();
    expect(res).toEqual({ kind: 'ready', version: '1.2.3' });
  });

  it('unavailable：探测失败忠实投影 unavailable + reason，绝不伪造 ready', async () => {
    const { runtime } = makeFakeRuntime({ kind: 'unavailable', reason: 'no credentials' });
    const controller = new RuntimeController(runtime);

    const res = await controller.availability();

    expect(res).toEqual({ kind: 'unavailable', reason: 'no credentials' });
    expect(res.kind).not.toBe('ready');
  });

  it('unknown：未注册 / 无法判定时投影 unknown，不臆造 ready', async () => {
    const { runtime } = makeFakeRuntime({ kind: 'unknown' });
    const controller = new RuntimeController(runtime);

    const res = await controller.availability();

    expect(res).toEqual({ kind: 'unknown' });
    expect(res.kind).not.toBe('ready');
  });
});
