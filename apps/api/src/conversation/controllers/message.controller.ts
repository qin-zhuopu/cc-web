// apps/api/src/conversation/controllers/message.controller.ts
// C1 驱动适配器：消息 REST 控制器（epic-c1-6 / c1-6-2，对齐 architecture §7）。
//
// 【安全提醒】无鉴权/无访问控制，仅限本机单机运行，勿暴露公网（同 session.controller.ts）。
//
// 边界：只注入用例 token，不碰仓储（c1-6-4 契约）。content 经 core.textContent 从纯文本构造，
//   富内容块（tool_use/thinking 等）由上游 C2 落库路径提供，本 REST 入口只接纯文本用户消息。
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { textContent } from '@codepilot/core';
import type {
  AppendMessageUseCase,
  GetSessionHistoryUseCase,
  Message,
  MessageRole,
  StreamStatus,
} from '@codepilot/core';
import {
  APPEND_MESSAGE_USECASE,
  GET_SESSION_HISTORY_USECASE,
} from '../conversation.tokens.js';

/** 追加消息请求体：文本消息（富内容块走 C2 落库路径，不经此 REST 入口）。 */
interface AppendMessageBody {
  role: MessageRole;
  text: string;
  streamStatus?: StreamStatus;
  isHeartbeatAck?: boolean;
  taskRunId?: string;
}

/** 推进流式状态请求体。 */
interface PatchStatusBody {
  streamStatus: StreamStatus;
}

@Controller('api')
export class MessageController {
  constructor(
    @Inject(APPEND_MESSAGE_USECASE)
    private readonly appendMessage: AppendMessageUseCase,
    @Inject(GET_SESSION_HISTORY_USECASE)
    private readonly history: GetSessionHistoryUseCase,
  ) {}

  /** GET /api/sessions/:id/messages?limit=50&beforeRowId=100 —— 会话历史（升序，完整投影）。 */
  @Get('sessions/:id/messages')
  async list(
    @Param('id') sessionId: string,
    @Query('limit') limit?: string,
    @Query('beforeRowId') beforeRowId?: string,
  ): Promise<ReadonlyArray<Message>> {
    return this.history.getHistory({
      sessionId,
      ...(limit === undefined ? {} : { limit: Number(limit) }),
      ...(beforeRowId === undefined ? {} : { beforeRowId: Number(beforeRowId) }),
    });
  }

  /** POST /api/sessions/:id/messages —— 追加一条文本消息（并 touch 会话）。 */
  @Post('sessions/:id/messages')
  async append(
    @Param('id') sessionId: string,
    @Body() body: AppendMessageBody,
  ): Promise<Message> {
    return this.appendMessage.append({
      sessionId,
      role: body.role,
      content: textContent(body.text),
      ...(body.streamStatus === undefined
        ? {}
        : { streamStatus: body.streamStatus }),
      ...(body.isHeartbeatAck === undefined
        ? {}
        : { isHeartbeatAck: body.isHeartbeatAck }),
      ...(body.taskRunId === undefined ? {} : { taskRunId: body.taskRunId }),
    });
  }

  /** PATCH /api/messages/:id —— 推进 assistant 消息的持久生命周期（streaming→终态）。 */
  @Patch('messages/:id')
  async updateStatus(
    @Param('id') messageId: string,
    @Body() body: PatchStatusBody,
  ): Promise<{ ok: true }> {
    await this.appendMessage.updateStreamStatus(messageId, body.streamStatus);
    return { ok: true };
  }
}
