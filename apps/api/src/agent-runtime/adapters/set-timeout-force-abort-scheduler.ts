// apps/api/src/agent-runtime/adapters/set-timeout-force-abort-scheduler.ts
// C2 · SetTimeoutForceAbortScheduler —— force-abort 安全网延时调度的 setTimeout 生产实现
//   （epic-c2-7 / c2-7-3，对齐 SPEC CAP-5、architecture §4.2 clock-based-timeout）。
//
// 【边界】本文件在 apps/api（框架/基础设施层），允许 import/直调 setTimeout / clearTimeout，
//   不受 packages/core 零框架铁律约束。核心侧只依赖抽象端口 ForceAbortScheduler（c2-5 定义），
//   AbortStreamService 经构造第 3 参注入本实现（接线在 c2-7-4 的 AgentRuntimeModule）。
//   本适配器把「真实延时到期触发」这一副作用锁在框架层，核心保持纯净、可用假 Clock/假件测试。
//
// 【契约】schedule(callback, delayMs) 经 setTimeout 安排 delayMs 后触发 callback，返回 cancel 函数；
//   cancel 经 clearTimeout 取消尚未到期的安排；已到期/已触发后再 cancel 为 no-op（不抛）。

import type { ForceAbortScheduler } from '@codepilot/core';

/**
 * SetTimeoutForceAbortScheduler —— 基于 setTimeout 的 ForceAbortScheduler 生产实现。
 *
 * schedule 返回的 cancel 函数幂等：首次调用经 clearTimeout 取消未到期的 timer；
 * 若 callback 已触发或 cancel 已调用过，再次调用为 no-op（不重复 clear、不抛）。
 */
export class SetTimeoutForceAbortScheduler implements ForceAbortScheduler {
  schedule(callback: () => void, delayMs: number): () => void {
    let cancelled = false;
    const timer = setTimeout(() => {
      // 标记已触发：到期后再 cancel 即成 no-op。
      cancelled = true;
      callback();
    }, delayMs);

    return () => {
      // 已到期/已触发/已取消：no-op，不重复 clearTimeout、不抛。
      if (cancelled) {
        return;
      }
      cancelled = true;
      clearTimeout(timer);
    };
  }
}
