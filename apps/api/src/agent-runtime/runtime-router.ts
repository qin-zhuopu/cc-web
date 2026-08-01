// apps/api/src/agent-runtime/runtime-router.ts
// C2 · RuntimeRouter —— 按 RuntimeKind 路由到具体适配器，实现核心 AgentRuntimePort（epic-c2-6 / c2-6-6，对齐 architecture §7/§8）。
//
// 【边界】本文件在 apps/api（框架层）。只 import type 核心端口/类型 + 值 import RuntimeKind 枚举 + ErrorCode；
//   绝不污染 packages/core。
//
// 【本期范围】只注册 CLAUDE_SDK → ClaudeSdkRuntimeAdapter；NATIVE/CODEX 未注册（deferred，接口/路由位保留）。
//   路由到未注册 Runtime → fail-fast 归 ClassifiedError（不静默返回空、不卡死核心，NFR-4）。
//
// 【turnRef 定位 runtimeKind】interrupt/forceKillTurn 的 turnRef 只含 streamId，不带 runtimeKind。
//   router 在 run 时记录 streamId → runtimeKind，供后续按 turnRef 定位对应适配器。回合终态/中断后清除。

import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  TurnRef,
  AgentStreamEvent,
  RuntimeAvailability,
  ErrorClassifier,
  PermissionDecision,
} from '@codepilot/core';
import { RuntimeKind } from '@codepilot/core';

/** RuntimeKind → 适配器映射（本期只有 CLAUDE_SDK）。未注册的 kind 缺省不在表中。 */
export type RuntimeAdapterMap = Partial<Record<RuntimeKind, AgentRuntimePort>>;

/**
 * RuntimeRouter —— 实现 AgentRuntimePort，按 RuntimeKind 委派到具体适配器。
 */
export class RuntimeRouter implements AgentRuntimePort {
  private readonly adapters: RuntimeAdapterMap;
  private readonly errorClassifier: ErrorClassifier;
  /** streamId → 该回合发起时锁定的 RuntimeKind，供 interrupt/forceKillTurn 按 turnRef 定位适配器。 */
  private readonly streamRuntimeKind = new Map<string, RuntimeKind>();

  /**
   * @param adapters        已注册的 RuntimeKind → 适配器映射（本期 { [CLAUDE_SDK]: claudeSdkAdapter }）。
   * @param errorClassifier SK.ErrorClassifier（未注册 Runtime fail-fast 归一）。
   */
  constructor(adapters: RuntimeAdapterMap, errorClassifier: ErrorClassifier) {
    this.adapters = adapters;
    this.errorClassifier = errorClassifier;
  }

  /**
   * 按 request.runtimeKind 路由到对应适配器发起调用。
   * 未注册 Runtime → fail-fast：产出一个归一的 error 事件（不静默、不卡死；核心据此 fail 翻终态）。
   */
  run(request: RuntimeRunRequest): AsyncIterable<AgentStreamEvent> {
    const adapter = this.adapters[request.runtimeKind];
    if (adapter === undefined) {
      return this.failFastStream(request.runtimeKind);
    }
    // 记录 streamId → runtimeKind，供 interrupt/forceKillTurn 定位。
    this.streamRuntimeKind.set(request.streamId, request.runtimeKind);
    const inner = adapter.run(request);
    // 包一层，在流结束时清除 streamId 映射（防泄漏）。
    return this.trackStream(request.streamId, inner);
  }

  /**
   * 优雅中断：按 turnRef.streamId 定位其 runtimeKind → 委派对应适配器。
   * 无记录（未知/已清除）→ 返回 null（幂等，交核心 force-abort 兜底）。
   */
  async interrupt(turnRef: TurnRef): Promise<string | null> {
    const adapter = this.adapterForStream(turnRef.streamId);
    if (adapter === undefined) {
      return null;
    }
    return adapter.interrupt(turnRef);
  }

  /**
   * 强制关闭 turn：按 turnRef.streamId 定位适配器委派。无记录 → no-op（不抛）。
   */
  forceKillTurn(turnRef: TurnRef): void {
    const adapter = this.adapterForStream(turnRef.streamId);
    if (adapter === undefined) {
      return;
    }
    adapter.forceKillTurn(turnRef);
    this.streamRuntimeKind.delete(turnRef.streamId);
  }

  /**
   * 【c2-7 扩展 · CAP-2】权限决议中转：按 turnRef.streamId 定位其适配器委派 resolvePermission。
   * 忠实转发上层决议（C2 不裁决、不做经纪判定）。无记录（未知/已清除）→ no-op（不抛，决议已无对应在途回合）。
   */
  async resolvePermission(turnRef: TurnRef, decision: PermissionDecision): Promise<void> {
    const adapter = this.adapterForStream(turnRef.streamId);
    if (adapter === undefined) {
      return;
    }
    await adapter.resolvePermission(turnRef, decision);
  }

  /**
   * 可用性聚合（非 spawn）：已注册适配器返回其 availability；未注册的 RuntimeKind 标 unavailable（反假数据，不显假 ready）。
   * 返回按 RuntimeKind 的可用性映射投影（此处返回已注册项的聚合——本期只有 CLAUDE_SDK）。
   */
  async availability(): Promise<RuntimeAvailability> {
    // 本期只有一个已注册 Runtime，直接返回其可用性；缺任何已注册适配器则 unknown。
    const claude = this.adapters[RuntimeKind.CLAUDE_SDK];
    if (claude !== undefined) {
      return claude.availability();
    }
    return { kind: 'unknown' };
  }

  /** 按 streamId 查其 runtimeKind 对应的已注册适配器；无则 undefined。 */
  private adapterForStream(streamId: string): AgentRuntimePort | undefined {
    const kind = this.streamRuntimeKind.get(streamId);
    if (kind === undefined) {
      return undefined;
    }
    return this.adapters[kind];
  }

  /** 未注册 Runtime 的 fail-fast 事件流：产出一个归一 error 事件（不静默、不卡死核心）。 */
  private async *failFastStream(kind: RuntimeKind): AsyncIterableIterator<AgentStreamEvent> {
    const classified = this.errorClassifier.classify(
      new Error(`RuntimeKind "${kind}" 未注册适配器（本期只实现 CLAUDE_SDK；Native/Codex deferred）`),
    );
    yield { type: 'error', error: classified };
  }

  /** 包裹内层事件流，在结束时清除 streamId → runtimeKind 映射（防泄漏）。 */
  private async *trackStream(
    streamId: string,
    inner: AsyncIterable<AgentStreamEvent>,
  ): AsyncIterableIterator<AgentStreamEvent> {
    try {
      for await (const event of inner) {
        yield event;
      }
    } finally {
      this.streamRuntimeKind.delete(streamId);
    }
  }
}
