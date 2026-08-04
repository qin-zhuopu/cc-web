// agent-runtime/usecases/stream-session-registry.ts
// C2 · AgentRuntime —— 活跃回合内存注册表 StreamSessionRegistry（对齐 architecture §2 目录 / §8 DI、SPEC CAP-1）。
//
// 【本故事（c2-4-1）范围】落地承载「活跃回合索引」的纯内存注册表：register/get/getActiveBySession/delete。
// 供 StartStreamService 在发起回合时登记新 StreamSession、查同一 C1 会话是否已有 active 回合（单 active 约束，CAP-4）。
//
// 【边界纪律 · 铁律 NFR-2 / AC-15 · 非持久层】
// 本注册表是**内存**索引（Map），绝不落库、绝不 import C1 的持久 StreamStatus 做实时判断。
// 活跃与否一律经 StreamSession.snapshot().phase 的实时相位（isActive）判断，不读任何持久态。
// 「同一 session 至多一个 active 回合」的不变量由 StartStreamService 编排保证（CAP-4）；
// 本注册表只提供查询/登记/移除的最小索引 API，不自行做迁移或去重。
//
// 【铁律 · 核心零框架】本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process / uuid；不直调系统时钟、不生成 id（登记的 StreamSession 已自带 id）。
// 类型-only import 用 import type + .js 扩展名（verbatimModuleSyntax），值 import 走普通 import。

import type { StreamSession } from '../domain/stream/stream-session.js';
import type { StreamSessionId } from '../domain/stream/stream-phase.js';
import { isActive } from '../domain/stream/stream-phase.js';

/**
 * StreamSessionRegistry —— 活跃回合的纯内存索引（对齐 architecture §8：InMemoryStreamSessionRegistry）。
 *
 * 内部以 Map<StreamSessionId, StreamSession> 承载已登记回合；活跃与否按实时 phase 判断，
 * 终态/收尾中的回合在被 delete 前仍留在 Map（get 仍可取到），但 getActiveBySession 只回 active 者。
 *
 * 非持久层：无 Clock 依赖、无 id 生成、无落库路径。
 */
export class StreamSessionRegistry {
  /** 主索引：streamId → 已登记的 StreamSession（内存态）。 */
  private readonly byStreamId: Map<StreamSessionId, StreamSession> = new Map();

  /**
   * 登记一个 StreamSession（发起回合时调用）。
   * 以 session.snapshot().id 为键；同 id 重复登记会覆盖（正常流程 id 唯一，来自注入的 IdGenerator）。
   */
  register(session: StreamSession): void {
    this.byStreamId.set(session.snapshot().id, session);
  }

  /**
   * 按 streamId 取回已登记的 StreamSession；未登记返回 undefined。
   */
  get(streamId: StreamSessionId): StreamSession | undefined {
    return this.byStreamId.get(streamId);
  }

  /**
   * 返回指定 C1 会话当前处于 active 相位的回合；无 active 回合返回 undefined。
   *
   * 活跃判断经 snapshot().phase 的 isActive（实时内存相位），不读任何持久 StreamStatus（NFR-2 / AC-15）。
   * 用于 StartStreamService 的单 active 约束：发起新回合前查旧 active 回合以先行 abort（CAP-4）。
   * 依赖不变量「同一 session 至多一个 active 回合」（由编排层保证），命中首个即返回。
   */
  getActiveBySession(sessionId: string): StreamSession | undefined {
    for (const session of this.byStreamId.values()) {
      const snapshot = session.snapshot();
      if (snapshot.sessionId === sessionId && isActive(snapshot.phase)) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * 从注册表移除指定 streamId 的回合；不存在时静默 no-op。
   * 移除只从内存索引摘除，不涉及落库/终态迁移（终态迁移属聚合根方法，由编排层调用）。
   */
  delete(streamId: StreamSessionId): void {
    this.byStreamId.delete(streamId);
  }
}
