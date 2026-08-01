// conversation/ports/driving/get-session-history-usecase.ts
// C1 驱动端口：会话历史读取用例入口（仅签名骨架）。
// 对齐 architecture §4.4。零框架 import；实现属 c1-5。

import type { SessionId } from '../../domain/session/chat-session.js';
import type { Message } from '../../domain/message/message.js';

/**
 * 历史查询条件。
 * beforeRowId 为分页边界（适配器以 rowid 提供稳定游标），缺省取最新一页。
 */
export interface HistoryQuery {
  /** 目标会话 id。 */
  readonly sessionId: SessionId;
  /** 返回条数上限。缺省由用例/适配器定默认页大小。 */
  readonly limit?: number;
  /** 分页游标：仅取 rowid 小于此值的更早消息。缺省取最新页。 */
  readonly beforeRowId?: number;
}

/**
 * GetSessionHistoryUseCase：会话历史读取驱动端口（对外提供）。
 *
 * 仅签名骨架，无实现体——投影/过滤编排落地属 c1-5。
 */
export interface GetSessionHistoryUseCase {
  /** 完整消息投影（按 createdAt/rowid 升序），供 UI 渲染。 */
  getHistory(query: HistoryQuery): Promise<ReadonlyArray<Message>>;
  /**
   * 喂给模型的 prompt 视图：剔除 render-only 标记
   * （isHeartbeatAck / taskRunId 关联的 marker），
   * 只保留真正进入上下文的消息（FR-4.6 / AC-9）。
   */
  getPromptView(query: HistoryQuery): Promise<ReadonlyArray<Message>>;
}
