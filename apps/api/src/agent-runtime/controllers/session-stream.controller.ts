// apps/api/src/agent-runtime/controllers/session-stream.controller.ts
// 验收链路 · SSE 三件套控制器（epic-accept / accept-4，对齐 SPEC CAP-4、sprint-plan §二）。
//
// 【本故事（accept-4）范围】只落 POST /api/sessions/stream —— 新建会话 + 跑第一轮：
//   1. 经 C1.ManageSessionUseCase.create 建会话；
//   2. 首个 SSE 事件回推新 session id（约定 { type:'session', sessionId }，让 CLI 拿到 id）；
//   3. 经 C2.StartStreamUseCase.start 起第一轮；
//   4. 消费 StartStreamResult.events，每事件【一式三份】：
//      ① 经 accept-3 FileEventLog.append 拿 seq（文件日志那份，也是断线补发数据源）；
//      ② 写 SSE 帧（id: seq + data: JSON）推给本连接（实时那份）；
//      ③ 经 accept-2 SessionSseHub.publish 广播给挂在该会话上的其他连接（fan-out）。
//   回合终态最终 assistant 消息落 SQLite 由核心 c2-7 接线经 C1.AppendMessageUseCase 负责，
//   控制器【不重复落库、不边流边塞 SQLite】（一式三份的第三份职责分离，SPEC Constraints）。
//
//   GET /:id/stream 挂载（accept-5）、POST /:id/messages 触发（accept-6）、Last-Event-ID 补发
//   （accept-7）后续故事在本控制器补齐，本故事只做新建 + 首轮流式。
//
// 【薄层铁律】控制器只做协议边界翻译（HTTP body ↔ 用例入参、AgentStreamEvent 流 ↔ SSE 帧）+
//   一式三份落点编排；不含任何领域逻辑；相位/终态/canAccept 语义全由核心用例决定。SSE 帧【透传】
//   归一事件不伪造（反假数据）。因需在发起（异步）后手写事件流响应，采用 @Res 手写 SSE
//   （NestJS @Sse 仅绑 GET，不适配 POST 发起语义）。
//
// 【安全提醒】/api/sessions/stream 【无鉴权 / 无访问控制】。项目定位为「本机运行的单机应用」，
//   服务应绑 loopback（127.0.0.1）、绝不暴露公网——无认证的新建 + 回合发起端点会被任意触发
//   模型调用、消耗 litellm 额度。此为记录在案的本机验收取舍，生产化 / 跨机使用前必须补访问控制。
//
// 【密钥纪律】ANTHROPIC_AUTH_TOKEN 只在 apps/api/.env（gitignored）；本控制器绝不回显 /
//   写入密钥——只序列化归一事件与新建会话 id 到 SSE，不触碰任何 env / 凭据。
//
// 边界：控制器在 apps/api（框架层），允许 import @nestjs/* / express；端口经 @Inject(Symbol token) 注入。
import { Body, Controller, Inject, Post, Res } from '@nestjs/common';
import type {
  ManageSessionUseCase,
  CreateSessionInput,
  SessionMode,
  SessionSource,
  StartStreamUseCase,
  StartStreamInput,
  FileAttachmentRef,
  MentionRef,
  ThinkingOptions,
} from '@codepilot/core';
import { MANAGE_SESSION_USECASE } from '../../conversation/conversation.tokens.js';
import { START_STREAM_USECASE, SESSION_SSE_HUB, FILE_EVENT_LOG } from '../agent-runtime.tokens.js';
import type { SessionSseHub } from '../adapters/session-sse-hub.js';
import type { FileEventLog } from '../adapters/file-event-log.js';

/**
 * SseResponseLike —— 手写 SSE 直推所需的最小 HTTP 响应结构契约（只刻画本控制器用到的三方法）。
 *
 * 【为何本地定义而非 import express Response】对齐 ChatController 的做法——本项目未装 @types/express，
 *   控制器只需 writeHead/write/end 三个方法即可写 event-stream。定义最小结构契约避免引入类型依赖；
 *   运行时实际由 NestJS express 平台注入的 Response 结构化满足此形状。
 */
interface SseResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
}

/**
 * 新建会话 + 首轮请求体 —— 承载 C1 建会话所需字段 + C2 首轮 StartStream 入参 + 第一句话。
 *
 * 会话字段（title/mode/source/workingDirectory/projectName）映射 CreateSessionInput；
 * 回合字段（content/model/providerId/... + 首句）映射 StartStreamInput（sessionId 由新建会话回填）。
 * mode 同时供 C1 会话模式与 C2 回合模式（会话本体的 mode 与回合透传 mode 语义一致，见 §0）。
 * 除必填 content/model/providerId 外全部可选，缺省保持 undefined 由用例落默认（反假数据，不预填假值）。
 */
interface CreateStreamBody {
  // —— 第一句话（必填）——
  /** 本会话第一句用户输入内容。 */
  content: string;

  // —— C2 首轮回合字段 ——
  /** 模型标识（必填）。 */
  model: string;
  /** Provider 标识（必填，经 C7 解析协议 / auth / endpoint）。 */
  providerId: string;
  /** 会话 / 回合模式：code / plan / ask（可选，缺省由 C1 落 code）。 */
  mode?: SessionMode;
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

  // —— C1 会话本体字段 ——
  /** 标题文案（可选，缺省用默认标题 key）。 */
  title?: string;
  /** 会话来源：user / task（可选，缺省 user）。 */
  source?: SessionSource;
  /** 归属工作目录（可选）。 */
  workingDirectory?: string;
  /** 工作目录对应项目名（可选）。 */
  projectName?: string;
}

@Controller('api/sessions')
export class SessionStreamController {
  constructor(
    @Inject(MANAGE_SESSION_USECASE)
    private readonly manageSession: ManageSessionUseCase,
    @Inject(START_STREAM_USECASE)
    private readonly startStream: StartStreamUseCase,
    @Inject(SESSION_SSE_HUB)
    private readonly hub: SessionSseHub,
    @Inject(FILE_EVENT_LOG)
    private readonly eventLog: FileEventLog,
  ) {}

  /**
   * POST /api/sessions/stream —— 新建会话 + 跑第一轮，以 SSE 逐帧直推。
   *
   * 流程（一式三份编排见文件顶注）：
   *   建会话 → 首帧回推 { type:'session', sessionId } → StartStream.start(首句) →
   *   逐事件 append 日志拿 seq → 写本连接 SSE(id: seq) → publish 广播中枢。
   */
  @Post('stream')
  async createAndStream(
    @Body() body: CreateStreamBody,
    @Res() res: SseResponseLike,
  ): Promise<void> {
    // 1. 经 C1 用例建会话（id←IdGenerator、now←Clock，缺省字段用例落默认，控制器不自造 id）。
    const session = await this.manageSession.create(this.toCreateSessionInput(body));
    const sessionId = session.id;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 2. 首个 SSE 事件回推新 session id —— 让 CLI（accept-8）拿到 id 后续挂载 / 发消息。
    //    首帧本身不占 seq（seq 是回合归一事件的会话内游标，从第一条归一事件起从 1 递增）。
    res.write(`event: session\ndata: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

    // 3. 经 C2 用例起第一轮（sessionId 用新建会话 id 回填；编排——历史投影/终态落 C1——全在用例内）。
    const result = await this.startStream.start(this.toStartStreamInput(body, sessionId));

    // 4. 逐事件一式三份：append 日志拿 seq → 写本连接 SSE(id: seq) → 广播中枢 publish。
    for await (const event of result.events) {
      // ① 文件日志那份：分配单调递增 seq（也是断线补发数据源）。
      const { seq } = await this.eventLog.append(sessionId, event);
      // ② 实时那份：SSE 帧带 id: seq（断线重连游标）、event 名为事件 type、data 为整条归一事件（透传不伪造）。
      res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      // ③ 广播那份：fan-out 给挂在该会话上的其他连接（GET /:id/stream，accept-5）。best-effort。
      this.hub.publish(sessionId, event);
    }
    res.end();
  }

  /**
   * 把 HTTP body 归约成核心 CreateSessionInput：可选字段仅在存在时带上，缺省保持 undefined
   * 由 C1 用例落默认（反假数据，不预填假默认）。
   */
  private toCreateSessionInput(body: CreateStreamBody): CreateSessionInput {
    return {
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.mode === undefined ? {} : { mode: body.mode }),
      ...(body.source === undefined ? {} : { source: body.source }),
      ...(body.workingDirectory === undefined ? {} : { workingDirectory: body.workingDirectory }),
      ...(body.projectName === undefined ? {} : { projectName: body.projectName }),
    };
  }

  /**
   * 把 HTTP body + 新建会话 id 归约成核心 StartStreamInput：sessionId 用新建会话回填；
   * mode 缺省透传 'code'（对齐 C1 会话模式默认）；可选字段仅在存在时带上（反假数据）。
   */
  private toStartStreamInput(body: CreateStreamBody, sessionId: string): StartStreamInput {
    return {
      sessionId,
      content: body.content,
      mode: body.mode ?? 'code',
      model: body.model,
      providerId: body.providerId,
      ...(body.files === undefined ? {} : { files: body.files }),
      ...(body.mentions === undefined ? {} : { mentions: body.mentions }),
      ...(body.systemPromptAppend === undefined ? {} : { systemPromptAppend: body.systemPromptAppend }),
      ...(body.effort === undefined ? {} : { effort: body.effort }),
      ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
      ...(body.context1m === undefined ? {} : { context1m: body.context1m }),
      ...(body.selectedSkills === undefined ? {} : { selectedSkills: body.selectedSkills }),
    };
  }
}
