// conversation/ports/driving/set-session-title-usecase.ts
// C1 驱动端口：会话标题设置用例入口（仅签名骨架）。
// 对齐 architecture §4.2。零框架 import；实现属 c1-4。

import type { ChatSession, SessionId } from '../../domain/session/chat-session.js';

/**
 * SetSessionTitleUseCase：会话标题设置驱动端口（对外提供）。
 *
 * 覆盖优先级遵循 TitleOrigin：default < ai < user（见 domain/session/title-origin.ts）。
 * 仅签名骨架，无实现体——编排逻辑（调 C2.TitleGenerator + origin 状态机）落地属 c1-4。
 */
export interface SetSessionTitleUseCase {
  /** 用户手改：写入并标 titleOrigin='user'（此后 AI 不可再覆盖）。 */
  setByUser(id: SessionId, title: string): Promise<ChatSession>;
  /**
   * AI 生成：调 C2.TitleGenerator 拿标题，仅当当前 origin ∈ {default, ai} 时写入并标 'ai'。
   * TitleGenerator 失败/不可用 → 保留现有标题，不抛、不写库（降级，FR-2.4）。
   */
  generateByAi(id: SessionId): Promise<ChatSession>;
}
