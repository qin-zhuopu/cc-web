// apps/api/src/agent-runtime/adapters/session-sse-hub.ts
// 按会话（per-session）的 SSE 广播中枢 —— 纯内存 fan-out（epic-accept / accept-2，SPEC CAP-2）。
//
// 【为何存在】一次 POST /messages 触发的回合，其归一事件要广播给所有挂在该会话 stream 上的
//   连接（sprint-plan §二）。本中枢维护 sessionId → Set<订阅者> 索引：回合事件经 publish
//   fan-out 到该会话每个活跃订阅者（每个 GET /:id/stream 连接一个 listener）；连接关闭时经
//   subscribe 返回的退订函数从集合摘除，集合空时清理该 sessionId 条目不泄漏。
//
// 【一式三份中的第一份】本中枢只负责「SSE 实时推」的 fan-out 分发；seq 分配属文件事件日志
//   （CAP-3 file-event-log），最终落库属 C1 存消息用例（c2-7 接线）——三者落点分离，中枢不碰。
//
// 【铁律】纯内存、非持久层、非核心：进程重启即空，绝不进 packages/core，绝不与持久层
//   （C1 StreamStatus / SQLite）或 C2 内存 phase 混用。本文件在 apps/api（框架层），
//   只 import type 核心事件类型，不含任何框架/持久依赖。
//
// 【best-effort fan-out】某订阅者 listener 抛错不阻断对其他订阅者的派发（隔离单个坏连接，
//   避免一个连接的写失败拖垮同会话其它连接）。

import type { AgentStreamEvent } from '@codepilot/core';

/**
 * SealedStreamEvent —— 已落盘并分配好 seq 的广播事件信封。
 *
 * 【为何带 seq】seq 必须由【生产者侧】（发起回合、消费 events 流的那一侧）在 FileEventLog.append
 *   时分配【唯一一次】。若 GET /:id/stream 的订阅者 listener 再 append 一次，同一事件会被写进
 *   日志 N+1 行、分配 N+1 个不同 seq，破坏「一行一事件」与断线补发「不丢不重」（见评审 F1）。
 *   故 publish 携带 { seq, event }，listener 直接复用收到的 seq 写 SSE 帧，绝不二次 append。
 */
export interface SealedStreamEvent {
  /** 该事件在会话内单调递增的序号（== 文件日志 seq == SSE id 字段 == 断线重连游标）。 */
  readonly seq: number;
  /** 归一事件本体（透传不伪造）。 */
  readonly event: AgentStreamEvent;
}

/**
 * SessionEventListener —— 单个 SSE 连接的事件回调。
 * 每个挂载到某会话的 GET /:id/stream 连接注册一个 listener；收到 { seq, event } 即写入该连接的 SSE 流。
 */
export type SessionEventListener = (sealed: SealedStreamEvent) => void;

/**
 * SessionSseHub —— 按会话的内存广播中枢。
 *
 * - subscribe(sessionId, listener)：登记订阅者，返回退订函数（幂等：重复调用不抛、不误删他人）。
 * - publish(sessionId, event)：fan-out 到该会话所有活跃订阅者；best-effort，单个 listener 抛错不阻断其余。
 *
 * 无订阅者的 sessionId 不在索引中保留条目（退订最后一个订阅者即清理），避免内存泄漏。
 */
export class SessionSseHub {
  // sessionId → 该会话的活跃订阅者集合。Set 保证同一 listener 不重复登记，并支持 O(1) 摘除。
  private readonly subscribers = new Map<string, Set<SessionEventListener>>();

  /**
   * 订阅某会话的广播事件。
   *
   * @returns 退订函数：调用后该 listener 不再收到事件；若为该会话最后一个订阅者，清理会话条目。
   *   退订函数幂等——重复调用安全，且只摘除本次登记的 listener。
   */
  subscribe(sessionId: string, listener: SessionEventListener): () => void {
    let listeners = this.subscribers.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set<SessionEventListener>();
      this.subscribers.set(sessionId, listeners);
    }
    listeners.add(listener);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      const current = this.subscribers.get(sessionId);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      // 无订阅者时清理条目，不泄漏 sessionId → 空 Set。
      if (current.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  /**
   * 向某会话的所有活跃订阅者 fan-out 一个【已落盘分配好 seq】的事件。
   *
   * 调用方须先经 FileEventLog.append 拿到 seq，再以 { seq, event } 信封广播——保证每事件只 append
   * 一次（seq 单一分配，杜绝评审 F1 的双重 append 致补发重复）。
   *
   * best-effort：单个 listener 抛错被吞并继续派发其余订阅者，不让一个坏连接影响同会话其它连接。
   * 无订阅者时静默返回（回合事件仍会经文件日志持久，补发时可回放）。
   *
   * 派发前对订阅者集合做快照，避免 listener 在派发过程中订阅/退订导致的迭代器失效。
   */
  publish(sessionId: string, sealed: SealedStreamEvent): void {
    const listeners = this.subscribers.get(sessionId);
    if (listeners === undefined || listeners.size === 0) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(sealed);
      } catch {
        // best-effort：吞掉单个订阅者的错误，继续派发其余订阅者。
      }
    }
  }
}
