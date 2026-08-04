// apps/api/src/agent-runtime/controllers/permission.controller.spec.ts
// PermissionController 单测（c2-7-2）。用假 AgentRuntimePort spy 断言：
//   给定决议 → resolvePermission 被调；permissionRequestId/status/updatedInput/denyMessage 忠实透传；
//   C2 未篡改、未裁决（无自动批准/超时策略）。

import { describe, it, expect, vi } from 'vitest';
import type { AgentRuntimePort, PermissionDecision, TurnRef } from '@codepilot/core';
import { PermissionController } from './permission.controller.js';

/** 假 AgentRuntimePort：只 spy resolvePermission，其余方法占位（本测不触达）。 */
function makeFakeRuntime() {
  const resolveSpy = vi.fn(async (_ref: TurnRef, _d: PermissionDecision) => {});
  const runtime: AgentRuntimePort = {
    run: () => {
      throw new Error('not used in this test');
    },
    interrupt: async () => null,
    forceKillTurn: () => {},
    availability: async () => ({ kind: 'unknown' as const }),
    resolvePermission: resolveSpy as unknown as AgentRuntimePort['resolvePermission'],
  };
  return { runtime, resolveSpy };
}

describe('PermissionController —— 权限决议忠实中转', () => {
  it('allow + updatedInput：resolvePermission 被调，streamId 与决议忠实透传', async () => {
    const { runtime, resolveSpy } = makeFakeRuntime();
    const controller = new PermissionController(runtime);

    const res = await controller.resolve({
      streamId: 's-1',
      permissionRequestId: 'p-1',
      status: 'allow',
      updatedInput: { path: '/tmp/x' },
    });

    expect(res).toEqual({ ok: true });
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(resolveSpy).toHaveBeenCalledWith(
      { streamId: 's-1' },
      {
        permissionRequestId: 'p-1',
        status: 'allow',
        updatedInput: { path: '/tmp/x' },
      },
    );
  });

  it('deny + denyMessage：忠实透传，C2 不篡改不裁决', async () => {
    const { runtime, resolveSpy } = makeFakeRuntime();
    const controller = new PermissionController(runtime);

    await controller.resolve({
      streamId: 's-2',
      permissionRequestId: 'p-2',
      status: 'deny',
      denyMessage: '用户拒绝写文件',
    });

    expect(resolveSpy).toHaveBeenCalledWith(
      { streamId: 's-2' },
      {
        permissionRequestId: 'p-2',
        status: 'deny',
        denyMessage: '用户拒绝写文件',
      },
    );
  });

  it('allow_session 无可选字段：不预填假默认（只带 permissionRequestId + status）', async () => {
    const { runtime, resolveSpy } = makeFakeRuntime();
    const controller = new PermissionController(runtime);

    await controller.resolve({
      streamId: 's-3',
      permissionRequestId: 'p-3',
      status: 'allow_session',
    });

    const [ref, decision] = resolveSpy.mock.calls[0] as [TurnRef, PermissionDecision];
    expect(ref).toEqual({ streamId: 's-3' });
    // 未提供的可选字段不出现（反假数据，不填 undefined 键之外的假值）。
    expect(decision).toEqual({ permissionRequestId: 'p-3', status: 'allow_session' });
    expect('updatedInput' in decision).toBe(false);
    expect('denyMessage' in decision).toBe(false);
  });
});
