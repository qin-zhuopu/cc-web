// agent-runtime/usecases/start-stream.ts
// C2 · AgentRuntime —— 发起回合用例 StartStreamService（实现 StartStreamUseCase，对齐 architecture §4.1 / §6.1、SPEC CAP-1）。
//
// 【已落地范围】
//   - 构造：一次性把后续故事所需依赖全部经构造注入（registry + AgentRuntimePort + ProviderReadPort
//     + C1 GetSessionHistoryUseCase/AppendMessageUseCase + IdGenerator + Clock + ErrorClassifier），
//     避免 c2-4-2~6 反复改构造签名。
//   - start 骨架（c2-4-1）：streamId ← 注入的 IdGenerator.next()；new StreamSession(active)（startedAt ← 注入 Clock）；
//     注册进 registry；返回 { streamId, events }（events 为占位空流，真实事件消费属 c2-4-5）。
//   - Runtime 选择（c2-4-2，本次）：经只读 ProviderReadPort.resolve(providerId) 拿 ResolvedProviderView，
//     纯映射 protocol → RuntimeKind（resolveRuntimeKind），发起时锁定进 StreamSession.init.runtimeKind。
//     只读纪律：只调 resolve，绝不调任何写方法。无法判定 / 非对话协议不静默选错——经 ErrorClassifier 归错并抛出。
//
// 【后续故事补全】历史投影（GetSessionHistoryUseCase.getPromptView，CAP-3/c2-4-3）、单 active 约束
//（先 abort 旧回合，CAP-4/c2-4-4）、事件消费与终态（AgentRuntimePort.run 消费 + complete/abort/fail，
// CAP-5/c2-4-5）、落 C1（AppendMessageUseCase.append + StreamStatus 映射，CAP-6/c2-4-6）均在后续故事补，
// 本故事不写死假业务值到最终产物。
//
// 【铁律 · 核心零框架】本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process / codex / uuid；不直调系统时钟 / 不直调 randomUUID——
// streamId 经注入 IdGenerator，取时经 StreamSession 注入的 Clock。
// 类型-only import 用 import type + .js 扩展名（verbatimModuleSyntax），值 import 走普通 import。

import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { ErrorClassifier } from '../../ports/error-classifier.js';
import type { ClassifiedError } from '../../domain/error/classified-error.js';
import type {
  StartStreamInput,
  StartStreamResult,
  StartStreamUseCase,
} from '../ports/driving/start-stream-usecase.js';
import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  RuntimeRunOptions,
  AbortSignalLike,
} from '../ports/driven/agent-runtime-port.js';
import type { ProviderReadPort } from '../ports/driven/provider-read-port.js';
import type {
  AppendMessageUseCase,
  GetSessionHistoryUseCase,
  PromptMessage,
} from '../ports/driven/conversation-ports.js';
import type { AppendMessageInput } from '../../conversation/ports/driving/append-message-usecase.js';
import type { StreamStatus } from '../../conversation/domain/message/stream-status.js';
import type { TokenUsage as PersistTokenUsage } from '../../conversation/domain/message/token-usage.js';
import { decodeContent } from '../../conversation/domain/message/message-content.js';
import type { AgentStreamEvent, TokenUsage } from '../domain/event/agent-stream-event.js';
import type { ResolvedProviderView, ProviderProtocol } from '../ports/driven/provider-read-port.js';
import { ErrorCode } from '../../domain/error/error-code.js';
import { StreamSession } from '../domain/stream/stream-session.js';
import { buildFinalContent } from '../domain/stream/turn-artifacts.js';
import {
  isTerminal,
  StreamPhaseKind,
  TerminalSubstate,
  type StreamSessionId,
} from '../domain/stream/stream-phase.js';
import { RuntimeKind } from '../domain/runtime/runtime-kind.js';
// 注意：RuntimeRunRequest.runtimeKind 用的是 ports/runtime-kind.ts 那处 RuntimeKind（与
// StreamSession.init.runtimeKind 所需的 domain/runtime/ 那处同名但类型不同）。二者字面量值相同，
// 边界处经 toRuntimeRunKind 做值层面的等价传递（既有技术债，本 epic 只复用不动它，绝不 as any / 不合并 enum）。
import { RuntimeKind as RuntimeRunKind } from '../ports/runtime-kind.js';
import type { StreamSessionRegistry } from './stream-session-registry.js';

/**
 * classifyAbort —— 经注入的 SK.ErrorClassifier 把「中断信号触发」归一为 ABORTED 分类结果（CAP-5）。
 *
 * 构造 name='AbortError' 的错误交 classify，由 classifyByName 归 ErrorCode.ABORTED（用户主动中断语义）。
 * 归类唯一权威在 SK.ErrorClassifier——绝不在此手工拼 ClassifiedError（避免绕过分类器造假 code）。
 */
function classifyAbort(errorClassifier: ErrorClassifier, reason: string): ClassifiedError {
  const abortError = new Error(reason);
  abortError.name = 'AbortError';
  return errorClassifier.classify(abortError);
}

/**
 * terminalSubstateToStreamStatus —— 终态子态 → C1 持久 StreamStatus 映射（CAP-6 / architecture §6.4）。
 *
 * 映射规则（§6.4）：
 *  - terminal(completed) → 'completed'
 *  - terminal(aborted)   → 'interrupted'（用户主动中断，内容不完整但非错误）
 *  - terminal(errored)   → 'error'
 *
 * 仅在回合已落 terminal 时调用；传入的是 TerminalSubstate（C2 内存相位子态），
 * 产出 C1 的持久生命周期字面量——C2 只映射不落库，写回一律经 C1.AppendMessageUseCase 端口。
 * 非 terminal 相位（active/settling）不该走到落库路径，故此处只穷尽三个终态子态。
 */
function terminalSubstateToStreamStatus(substate: TerminalSubstate): StreamStatus {
  switch (substate) {
    case TerminalSubstate.COMPLETED:
      return 'completed';
    case TerminalSubstate.ABORTED:
      return 'interrupted';
    case TerminalSubstate.ERRORED:
      return 'error';
    default: {
      // 穷尽性守卫：TerminalSubstate 新增子态时此处编译期报错，逼显式决策。
      const _exhaustive: never = substate;
      return _exhaustive;
    }
  }
}

/**
 * projectPersistTokenUsage —— 把 C2 事件侧的 TokenUsage 投影为 C1 持久 TokenUsage（CAP-6 / AC-9）。
 *
 * 【反假数据（AC-9）】无 Runtime 上报（session 快照 tokenUsage 缺省）→ 返回 undefined，
 * append 时整个字段省略，绝不填 0。有上报时逐字段搬运（有值才带），只做投影不算合计——
 * 派生统计属 C1 之外，C2 只忠实透传 Runtime 上报的原始计数。
 */
function projectPersistTokenUsage(
  tokenUsage: TokenUsage | undefined,
): PersistTokenUsage | undefined {
  if (tokenUsage === undefined) {
    return undefined;
  }
  const projected: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  } = {};
  if (tokenUsage.inputTokens !== undefined) {
    projected.inputTokens = tokenUsage.inputTokens;
  }
  if (tokenUsage.outputTokens !== undefined) {
    projected.outputTokens = tokenUsage.outputTokens;
  }
  if (tokenUsage.cacheCreationInputTokens !== undefined) {
    projected.cacheCreationInputTokens = tokenUsage.cacheCreationInputTokens;
  }
  if (tokenUsage.cacheReadInputTokens !== undefined) {
    projected.cacheReadInputTokens = tokenUsage.cacheReadInputTokens;
  }
  return projected;
}

/**
 * persistTerminalTurn —— 回合落终态后的落 C1 编排（CAP-6 / FR-2.5/2.6 / AC-12 / AC-9）。
 *
 * 【落库条件】
 *  - 仅在回合已落 terminal 时调用；先经 buildFinalContent(artifacts) 投影 finalContent。
 *  - finalContent 为 null（空回合）→ 不落 assistant 消息（FR-2.6）。
 *  - autoTrigger 回合 → 跳过落库（assistant 自动触发不留转录，对齐 StartStreamInput.autoTrigger 语义）。
 *
 * 【落库形状】非空且非 autoTrigger → 经注入的 C1.AppendMessageUseCase.append 落一条 assistant 消息：
 *  - role='assistant'。
 *  - content：由 finalContent 经 C1 的 decodeContent 解回 MessageContent（buildFinalContent 的产物
 *    正是 C1 内容块 JSON / 纯文本串，decodeContent 对二者均按 C1 权威编解码规则还原——纯文本降级为单
 *    text 块，blocks JSON 还原为对应块，绝不臆造结构）。
 *  - streamStatus：终态子态经 terminalSubstateToStreamStatus 映射（completed/interrupted/error，§6.4）。
 *  - tokenUsage：经 projectPersistTokenUsage 投影；无上报省略（AC-9 不填 0）。
 *
 * 【只经用例写】C2 绝不直写库 / 不持有 Repository，落库唯一路径是 C1.AppendMessageUseCase 端口（AC-12）。
 * append 失败向上层抛出（由上层/驱动适配器处理），本函数不吞异常、不造假成功。
 */
async function persistTerminalTurn(
  session: StreamSession,
  messages: AppendMessageUseCase,
  autoTrigger: boolean,
): Promise<void> {
  const snapshot = session.snapshot();
  // 仅终态回合落库；非终态不该走到此处（防御性 no-op，不落库）。
  if (snapshot.phase.kind !== StreamPhaseKind.TERMINAL) {
    return;
  }

  // autoTrigger 回合：assistant 自动触发，跳过落库（不留 user 消息/标题，亦不落 assistant 转录）。
  if (autoTrigger) {
    return;
  }

  // 终态投影最终内容（复用 c2-1 buildFinalContent，不重写）：空回合返回 null → 不落 assistant 消息（FR-2.6）。
  const finalContent = buildFinalContent(snapshot.artifacts);
  if (finalContent === null) {
    return;
  }

  // finalContent → C1 MessageContent：经 C1 权威 decodeContent 还原（纯文本降级为单 text 块，
  // blocks JSON 还原为对应块），不在 C2 侧臆造内容块结构。
  const input: AppendMessageInput = {
    sessionId: snapshot.sessionId,
    role: 'assistant',
    content: decodeContent(finalContent),
    streamStatus: terminalSubstateToStreamStatus(snapshot.phase.substate),
  };
  const tokenUsage = projectPersistTokenUsage(snapshot.tokenUsage);
  if (tokenUsage !== undefined) {
    // 有上报才带 tokenUsage 字段（AC-9：无上报整体省略，绝不填 0）。
    (input as { tokenUsage?: PersistTokenUsage }).tokenUsage = tokenUsage;
  }

  await messages.append(input);
}

/**
 * consumeRunStream —— 消费 AgentRuntimePort.run 产出的**已归一** AgentStreamEvent 流，
 * 一边 session.apply 累积产物、一边对外 yield 转发（构成 StartStreamResult.events），
 * 并据流的结束方式驱动聚合根终态（CAP-5 / FR-2.1 / FR-3.6，对齐 architecture §6.2）。
 *
 * 【只消费已归一事件】本函数绝不解析任何 SDK/SSE/JSON-RPC 原生帧——归一在适配器内的
 * EventMapper 完成（属 c2-6）；这里只消费 14 类 AgentStreamEvent，复用 c2-2 的 apply/迁移方法
 *（值 import），绝不重写累积规则或相位迁移。
 *
 * 【终态驱动】
 *  - abortSignal 触发（消费前已触发 / 消费中转真 → session.abort(经 ErrorClassifier 的 ABORTED)。
 *  - 上游 error 事件 → session.fail(event.error)（error 事件里已归一的 ClassifiedError）。
 *    idle/tool-timeout 的 TIMEOUT/PROCESS 归因即经此路径以 ClassifiedError.code 携带（UI 据 code 区分），
 *    本故事不造假定时器——超时定时器完整机制属 c2-5。
 *  - 源正常耗尽 → session.complete(result 事件的 tokenUsage 投影；无上报保持 undefined，AC-9 不填 0）。
 *  - 源迭代抛出（适配器异常，非归一 error 事件）→ 经 ErrorClassifier 归一后 abort/fail，
 *    保证聚合根绝不停在 active（#578 精神），再向上层抛出。
 *
 * 【幂等安全】每次翻终态前先查 isTerminal——聚合根迁移方法本身幂等（terminal 后 no-op），
 * 这里的守卫只为避免重复归类/多余分支执行，不改变幂等语义。
 */
async function* consumeRunStream(
  session: StreamSession,
  source: AsyncIterable<AgentStreamEvent>,
  abortSignal: AbortSignalLike,
  errorClassifier: ErrorClassifier,
  registry: StreamSessionRegistry,
  messages: AppendMessageUseCase,
  autoTrigger: boolean,
): AsyncIterableIterator<AgentStreamEvent> {
  // result 事件的 tokenUsage 投影缓存（AC-9：仅 Runtime 真实上报时有值，否则保持 undefined，绝不填 0）。
  let resultTokenUsage: TokenUsage | undefined;
  // 记录本次消费的 streamId，供终态后从 registry 摘除（防内存泄漏，registry 仍非持久层）。
  const streamId: StreamSessionId = session.snapshot().id;

  try {
    // 消费前若中断信号已触发：直接翻 terminal(aborted)，不进入消费（命令一到即落终态）。
    if (abortSignal.aborted && !isTerminal(session.snapshot().phase)) {
      session.abort(classifyAbort(errorClassifier, '中断信号在回合开始前已触发'));
      return;
    }

    for await (const event of source) {
      // 逐事件累积进聚合根（复用 c2-2 apply，绝不重写累积规则）。
      session.apply(event);
      // 对外转发：一边 apply 一边 yield，构成 StartStreamResult.events。
      yield event;

      // abortSignal 触发 → 无条件翻 terminal(aborted)（经 ErrorClassifier 归 ABORTED）。
      if (abortSignal.aborted && !isTerminal(session.snapshot().phase)) {
        session.abort(classifyAbort(errorClassifier, '中断信号在回合进行中触发'));
        return;
      }

      switch (event.type) {
        case 'result':
          // 捕获 Runtime 真实上报的 token 投影，供正常耗尽时 complete（AC-9：未上报保持 undefined）。
          if (event.tokenUsage !== undefined) {
            resultTokenUsage = event.tokenUsage;
          }
          break;
        case 'error':
          // 上游 error 事件 → 翻 terminal(errored)，携事件里已归一的 ClassifiedError。
          if (!isTerminal(session.snapshot().phase)) {
            session.fail(event.error);
            return;
          }
          break;
        default:
          break;
      }
    }

    // 源正常耗尽：若仍非终态，据中断信号决定终态——
    // 信号已触发 → abort(ABORTED)；否则正常 complete（携 result 事件的 token 投影，无上报不填）。
    if (!isTerminal(session.snapshot().phase)) {
      if (abortSignal.aborted) {
        session.abort(classifyAbort(errorClassifier, '中断信号在回合收尾时触发'));
      } else {
        session.complete(resultTokenUsage);
      }
    }
  } catch (err) {
    // 源迭代抛出（适配器异常，非归一 error 事件）：仍保证聚合根落终态（绝不停在 active），
    // 经 ErrorClassifier 归一——ABORTED 类走 abort，其余走 fail——再向上层抛出。
    if (!isTerminal(session.snapshot().phase)) {
      const classified = errorClassifier.classify(err);
      if (classified.code === ErrorCode.ABORTED) {
        session.abort(classified);
      } else {
        session.fail(classified);
      }
    }
    throw err;
  } finally {
    // 落 C1（CAP-6 / FR-2.5/2.6 / AC-12 / AC-9）+ registry 摘除（防内存泄漏），
    // 走 finally 覆盖全部退出路径（正常耗尽 / abort/error 提前 return / 源抛出）：
    //  - 仅当回合确已落 terminal 才落库（上述各路径均已翻终态；理论上消费者提前 break
    //    致未落终态时不落库，避免把未定格回合写进 C1）。
    //  - 落库经 persistTerminalTurn（buildFinalContent 非空且非 autoTrigger 才 append，
    //    终态子态映射持久 StreamStatus，tokenUsage 无上报省略），只经 C1.AppendMessageUseCase 端口写。
    //  - 无论是否落库，终态回合都从 registry 摘除（registry 仍非持久层，只做活跃回合内存索引）。
    if (isTerminal(session.snapshot().phase)) {
      await persistTerminalTurn(session, messages, autoTrigger);
      registry.delete(streamId);
    }
  }
}

/**
 * resolveRuntimeKind —— 纯映射：C7 只读解析出的 protocol → 发起时锁定的 RuntimeKind（CAP-2 / FR-2.2）。
 *
 * 语义依据 architecture §3.6（RuntimeKind：claude-sdk / native / codex）与 §5.3（C2 只读消费 C7 协议）：
 *  - anthropic：Anthropic 原生协议，走 @anthropic-ai/claude-agent-sdk 的 Query → CLAUDE_SDK。
 *  - openai-compatible / xai / openrouter / bedrock / vertex / google：均为 HTTP 系（OpenAI 兼容 / 各家 HTTP 网关），
 *    统一走 Native HTTP provider 的 SSE 流 → NATIVE。
 *
 * 【降级纪律 · 反臆造（CAP-2）】映射表未覆盖的协议一律不静默选错 Runtime：
 *  - unknown：C7 无法判定协议，C2 亦不臆造 → 返回 null，由调用方经 ErrorClassifier 归错并抛出。
 *  - gemini-image / openai-image：图像生成协议，非对话 Runtime（本 epic 三 RuntimeKind 均为对话运行时），
 *    不映射到任一对话 Runtime → 返回 null，由调用方归错并抛出（待专门的图像路径接入后再扩展映射）。
 *
 * 注意：这里选用的是 domain/runtime/ 处的 RuntimeKind enum（StreamSession.init.runtimeKind 所需）。
 * 因两处同名 enum 字面量值相同，锁进 StreamSession 后如需传 RuntimeRunRequest（ports/ 处），
 * 由后续故事在边界按字面量等价传递（见任务约束），本函数只产 domain/runtime/ 处的值。
 */
export function resolveRuntimeKind(view: ResolvedProviderView): RuntimeKind | null {
  const protocol: ProviderProtocol = view.protocol;
  switch (protocol) {
    case 'anthropic':
      return RuntimeKind.CLAUDE_SDK;
    case 'openai-compatible':
    case 'xai':
    case 'openrouter':
    case 'bedrock':
    case 'vertex':
    case 'google':
      return RuntimeKind.NATIVE;
    case 'gemini-image':
    case 'openai-image':
    case 'unknown':
      // 非对话 Runtime / 无法判定：不选错，交调用方归错。
      return null;
    default: {
      // 穷尽性守卫：ProviderProtocol 新增字面量时此处编译期报错，逼显式决策，杜绝静默降级。
      const _exhaustive: never = protocol;
      return _exhaustive;
    }
  }
}

/**
 * toRuntimeRunKind —— 把锁进 StreamSession 的 domain/runtime/ 处 RuntimeKind 值，
 * 等价映射为 RuntimeRunRequest 所需的 ports/runtime-kind.ts 处 RuntimeKind 值（CAP-3 组装请求用）。
 *
 * 两处 enum 同名但为不同类型（既有技术债，本 epic 只复用不动它）；二者字面量值相同
 *（claude-sdk / native / codex），此处按字面量在边界做值层面的等价传递，绝不 as any、绝不合并两个 enum。
 * switch 穷尽 domain 处的三个成员，新增成员时编译期在此报错，逼显式决策。
 */
function toRuntimeRunKind(kind: RuntimeKind): RuntimeRunKind {
  switch (kind) {
    case RuntimeKind.CLAUDE_SDK:
      return RuntimeRunKind.CLAUDE_SDK;
    case RuntimeKind.NATIVE:
      return RuntimeRunKind.NATIVE;
    case RuntimeKind.CODEX:
      return RuntimeRunKind.CODEX;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * toRuntimeRunOptions —— 把 StartStreamInput 的运行选项字段归约成 RuntimeRunOptions 投影（CAP-3）。
 *
 * 【反假数据】可选字段无值保持 undefined，绝不预填假默认；只做字段搬运，不解释语义（Runtime 侧解释）。
 */
function toRuntimeRunOptions(input: StartStreamInput): RuntimeRunOptions {
  return {
    mode: input.mode,
    model: input.model,
    effort: input.effort,
    thinking: input.thinking,
    context1m: input.context1m,
    selectedSkills: input.selectedSkills,
    systemPromptAppend: input.systemPromptAppend,
  };
}

/**
 * StartStreamService —— 发起一次回合的应用用例（纯编排，零框架）。
 *
 * 依赖全部经构造注入的端口接口，可用假端口做纯单元测试（无 dev server / 无真实 SDK-进程-网络）。
 * 见 architecture §6.1 编排要点、§8 DI 接线（NestJS 侧提供各端口实现）。
 */
export class StartStreamService implements StartStreamUseCase {
  private readonly registry: StreamSessionRegistry;
  private readonly runtime: AgentRuntimePort;
  private readonly providers: ProviderReadPort;
  private readonly history: GetSessionHistoryUseCase;
  private readonly messages: AppendMessageUseCase;
  private readonly idGenerator: IdGenerator;
  private readonly clock: Clock;
  private readonly errorClassifier: ErrorClassifier;

  /**
   * 构造 StartStreamService。依赖一次性全注入，后续故事复用同一签名。
   *
   * @param registry        活跃回合内存注册表（登记新回合 / 查同会话 active 回合）。
   * @param runtime         AgentRuntimePort 出站端口（发起原生调用、产出归一事件流；本故事未用，c2-4-5 起用）。
   * @param providers       C7 只读 ProviderReadPort（解析 providerId → 协议；本故事未用，c2-4-2 起用）。
   * @param history         C1 GetSessionHistoryUseCase（取喂模型历史投影；本故事未用，c2-4-3 起用）。
   * @param messages        C1 AppendMessageUseCase（终态落库；本故事未用，c2-4-6 起用）。
   * @param idGenerator     SK.IdGenerator（生成 streamId）。
   * @param clock           SK.Clock（经 StreamSession 构造取 startedAt）。
   * @param errorClassifier SK.ErrorClassifier（abort/fail 归类；本故事未用，c2-4-4/5 起用）。
   */
  constructor(
    registry: StreamSessionRegistry,
    runtime: AgentRuntimePort,
    providers: ProviderReadPort,
    history: GetSessionHistoryUseCase,
    messages: AppendMessageUseCase,
    idGenerator: IdGenerator,
    clock: Clock,
    errorClassifier: ErrorClassifier,
  ) {
    this.registry = registry;
    this.runtime = runtime;
    this.providers = providers;
    this.history = history;
    this.messages = messages;
    this.idGenerator = idGenerator;
    this.clock = clock;
    this.errorClassifier = errorClassifier;
  }

  /**
   * 发起一次回合（骨架，对齐 architecture §6.1 前半）：
   *  1. streamId ← 注入的 IdGenerator.next()（核心不直调系统随机 id 源）。
   *  2. new StreamSession({ id, sessionId, runtimeKind }, clock)：phase 初始 active，startedAt ← 注入 Clock。
   *     runtimeKind 本故事暂用默认占位（CLAUDE_SDK），真实解析（ProviderReadPort → RuntimeKind）属 c2-4-2。
   *  3. 注册进 registry（getActiveBySession 即可查得）。
   *  4. 返回 { streamId, events }，events 为占位空流（真实事件消费属 c2-4-5）。
   *
   * 单 active 先行 abort（c2-4-4）、Runtime 选择（c2-4-2）、历史投影（c2-4-3）、事件消费与落库（c2-4-5/6）
   * 均在后续故事补入本方法，届时复用同一构造依赖。
   */
  async start(input: StartStreamInput): Promise<StartStreamResult> {
    const streamId = this.idGenerator.next();

    // Runtime 选择（CAP-2 / FR-2.2）：经只读 ProviderReadPort.resolve 拿协议视图 → 纯映射 RuntimeKind → 发起时锁定。
    // 只读纪律：只调 resolve，绝不调任何写方法。
    //
    // 【顺序纪律 · 单 active 无 await 原子段（AC-11 TOCTOU 防护）】resolve 是本方法唯一在
    // 「查旧 active → abort/摘除旧回合 → 建新回合 → register」之前的 await，特意提到该段之前完成。
    // 若把 resolve 夹在「查旧 active」与「register 新回合」之间，两个并发的 start(同 sessionId) 会
    // 交错：A、B 先后查得无 active → 各自 await resolve 让出 → 各自 register，造出两个 active 回合，
    // 破坏单 active 不变量。故 resolve 先行，之后的单 active 检查与登记为无 await 的同步段，杜绝交错。
    const resolvedProvider = await this.providers.resolve(input.providerId);
    const runtimeKind = resolveRuntimeKind(resolvedProvider);
    if (runtimeKind === null) {
      // 无法判定 / 非对话协议：不静默选错 Runtime，经 ErrorClassifier 归错并抛出（反臆造）。
      // 注：此抛出在单 active 检查之前——新请求 provider 非法时绝不误杀该会话已有的 active 旧回合。
      const classified = this.errorClassifier.classify(
        new Error(
          `无法为 provider 协议 "${resolvedProvider.protocol}" 选择对话 Runtime（providerId=${input.providerId}）`,
        ),
      );
      throw Object.assign(new Error(classified.messageKey), { classified });
    }

    // ---- 单 active 原子段（以下无 await，同步完成，杜绝并发 start 交错破坏 AC-11）----

    // 单 active 约束（CAP-4 / FR-2.4 / AC-11）：发起新回合前，若该 C1 会话已有 active 回合，
    // 先同步 abort 旧回合，保证「同一 session 至多一个 active 回合」。
    // 复用 c2-2 聚合根 StreamSession.abort（同步无条件翻 terminal(aborted)、幂等）——本故事只做
    // 聚合根层的同步翻终态，绝不重写迁移规则，也不实现 AbortStream 的 force-abort 安全网先行 /
    // best-effort interrupt / reconcilePhase（那属 c2-5 完整中断编排）。
    // reason 经注入的 SK.ErrorClassifier 归一：以 name='AbortError' 的错误交 classify，
    // 由 classifyByName 归 ErrorCode.ABORTED（用户主动中断语义），携入旧回合 terminalReason.classified。
    const previousActive = this.registry.getActiveBySession(input.sessionId);
    if (previousActive !== undefined) {
      const abortError = new Error('单 active 约束：发起新回合前中断该会话的旧 active 回合');
      abortError.name = 'AbortError';
      previousActive.abort(this.errorClassifier.classify(abortError));
      // 旧回合已翻 terminal(aborted)，从 registry 同步摘除：切到新回合时上层通常弃用旧回合的
      // events 迭代器，被弃用的 async generator 其 finally（consumeRunStream 的 registry.delete）
      // 不保证执行，故此处主动 delete，避免终态旧回合永久滞留 Map 累积泄漏。终态回合已不被单
      // active 语义需要（getActiveBySession 只回 active 者），摘除不影响任何不变量。
      this.registry.delete(previousActive.snapshot().id);
    }

    const session = new StreamSession(
      {
        id: streamId,
        sessionId: input.sessionId,
        runtimeKind,
      },
      this.clock,
    );

    this.registry.register(session);

    // ---- 单 active 原子段结束 ----

    // 历史投影（CAP-3 / FR-2.3 / C1 AC-13）：喂模型历史**只经** C1.GetSessionHistoryUseCase.getPromptView
    // 拿（已剔除 render-only 标记），绝不用 getHistory（那是含 render-only 的完整 UI 投影）、
    // 绝不直读 messages 表 / 不持有 Repository。C2 不重新加工 / 过滤历史（投影语义归 C1），原样透传。
    const promptView: ReadonlyArray<PromptMessage> = await this.history.getPromptView({
      sessionId: input.sessionId,
    });

    // 组装 RuntimeRunRequest（备 c2-4-5 调 AgentRuntimePort.run 用）：
    //  - runtimeKind 用 ports/ 处 RuntimeKind（经 toRuntimeRunKind 从锁进 session 的 domain 处等价传递）。
    //  - resolvedProvider 为 c2-4-2 的只读解析视图。
    //  - promptView 为上面 getPromptView 的投影，**原样**进请求（C2 不再加工）。
    //  - options 从 input 归约 mode/model/effort/thinking/context1m/selectedSkills/systemPromptAppend。
    //  - abortSignal 为最小占位信号（真实中断信号接线属 c2-4-5/c2-5，此处不预填假中断态）。
    const abortSignal: AbortSignalLike = {
      aborted: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const request: RuntimeRunRequest = {
      streamId,
      runtimeKind: toRuntimeRunKind(runtimeKind),
      resolvedProvider,
      promptView,
      content: input.content,
      options: toRuntimeRunOptions(input),
      abortSignal,
    };

    // 发起原生调用，拿归一后的 AgentStreamEvent 流（CAP-3 组装 request 后交 AgentRuntimePort.run）。
    // 事件消费与终态归因（CAP-5 / FR-2.1 / FR-3.6，对齐 architecture §6.2）：
    // 把 run 的归一流交 consumeRunStream 包一层——一边 session.apply 累积、一边对外 yield 转发，
    // 并据流结束方式驱动聚合根终态（正常耗尽→complete / abortSignal→abort(ABORTED) / error 事件→fail）。
    // 逐事件消费只复用 c2-2 的 apply/迁移方法（值 import），绝不解析原生帧、绝不重写迁移。
    // 落 C1（buildFinalContent → AppendMessageUseCase.append + StreamStatus 映射）属 CAP-6（c2-4-6），本故事不做。
    const source = this.runtime.run(request);
    const events = consumeRunStream(
      session,
      source,
      abortSignal,
      this.errorClassifier,
      this.registry,
      this.messages,
      input.autoTrigger === true,
    );

    return {
      streamId,
      events,
    };
  }
}
