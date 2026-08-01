// conversation/usecases/get-session-history.ts
// C1 消息生命周期用例：GetSessionHistoryService。
// 对齐 architecture §6（编排）/§7（构造注入）。零框架 import，纯编排逻辑。
//
// 职责：
//   - getHistory：完整消息投影，按 createdAt 升序，供 UI 渲染（本故事 c1-5-3）。
//   - getPromptView：剔除 render-only 标记的 prompt 视图（占位，属 c1-5-4）。

import type {
  GetSessionHistoryUseCase,
  HistoryQuery,
} from '../ports/driving/get-session-history-usecase.js';
import type { MessageRepository } from '../ports/driven/message-repository.js';
import type { Message } from '../domain/message/message.js';

/**
 * GetSessionHistoryService：会话历史读取用例实现。
 *
 * 构造注入 MessageRepository（architecture §7）：核心不 new、不直调持久化。
 * 分页（limit/beforeRowId）由 MessageRepository.listBySession 负责（见其端口约定），
 * 用例只负责把查询透传下去、并按 createdAt 升序整理投影供 UI 渲染。
 */
export class GetSessionHistoryService implements GetSessionHistoryUseCase {
  constructor(private readonly messages: MessageRepository) {}

  /**
   * 完整消息投影：透传 HistoryQuery 给仓储做分页（limit/beforeRowId），
   * 再按 createdAt 升序整理返回（端口契约「按 createdAt/rowid 升序」）。
   *
   * 升序排序不改动仓储返回的元素本身，仅拷贝后排序，保持领域对象不可变。
   */
  async getHistory(query: HistoryQuery): Promise<ReadonlyArray<Message>> {
    const rows = await this.messages.listBySession(query);
    // 拷贝后升序排序：ES2019+ 稳定排序，createdAt 相等者保持仓储原有次序。
    return [...rows].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 喂给模型的 prompt 视图：在完整投影（getHistory 的升序结果）基础上剔除
   * render-only 标记消息，只保留真正进入模型上下文的消息（AC-9、architecture §4.4/§6）。
   *
   * 【剥离规则】（architecture 行 330 / §3.3 字段纪律）：
   *   1. isHeartbeatAck === true 的心跳应答消息——纯渲染侧噪音，剔除。
   *   2. taskRunId 有值（!== undefined）的消息——render-only join marker，剔除。
   * 二者满足其一即剔除；其余消息原样保留（不改动领域对象）。
   *
   * 与 getHistory 的差异（AC-9）：对含上述标记的消息，getHistory 全含、
   * getPromptView 剥离，故两者返回不同；纯普通消息时两者一致。
   */
  async getPromptView(query: HistoryQuery): Promise<ReadonlyArray<Message>> {
    const history = await this.getHistory(query);
    return history.filter(
      (m) => m.isHeartbeatAck !== true && m.taskRunId === undefined,
    );
  }
}
