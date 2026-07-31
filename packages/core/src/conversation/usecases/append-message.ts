// conversation/usecases/append-message.ts
// C1 消息生命周期用例：AppendMessageService。
// 对齐 architecture §6（编排）/§7（构造注入）。零框架 import，纯编排逻辑。
//
// 职责：
//   - append：追加一条消息并用【同一个 now】touch 会话 updatedAt，
//     保证 message.createdAt 与会话 updatedAt 一致（AC-7 / NFR-7）。
//   - updateStreamStatus：推进持久生命周期（属 c1-5-2，本故事占位）。

import type {
  AppendMessageInput,
  AppendMessageUseCase,
} from '../ports/driving/append-message-usecase.js';
import type { MessageRepository } from '../ports/driven/message-repository.js';
import type { SessionRepository } from '../ports/driven/session-repository.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { Message, MessageId } from '../domain/message/message.js';
import type { StreamStatus } from '../domain/message/stream-status.js';
import { canTransition } from '../domain/message/stream-status.js';
import type { TokenUsage } from '../domain/message/token-usage.js';

/**
 * AppendMessageService：追加消息 + 推进持久生命周期用例实现。
 *
 * 构造注入四端口（architecture §7）：核心不 new、不直调系统时钟/随机源。
 */
export class AppendMessageService implements AppendMessageUseCase {
  constructor(
    private readonly messages: MessageRepository,
    private readonly sessions: SessionRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  /**
   * 追加消息：id←IdGenerator、now←Clock（只取一次），构造 Message 后落库，
   * 再用【同一 now】touch 会话 updatedAt——严禁对 touch 再取一次时钟，
   * 以保证 createdAt 与会话 updatedAt 严格一致（AC-7 / NFR-7）。
   */
  async append(input: AppendMessageInput): Promise<Message> {
    const id = this.idGenerator.next();
    // 只取一次时刻，createdAt 与随后 touch 的 updatedAt 复用同一值。
    const now = this.clock.now();

    // streamStatus 初值取自 input；缺省按持久语义定 'completed'。
    const streamStatus: StreamStatus = input.streamStatus ?? 'completed';
    // 【不变式守卫，architecture §3.3】非 assistant 消息恒 completed——只有 assistant
    // 才有流式生命周期。append 是 Message 唯一构造点，此处拦截 role/streamStatus 的非法
    // 组合（如 user + streaming），防止产出永停 streaming 的 user 消息、被 updateStreamStatus
    // 误推进而绕过「只有 assistant 有生命周期」边界。
    if (input.role !== 'assistant' && streamStatus !== 'completed') {
      throw new Error(
        `append：非 assistant 消息的 streamStatus 恒为 completed（role=${input.role}, streamStatus=${streamStatus}）`,
      );
    }

    // 逐字段构造：可选投影无值一律 undefined，绝不落假 0/假空串（AC-10）。
    const message: Message = {
      id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: now,
      streamStatus,
      // 心跳应答渲染标记：缺省 false。
      isHeartbeatAck: input.isHeartbeatAck ?? false,
      // tokenUsage / taskRunId 为可选投影：有值原样保留，无值保持 undefined。
      ...(input.tokenUsage !== undefined ? { tokenUsage: input.tokenUsage } : {}),
      ...(input.taskRunId !== undefined ? { taskRunId: input.taskRunId } : {}),
    };

    await this.messages.append(message);
    // 复用同一 now touch 会话，保证 createdAt === 会话 updatedAt。
    await this.sessions.touch(input.sessionId, now);

    return message;
  }

  /**
   * 推进 assistant 消息的持久生命周期：streaming → completed/interrupted/error
   * （及 streaming→streaming 幂等），任一终态迁出一律拒绝（FR-4.2/4.3、AC-8）。
   *
   * 编排：先按 id 读回现值 → 用 domain 的 canTransition(from, to) 守卫
   * （绝不在用例重写迁移规则、绝不绕过守卫裸写）：
   *   - 合法 → 委托 MessageRepository.updateStreamStatus（tokenUsage 只透传，
   *     无值不更新用量、不落假 0，AC-10）；
   *   - 非法（终态迁出）→ 抛错拒绝，不写库。
   * 消息不存在（getById 返回 undefined）→ 抛错，同样不写库。
   */
  async updateStreamStatus(
    messageId: MessageId,
    status: StreamStatus,
    tokenUsage?: TokenUsage,
  ): Promise<void> {
    const current = await this.messages.getById(messageId);
    if (current === undefined) {
      throw new Error(`updateStreamStatus：消息不存在（id=${messageId}）`);
    }

    // 生命周期迁移守卫：一律经 domain 的 canTransition 判定，用例不重写规则。
    if (!canTransition(current.streamStatus, status)) {
      throw new Error(
        `updateStreamStatus：非法生命周期迁移（${current.streamStatus} → ${status}），终态不可回退`,
      );
    }

    // 合法才写库；tokenUsage 只透传（无值则不传、不补 0）。
    await this.messages.updateStreamStatus(messageId, status, tokenUsage);
  }
}
