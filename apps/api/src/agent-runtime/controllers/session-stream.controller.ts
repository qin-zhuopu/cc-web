// apps/api/src/agent-runtime/controllers/session-stream.controller.ts
// 验收链路 · SSE 三件套控制器（epic-accept / accept-4 + accept-5 + accept-6 + accept-7，对齐 SPEC CAP-4/CAP-5/CAP-6/CAP-7、sprint-plan §二）。
//
// 【accept-4 范围】POST /api/sessions/stream —— 新建会话 + 跑第一轮：
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
// 【accept-6 范围】POST /api/sessions/:id/turn —— 向已有会话发消息触发新一轮 + 广播：
//   curl 发 → 控制器经 C2.StartStreamUseCase.start(sessionId, content, ...) 起一轮 →【立即返回】
//   受理确认 { accepted:true, streamId }（不阻塞在事件流上、不等回合结束）→ 后台消费 events：
//   每事件【一式三份的前两份】——① 经 accept-3 FileEventLog.append 拿 seq（补发数据源）；
//   ② 经 accept-2 SessionSseHub.publish 广播 fan-out 给所有挂在该会话 stream 上的订阅者。
//   本端点无自持 SSE 连接（HTTP 响应已即时结束），故不写「本连接」那份——实时那份由挂载的
//   GET /:id/stream 订阅者经中枢收取。终态落库同上由核心 c2-7 经 C1.AppendMessageUseCase 负责。
//
// 【accept-5 + accept-7 范围】GET /api/sessions/:id/stream —— 挂载已有会话的实时流（含断线补发）：
//   1. 给 id 就挂上：返回 text/event-stream；
//   2. 挂载本身【不触发新回合】（回合由 POST /:id/turn 或 POST /stream 触发），只接入广播 + 补发；
//   3. 【accept-7 断线补发】读请求头 Last-Event-ID: N（缺省/非法按 0 = 从头补发；约定选择见方法注释）
//      → 经 accept-3 FileEventLog.readAfter(sessionId, N) 逐条回放 seq>N 的历史事件，带【原 seq】作
//      SSE id（补发不重新分配 seq，忠实复用日志里的 seq）→ 记本次遍历读到的最大 seq（maxSeq，无产出则 0）；
//   4. 【衔接关键 · 不丢不重】补发完毕【再】订阅 accept-2 中枢实时流；listener 收到事件调
//      FileEventLog.append 拿【新】seq → 若新 seq <= maxSeq 则丢弃（补发窗口期内已回放过，去重防重复），
//      否则写 SSE 帧（id: seq + event: type + data: JSON）推本连接；
//   5. 连接断开（res close）调 unsubscribe 摘除本 listener，集合空时中枢清 key，无泄漏。
//
// 【衔接不丢不重的正确性论证（单机单进程）】seq 由文件日志同一会话写链串行分配、严格 +1。
//   补发的 readAfter 是一次「文件快照遍历」——遍历期间生产者新 append 的行【本次遍历看不到】
//   （createReadStream 打开文件时取定可见范围，行级 append 落到流末端）。maxSeq = 本次遍历实际读到的
//   最大 seq（无产出则 0，【不】取客户端 Last-Event-ID）。因此：
//   · 若某事件在 readAfter 遍历【结束前】入文件：必被本次遍历读到，补发之（其 seq<=maxSeq）；
//     生产者随后不会对该同一事件对象二次 publish（每个事件只 append+publish 一次），故不会重复补发。
//   · 若某事件在 readAfter 遍历【结束后】才 append：本次遍历没读到，但生产者随后会 publish 它；
//     listener 算的新 seq 严格 > maxSeq（同一写链续 +1），正常推给本连接——不丢。
//   · 关键不变量：maxSeq 是「本次遍历已回放过的 seq 上限」。之后所有 append 的 seq 都 > maxSeq，
//     故「seq<=maxSeq 丢弃」只可能过滤掉【已被本次补发回放过】的事件，绝不会误杀未来新事件。
//   「补发 await 解析 → 同步 subscribe」之间无 await 间隙，期间不会有生产者 microtask 插队 append+publish
//   （生产者 append 与 publish 之间无 await；subscribe 是同步登记），故订阅注册不会漏掉遍历后的事件。
//
// 【seq 单一来源说明 · 跨故事衔接】seq 只在【生产者侧】（消费 StartStream.events 流的那一侧：
//   createAndStream 的 for-await 或 consumeInBackground）调 FileEventLog.append 分配【唯一一次】，
//   随后以 { seq, event } 信封随 hub.publish 携带。GET /:id/stream 挂载侧 listener【复用】收到的 seq
//   写 SSE 帧、不再 append——杜绝同一事件被二次 append 致「文件日志写 N+1 行 / 断线补发重复」（评审 F1）。
//   补发侧也【不 append】（只读历史，复用原 seq）。
//
// 【薄层铁律】控制器只做协议边界翻译（HTTP body ↔ 用例入参、AgentStreamEvent 流 ↔ SSE 帧）+
//   一式三份落点编排；不含任何领域逻辑；相位/终态/canAccept 语义全由核心用例决定。SSE 帧【透传】
//   归一事件不伪造（反假数据）。因需在发起（异步）后手写事件流响应，采用 @Res 手写 SSE
//   （NestJS @Sse 仅绑 GET，不适配 POST 发起语义）。
//
// 【安全提醒】/api/sessions/stream、GET /api/sessions/:id/stream、POST /api/sessions/:id/turn 均
//   【无鉴权 / 无访问控制】。项目定位为「本机运行的单机应用」，服务应绑 loopback（127.0.0.1）、
//   绝不暴露公网——无认证的新建 + 回合发起端点会被任意触发模型调用、消耗 litellm 额度；
//   无认证的 GET 挂载端点会被任意进程接入任意会话的实时流（旁听全部流式内容）。
//   此为记录在案的本机验收取舍，生产化 / 跨机使用前必须补访问控制。
//
// 【密钥纪律】ANTHROPIC_AUTH_TOKEN 只在 apps/api/.env（gitignored）；本控制器绝不回显 /
//   写入密钥——只序列化归一事件与新建会话 id 到 SSE，不触碰任何 env / 凭据。
//
// 边界：控制器在 apps/api（框架层），允许 import @nestjs/* / express；端口经 @Inject(Symbol token) 注入。
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
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
  AgentStreamEvent,
} from '@codepilot/core';
import { MANAGE_SESSION_USECASE } from '../../conversation/conversation.tokens.js';
import { START_STREAM_USECASE, SESSION_SSE_HUB, FILE_EVENT_LOG } from '../agent-runtime.tokens.js';
import type { SessionSseHub } from '../adapters/session-sse-hub.js';
import type { FileEventLog } from '../adapters/file-event-log.js';

/**
 * SseResponseLike —— 手写 SSE 直推所需的最小 HTTP 响应结构契约（只刻画本控制器用到的三方法）。
 *
 * 【为何本地定义而非 import express Response】对齐 ChatController 的做法——本项目未装 @types/express，
 *   控制器只需 writeHead/write/end/on 四个方法即可写 event-stream。定义最小结构契约避免引入类型依赖；
 *   运行时实际由 NestJS express 平台注入的 Response 结构化满足此形状。
 *   on('close', cb) 供 GET /:id/stream 在客户端断开时摘除中枢订阅者，杜绝泄漏。
 */
interface SseResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
  /** 注册响应生命周期回调（Express NodeStream/Writable 的 on）。本控制器只用 'close'。 */
  on(event: 'close', listener: () => void): unknown;
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

/**
 * 发消息触发一轮请求体（accept-6）—— 向【已有】会话发第 N 句触发新一轮回合。
 *
 * sessionId 走路径参数（:id），不在 body。body 承载第一句话 + C2 回合 StartStream 入参
 * （除必填 content/model/providerId 外全可选，缺省保持 undefined 由用例落默认，反假数据）。
 * 语义与 CreateStreamBody 的回合字段一致，只是不含 C1 建会话本体字段（会话已存在）。
 */
interface SendMessageBody {
  /** 本轮用户输入内容（必填）。 */
  content: string;
  /** 模型标识（必填）。 */
  model: string;
  /** Provider 标识（必填，经 C7 解析协议 / auth / endpoint）。 */
  providerId: string;
  /** 回合模式：code / plan / ask（可选，缺省透传 'code'）。 */
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
}

/**
 * 发消息受理确认 —— POST /:id/turn 立即返回体（不阻塞在事件流上）。
 * accepted 恒真表「已受理并起回合」；streamId 供调用方关联本轮（实时事件走挂载的 GET /:id/stream）。
 */
interface SendMessageAck {
  readonly accepted: true;
  readonly streamId: string;
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

    // 4. 逐事件一式三份：append 日志拿 seq → 写本连接 SSE(id: seq) → 广播中枢携带 seq publish。
    for await (const event of result.events) {
      // ① 文件日志那份：分配单调递增 seq（也是断线补发数据源，本事件 seq 在此【唯一一次】分配）。
      const { seq } = await this.eventLog.append(sessionId, event);
      // ② 实时那份：SSE 帧带 id: seq（断线重连游标）、event 名为事件 type、data 为整条归一事件（透传不伪造）。
      res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      // ③ 广播那份：fan-out 给挂在该会话上的其他连接（GET /:id/stream，accept-5）。携带已分配 seq，
      //    订阅者侧【直接复用】该 seq 写帧、不再 append——杜绝同一事件被二次 append 致补发重复（评审 F1）。
      this.hub.publish(sessionId, { seq, event });
    }
    res.end();
  }

  /**
   * POST /api/sessions/:id/turn —— 向已有会话发消息触发新一轮，【立即返回】受理确认。
   *
   * 与 createAndStream 的关键差异：本端点【不持有 SSE 长连接】——curl 发出后立刻拿到
   * { accepted:true, streamId } 就断开，回合在后台跑；实时事件由挂在该会话上的
   * GET /:id/stream 订阅者经广播中枢收取（accept-5）。故一式三份此处只落【前两份】：
   *   ① 后台消费 events：每事件经 accept-3 FileEventLog.append 拿 seq（补发数据源）；
   *   ② 经 accept-2 SessionSseHub.publish 广播 fan-out 给所有该会话订阅者。
   * 回合终态最终 assistant 消息落 SQLite 仍由核心 c2-7 接线经 C1.AppendMessageUseCase 负责
   * （控制器不重复落库）。
   *
   * 【立即返回不阻塞】start() 先 await 拿到 streamId 与 events，随即返回 ack；events 的消费
   * 用一个不被 await 的后台任务驱动（consumeInBackground），确保 HTTP 响应不等回合结束。
   * 后台消费的异常被隔离吞掉（best-effort，回合失败终态由核心用例经 StreamStatus / 事件流表达，
   * 不由本 HTTP 响应承载——响应此刻已返回）。
   */
  @Post(':id/turn')
  @HttpCode(202)
  async sendMessage(
    @Param('id') sessionId: string,
    @Body() body: SendMessageBody,
  ): Promise<SendMessageAck> {
    // 经 C2 用例起一轮（sessionId 用路径参数；旧回合先 abort、历史投影、终态落 C1 全在用例内）。
    const result = await this.startStream.start(this.toStartStreamInput(body, sessionId));

    // 后台消费事件流：不 await，令 HTTP 响应立即返回（不阻塞在事件流 / 回合结束上）。
    this.consumeInBackground(sessionId, result.events);

    // 立即返回受理确认（202 Accepted）。密钥纪律：ack 只含 accepted + streamId，绝不含任何凭据。
    return { accepted: true, streamId: result.streamId };
  }

  /**
   * GET /api/sessions/:id/stream —— 挂载已有会话的实时流（accept-5 基础挂载 + accept-7 Last-Event-ID 断线补发）。
   *
   * 给 id 就挂上：返回 text/event-stream。挂载本身【不触发新回合】——回合由 POST /:id/turn
   * 或 POST /stream 触发，本端点只接入广播 + 补发。
   *
   * 流程（accept-5 + accept-7）：
   *   ① 写 SSE 头；
   *   ② 解析 Last-Event-ID: N（缺省/非法按 0 = 从头补发；见下方 parseLastEventId 约定说明）；
   *   ③ 【补发】经 FileEventLog.readAfter(sessionId, N) 逐条回放 seq>N 历史，带【原 seq】作 SSE id
   *     （补发不重新分配 seq、不 append），同时记下本次遍历读到的最大 seq（maxSeq，无产出则 0）；
   *   ④ 【切实时】补发完毕订阅 accept-2 中枢；listener 收到归一事件 → append 拿【新】seq →
   *     若 seq<=maxSeq 则丢弃（已被本次补发回放过，去重防重复），否则写 SSE 帧推本连接；
   *   ⑤ 客户端断开（res 'close'）→ unsubscribe 摘除本 listener，集合空时中枢清 key，无泄漏。
   *
   * 【为何补发侧复用原 seq、实时侧重新 append】补发的是【已落盘历史】，其 seq 已固化在日志里，
   *   复用即 SSE 断线重连游标语义（客户端记的 Last-Event-ID 与日志 seq 严格对齐）。实时事件是
   *   【新到】的归一事件，需经 append 分配新 seq（写 SSE 帧侧分配，见文件顶「seq 单一来源说明」），
   *   与补发共用同一会话写链 → 新 seq 严格 > maxSeq → 去重判定天然成立（不丢不重，见文件顶正确性论证）。
   *
   * 【为何 async】补发需 await readAfter 遍历文件；NestJS @Get 处理器支持返回 Promise，
   *   响应头已在 await 前 writeHead，SSE 长连接保持打开（不在此 return 后被框架意外 end）。
   *
   * 【Last-Event-ID 缺省/非法的约定】无 header / 空串 / 非整数 → 按 0 处理 = 从头补发全部历史事件。
   *   选择「从头补」而非「仅实时」的理由：新挂载的 CLI（accept-8）首连时也应能看到该会话已发生的
   *   全部历史（与断线重连语义一致、对客户端最直观）；若客户端只想要「从此刻起」的新事件，
   *   显式带 Last-Event-ID: <已知最大 seq> 即可跳过补发。约定在注释显式记录。
   */
  @Get(':id/stream')
  async attachStream(
    @Param('id') sessionId: string,
    @Headers('Last-Event-ID') lastEventId: string | string[] | undefined,
    @Res() res: SseResponseLike,
  ): Promise<void> {
    // 写 SSE 头：text/event-stream + 不缓存 + keep-alive（与 POST /stream 一致）。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Last-Event-ID 解析：多值取首个（规范上单值，防御性）；缺省/非法按 0 = 从头补发。
    const lastSeq = parseLastEventId(lastEventId);

    // ②③【补发】readAfter 回放 seq > lastSeq 的历史，带原 seq 作 SSE id；同时记录补发遍历到的最大 seq。
    //    maxSeq 初值取 0（【不】用 lastSeq）：去重的语义边界是「本次遍历已回放过的 seq 上限」，
    //    而非客户端的 Last-Event-ID。若 Last-Event-ID 大于文件末尾（无事件补发），maxSeq 保持 0，
    //    后续实时事件（seq 为文件计数器续 +1，必 > 0）不被误丢——它们是客户端【尚未见过】的新事件，
    //    即使其 seq 数值上 < 客户端的 Last-Event-ID（此情形只在该会话日志被截断 / 客户端 Last-Event-ID
    //    来源不一致时出现，属极端边角；本期不额外处置，如实推送）。
    //    readAfter 是「文件快照遍历」：遍历期间生产者新 append 的行本次看不到（落在流末端），
    //    这些未读事件随后由实时 listener 捕获（其 seq 严格 > maxSeq，不丢）。
    let maxSeq = 0;
    for await (const { seq, event } of this.eventLog.readAfter(sessionId, lastSeq)) {
      // 补发帧：id 用【原 seq】（断线重连游标语义），data 透传整条归一事件 JSON（不伪造）。
      res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (seq > maxSeq) {
        maxSeq = seq;
      }
    }

    // ④【切实时】订阅中枢。listener 收到【已落盘并分配好 seq】的 { seq, event } 信封 → 直接用该 seq
    //    去重（seq<=maxSeq 丢弃）→ 写帧。listener【绝不再次 append】——seq 已在生产者侧唯一分配，
    //    复用即可，杜绝评审 F1 的双重 append 致「同一事件写 N+1 行 / 补发重复」。
    const unsubscribe = this.hub.subscribe(sessionId, ({ seq, event }) => {
      // 去重：seq<=maxSeq 说明此事件已在本次补发中回放（补发遍历期间已落盘的事件，生产者随后又
      //   携其原 seq publish 一次）。直接丢弃，不重复写帧。
      if (seq <= maxSeq) {
        return;
      }
      // SSE 帧：id: seq（== 文件日志 seq == 断线重连游标，复用生产者分配值）+ event: 事件 type +
      //   data: 整条归一事件 JSON（透传不伪造）。写帧失败被中枢 best-effort 吞掉（不阻断其他订阅者）。
      res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // ⑤ 客户端断开（连接 close）→ 摘除本 listener，集合空时中枢清 key，无泄漏。
    res.on('close', () => {
      unsubscribe();
    });

    // 不调 res.end()：SSE 长连接保持打开，直至客户端断开（由 'close' 事件处理退订）。
  }

  /**
   * 后台消费一轮的归一事件流，逐事件落【一式三份的前两份】：append 日志拿 seq + 广播中枢 publish。
   *
   * 本方法【不返回给 HTTP 调用方】（sendMessage 已即时返回 ack），故 fire-and-forget 调用。
   * 整体 try/catch 吞掉消费期异常：本期本机验收，回合失败终态由核心用例经事件流 / StreamStatus
   * 表达，不上抛到已结束的 HTTP 响应；吞错保证一轮消费的偶发失败不产生未处理 Promise 拒绝。
   */
  private consumeInBackground(
    sessionId: string,
    events: AsyncIterable<AgentStreamEvent>,
  ): void {
    void (async () => {
      try {
        for await (const event of events) {
          // ① 文件日志那份：分配单调递增 seq（补发数据源；本事件 seq 在此【唯一一次】分配）。
          const { seq } = await this.eventLog.append(sessionId, event);
          // ② 广播那份：携带已分配 seq fan-out 给所有挂在该会话 GET /:id/stream 上的订阅者。
          //    订阅者侧复用该 seq 写 SSE 帧、不再 append（杜绝评审 F1 双重 append）。
          this.hub.publish(sessionId, { seq, event });
        }
      } catch {
        // best-effort：吞掉后台消费异常（HTTP 响应已返回；失败终态归核心用例经事件流 / StreamStatus 表达）。
      }
    })();
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

/**
 * 解析 Last-Event-ID 请求头为整数 seq（断线重连游标）。
 *
 * 约定（见 attachStream 注释）：缺省 / 空串 / 非整数 / 负数 → 返回 0 = 从头补发全部历史事件。
 * 多值头取首个（HTTP 规范上 Last-Event-ID 单值；防御性取首，避免取到无意义后续值）。
 * Number.parseInt 对 "7abc" 这类前缀数字串会宽松解析成 7，但 Last-Event-ID 语义上应是纯整数 seq，
 * 故用 Number.isInteger(strict) 兜底，非纯整数一律按 0 处理（不抛、不误判）。
 */
function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) {
    return 0;
  }
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) {
    return 0;
  }
  // 仅当整串是合法十进制整数时采纳；前缀数字串（"7abc"）不放宽，按 0 处理。
  if (!/^\d+$/.test(trimmed)) {
    return 0;
  }
  const n = Number.parseInt(trimmed, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
