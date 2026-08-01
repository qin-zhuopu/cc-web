// apps/api/src/agent-runtime/controllers/chat.controller.ts
// C2 驱动适配器：Chat 回合发起 / 中断 REST 控制器（epic-c2-7 / c2-7-5，对齐 SPEC CAP-4、PRD FR-2/FR-3/§0、architecture §8 controllers）。
//
// 【职责】把 HTTP 请求接到 C2 驱动端口：
//   - POST /api/chat：解析 body（对齐 StartStreamInput）→ StartStreamUseCase.start → 把归一事件流逐帧写为 SSE。
//   - POST /api/chat/interrupt：解析 streamId → AbortStreamUseCase.abort。
//
// 【薄层铁律】控制器只做协议边界翻译（HTTP body ↔ 用例入参、AgentStreamEvent 流 ↔ SSE 帧），
//   不含任何业务判定；相位/终态/canAccept 等语义全部由核心用例决定。SSE 帧【透传】归一事件不伪造
//   （反假数据，用户可见状态字段语义来源对齐 PRD §0）。
//
// 【本故事范围】只落最小 SSE 直推（消费 StartStreamResult.events 顺序写帧）；
//   不实现 SSE 广播 fan-out、文件事件日志、Last-Event-ID 补发、CLI（属 S9 验收链路 accept-2~9）。
//   因需在发起（异步）后手写事件流响应，采用 @Res 手写 SSE（NestJS @Sse 仅绑 GET，不适配 POST 发起语义）。
//
// 【安全提醒】/api/chat 与 /api/chat/interrupt 均【无鉴权 / 无访问控制】。项目定位为「本机运行的单机应用」，
//   可接受；但绝不可将这些 HTTP 端点暴露到公网——无认证的回合发起端点会被任意触发模型调用 / 中断。
//   生产化前必须补访问控制。
//
// 边界：控制器在 apps/api（框架层），允许 import @nestjs/* / express；端口经 @Inject(Symbol token) 注入。
import { Body, Controller, Inject, Post, Res } from '@nestjs/common';
import type {
  StartStreamUseCase,
  StartStreamInput,
  AbortStreamUseCase,
  FileAttachmentRef,
  MentionRef,
  ThinkingOptions,
} from '@codepilot/core';
import { START_STREAM_USECASE, ABORT_STREAM_USECASE } from '../agent-runtime.tokens.js';

/**
 * SseResponseLike —— 手写 SSE 直推所需的最小 HTTP 响应结构契约（只刻画本控制器用到的三方法）。
 *
 * 【为何本地定义而非 import express Response】对齐核心 AbortSignalLike 的做法——本项目未装
 *   @types/express，且控制器只需 writeHead/write/end 三个方法即可写 event-stream。定义最小结构契约
 *   避免引入类型依赖；运行时实际由 NestJS express 平台注入的 Response 结构化满足此形状。
 */
interface SseResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
}

/**
 * 发起回合请求体——与核心 StartStreamInput 形状对齐。
 * 必填：sessionId/content/mode/model/providerId；其余可选字段忠实透传，缺省保持 undefined（反假数据，不预填假默认）。
 */
interface StartChatBody {
  /** C1 会话 id。 */
  sessionId: string;
  /** 本回合用户输入内容。 */
  content: string;
  /** 会话模式：code / plan / ask（原样透传，Runtime 侧解释）。 */
  mode: string;
  /** 模型标识。 */
  model: string;
  /** Provider 标识（经 C7 解析协议 / auth / endpoint）。 */
  providerId: string;
  /** 文件附件引用列表（可选）。 */
  files?: ReadonlyArray<FileAttachmentRef>;
  /** @ 提及引用列表（可选）。 */
  mentions?: ReadonlyArray<MentionRef>;
  /** 追加系统提示词片段（可选）。 */
  systemPromptAppend?: string;
  /** 努力档位（可选）。 */
  effort?: string;
  /** 思考选项（可选）。 */
  thinking?: ThinkingOptions;
  /** 是否启用 1M context（可选）。 */
  context1m?: boolean;
  /** 本回合选用技能标识列表（可选）。 */
  selectedSkills?: ReadonlyArray<string>;
  /** assistant 自动触发（可选）。 */
  autoTrigger?: boolean;
}

/**
 * 中断回合请求体——只需目标回合标识 streamId（对应 StreamSessionId）。
 */
interface InterruptChatBody {
  /** 目标回合标识（StreamSessionId）。 */
  streamId: string;
}

@Controller('api/chat')
export class ChatController {
  constructor(
    @Inject(START_STREAM_USECASE)
    private readonly startStream: StartStreamUseCase,
    @Inject(ABORT_STREAM_USECASE)
    private readonly abortStream: AbortStreamUseCase,
  ) {}

  /**
   * POST /api/chat —— 发起一次回合，并以 SSE 逐帧直推归一事件流。
   *
   * 薄层：解析 body → StartStreamUseCase.start → 顺序消费 StartStreamResult.events，
   *   每条 AgentStreamEvent 忠实序列化为一帧 SSE（event: <type> + data: <json>），透传不伪造。
   *   编排（旧回合先 abort、终态落 C1 等）全在用例内，控制器不介入。
   */
  @Post()
  async start(@Body() body: StartChatBody, @Res() res: SseResponseLike): Promise<void> {
    const result = await this.startStream.start(this.toStartStreamInput(body));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // 先推一帧 streamId（供客户端定位本回合，用于后续 interrupt / permission 定向）。
    res.write(`event: stream_started\ndata: ${JSON.stringify({ streamId: result.streamId })}\n\n`);

    // 逐事件写帧：忠实透传归一 AgentStreamEvent（type 作 SSE event 名，整条事件作 data，反假数据）。
    for await (const event of result.events) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  }

  /**
   * POST /api/chat/interrupt —— 中断一次回合。
   *
   * 薄层：解析 streamId → AbortStreamUseCase.abort（幂等由用例保证，#578 结构化切断在用例内）。
   */
  @Post('interrupt')
  async interrupt(@Body() body: InterruptChatBody): Promise<{ ok: true }> {
    await this.abortStream.abort(body.streamId);
    return { ok: true };
  }

  /**
   * 把 HTTP body 归约成核心 StartStreamInput：必填直取，可选字段仅在存在时带上，
   * 缺省保持 undefined，绝不预填假默认（反假数据，与 PermissionController 的透传纪律一致）。
   */
  private toStartStreamInput(body: StartChatBody): StartStreamInput {
    return {
      sessionId: body.sessionId,
      content: body.content,
      mode: body.mode,
      model: body.model,
      providerId: body.providerId,
      ...(body.files === undefined ? {} : { files: body.files }),
      ...(body.mentions === undefined ? {} : { mentions: body.mentions }),
      ...(body.systemPromptAppend === undefined ? {} : { systemPromptAppend: body.systemPromptAppend }),
      ...(body.effort === undefined ? {} : { effort: body.effort }),
      ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
      ...(body.context1m === undefined ? {} : { context1m: body.context1m }),
      ...(body.selectedSkills === undefined ? {} : { selectedSkills: body.selectedSkills }),
      ...(body.autoTrigger === undefined ? {} : { autoTrigger: body.autoTrigger }),
    };
  }
}
