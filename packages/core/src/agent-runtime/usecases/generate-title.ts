// agent-runtime/usecases/generate-title.ts
// C2 · AgentRuntime —— 非流式一次性标题生成用例 GenerateTitleService
// （实现 TitleGenerator 驱动端口，对齐 SPEC CAP-1、architecture §4.3/§6.5/§8、PRD FR-6/FR-6.3/AC-13）。
//
// 【职责】用「轻量非流式」的一次原生调用生成会话标题字符串：
//   经只读 ProviderReadPort 拿 provider 视图 → 组装一份轻量 RuntimeRunRequest
//   （标题提示 + 近期消息纯文本投影）→ 一次性消费 AgentRuntimePort.run 的归一事件流，
//   只提取 text 事件产物拼成标题串返回，消费完即弃。
//
// 【AC-13 隔离铁律 · 本用例命门】与主回合流式路径**完全隔离**：
//   - 绝不 idGenerator.next() 造用户可见 streamId（本用例构造上根本不持有 IdGenerator）；
//   - 绝不 new StreamSession；
//   - 绝不进 StreamSessionRegistry（构造上根本不持有 registry，从结构上杜绝 register）；
//   - 绝不影响任何 canAccept()。
//   run 请求所需的 streamId 只是一个**非注册、非用户可见**的临时标记（见 TITLE_STREAM_ID_PREFIX），
//   仅供适配器在这一次一次性调用内部关联句柄，消费完即弃，绝不登记、绝不落 C1。
//
// 【失败语义】Runtime 失败 / 抛错、或协议无法映射到对话 Runtime → 向上抛出，
//   由 C1.SetSessionTitleService 就地降级（保留原标题，C1 FR-2.4）；绝不静默返回空串造假标题。
//
// 【铁律 · 核心零框架】本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
//   node:child_process / node:timers / uuid；不直调系统时钟、不生成随机 id。
//   类型-only import 用 import type + .js 扩展名（verbatimModuleSyntax），值 import 走普通 import + .js。字段全 readonly。

import type { TitleGenerator, TitleGenerationInput } from '../ports/driving/title-generator.js';
import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  RuntimeRunOptions,
  AbortSignalLike,
} from '../ports/driven/agent-runtime-port.js';
import type { ProviderReadPort, ResolvedProviderView } from '../ports/driven/provider-read-port.js';
import type { AgentStreamEvent } from '../domain/event/agent-stream-event.js';
import type { PromptMessage } from '../ports/driven/conversation-ports.js';
import type { StreamSessionId } from '../domain/stream/stream-phase.js';
import { RuntimeKind } from '../domain/runtime/runtime-kind.js';
import { RuntimeKind as RuntimeRunKind } from '../ports/runtime-kind.js';
// 复用 c2-4 的纯映射 resolveRuntimeKind（protocol → 发起时锁定的 RuntimeKind；未覆盖协议返回 null），
// 绝不在此重写协议映射规则。
import { resolveRuntimeKind } from './start-stream.js';

/**
 * TITLE_STREAM_ID_PREFIX —— 标题生成一次性调用的**非注册、非用户可见** streamId 前缀。
 *
 * RuntimeRunRequest.streamId 为必填，但标题调用绝不建 StreamSession、绝不进 registry，
 * 故此处用一个确定性临时标记（前缀 + sessionId）满足请求形状，仅供适配器在本次调用内部
 * 关联句柄，消费完即弃。它绝不登记进 registry、绝不影响 canAccept、绝不落 C1（AC-13）。
 * 不经 IdGenerator 生成——本用例刻意不持有 IdGenerator，从结构上杜绝造用户可见 streamId。
 */
const TITLE_STREAM_ID_PREFIX = 'title-gen:';

/**
 * DEFAULT_TITLE_PROVIDER_ID —— 标题生成解析 provider 用的默认标识。
 *
 * TitleGenerationInput 只携带 sessionId + recentMessages，不含 providerId（端口契约固定，不重定义）；
 * 标题生成不承载用户的 provider/模型选择，故经空标识让 C7 按默认（env/单一配置 provider）解析。
 * 本期 C7 用只读 stub（返回写死单个 Claude provider，忽略入参），此空标识即可；真实 C7 的默认
 * 解析属后续（stub 顶替期，见 SPEC Non-goals）。
 */
const DEFAULT_TITLE_PROVIDER_ID = '';

/**
 * TITLE_RUN_MODE —— 标题生成的轻量模式：ask（无工具、简单一问一答）。
 * 对齐 StartStreamInput.mode 的 code/plan/ask 语义（原样透传，Runtime 侧解释）；标题只需一句轻量应答，选 ask。
 */
const TITLE_RUN_MODE = 'ask';

/**
 * buildTitlePrompt —— 用近期消息纯文本投影 + 标题提示，拼装一次性标题生成的 content。
 *
 * 提示词拼装是 C2 的职责（C1 只喂投影文本、绝不拼提示词，见 C1 SetSessionTitleService 注释）。
 * 只用 input 已投影的纯文本，绝不臆造富内容块。
 */
function buildTitlePrompt(recentMessages: TitleGenerationInput['recentMessages']): string {
  const transcript = recentMessages
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`)
    .join('\n');
  return `请为下面的对话生成一个简洁的中文标题（一行、不含引号、尽量短）：\n\n${transcript}`;
}

/**
 * toRuntimeRunKind —— 把 c2-4 resolveRuntimeKind 产出的 domain/runtime/ 处 RuntimeKind 值，
 * 等价映射为 RuntimeRunRequest 所需的 ports/runtime-kind.ts 处 RuntimeKind 值。
 *
 * 两处 enum 同名但为不同类型（既有技术债，本 epic 只复用不动它）；二者字面量值相同（本期 claude-sdk），
 * 此处按字面量在边界做值层面的等价传递，绝不 as any、绝不合并两个 enum。
 * switch 穷尽成员，新增成员时编译期在此报错，逼显式决策（与 start-stream.ts 同名桥接函数纪律一致）。
 */
function toRuntimeRunKind(kind: RuntimeKind): RuntimeRunKind {
  switch (kind) {
    case RuntimeKind.CLAUDE_SDK:
      return RuntimeRunKind.CLAUDE_SDK;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * GenerateTitleService —— 非流式一次性标题生成用例（纯编排，零框架）。
 *
 * 依赖仅两端口接口，经构造注入（对齐 architecture §8：
 * `TitleGenerator → GenerateTitleService(AgentRuntimePort(轻量非流式), ProviderRepository)`）：
 *  - runtime：AgentRuntimePort，发起一次原生调用、产出归一事件流。
 *  - providers：C7 只读 ProviderReadPort，解析默认 provider → 协议 / model。
 *
 * **刻意不持有 StreamSessionRegistry / IdGenerator / Clock**——从结构上杜绝造用户可见 streamId、
 * 建 StreamSession、进 registry、影响 canAccept（AC-13）。可用假端口做纯单元测试。
 */
export class GenerateTitleService implements TitleGenerator {
  private readonly runtime: AgentRuntimePort;
  private readonly providers: ProviderReadPort;

  constructor(runtime: AgentRuntimePort, providers: ProviderReadPort) {
    this.runtime = runtime;
    this.providers = providers;
  }

  /**
   * 非流式一次性生成标题字符串。
   *
   * 编排（architecture §6.5）：
   *  1. 经只读 ProviderReadPort.resolve 拿默认 provider 视图（只读，绝不调任何写方法）。
   *  2. 纯映射 protocol → RuntimeKind（复用 resolveRuntimeKind）；无法映射（返回 null）→ 抛出（交 C1 降级）。
   *  3. 组装轻量 RuntimeRunRequest：非注册临时 streamId、永不触发的 abortSignal、空 promptView、
   *     content = 标题提示 + 近期消息投影、options 仅 mode/model（其余选项保持缺省，不臆造）。
   *  4. 一次性消费 AgentRuntimePort.run 的归一事件流，只取 text 事件产物（累积后的全文，故取最后一个 text 值），
   *     消费完即弃。
   *
   * 【失败】run 抛错 / resolve 抛错 / 协议无法映射 → 向上抛出（绝不静默返回空串造假标题）。
   * 空/纯空白结果不在此判定为错误（Runtime 正常但无产出），原样 trim 返回，由 C1 侧空标题守卫兜底降级。
   */
  async generateTitle(input: TitleGenerationInput): Promise<string> {
    // 1. 只读解析默认 provider（绝不写 Provider）。
    const resolvedProvider: ResolvedProviderView = await this.providers.resolve(
      DEFAULT_TITLE_PROVIDER_ID,
    );

    // 2. protocol → RuntimeKind；无法映射（unknown / 非对话协议）→ 不静默选错，抛出交 C1 降级。
    const runtimeKind = resolveRuntimeKind(resolvedProvider);
    if (runtimeKind === null) {
      throw new Error(
        `无法为 provider 协议 "${resolvedProvider.protocol}" 选择对话 Runtime（标题生成，sessionId=${input.sessionId}）`,
      );
    }

    // 3. 组装轻量运行请求。streamId 为非注册临时标记（AC-13：不进 registry、不影响 canAccept）；
    //    abortSignal 永不触发（标题调用不接中断）；promptView 空（近期消息全放进 content）。
    const streamId: StreamSessionId = `${TITLE_STREAM_ID_PREFIX}${input.sessionId}`;
    const abortSignal: AbortSignalLike = {
      aborted: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const promptView: ReadonlyArray<PromptMessage> = [];
    const options: RuntimeRunOptions = {
      mode: TITLE_RUN_MODE,
      // 标题生成不带用户模型选择：取解析出的 provider 默认模型；无则空串交 Runtime/网关按 env 取默认
      // （反臆造：不编造假模型名）。其余可选项（effort/thinking/context1m/selectedSkills/systemPromptAppend）
      // 一律保持缺省。
      model: resolvedProvider.model ?? '',
    };
    const request: RuntimeRunRequest = {
      streamId,
      runtimeKind: toRuntimeRunKind(runtimeKind),
      resolvedProvider,
      promptView,
      content: buildTitlePrompt(input.recentMessages),
      options,
      abortSignal,
    };

    // 4. 一次性消费归一事件流，只取 text 产物。text 事件为「累积后的全文（非增量）」，
    //    故取最后一个 text 事件的全文即完整标题（绝不逐段拼接以免重复累积）。消费完即弃。
    let title = '';
    for await (const event of this.runtime.run(request)) {
      if (event.type === 'text') {
        title = event.text;
      }
    }
    return title.trim();
  }
}
