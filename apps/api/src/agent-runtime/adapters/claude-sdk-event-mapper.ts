// apps/api/src/agent-runtime/adapters/claude-sdk-event-mapper.ts
// C2 · ClaudeSdkEventMapper —— @anthropic-ai/claude-agent-sdk 的 SDKMessage → 核心 AgentStreamEvent 归一（epic-c2-6 / c2-6-1a）。
//
// 【边界】本文件在 apps/api（框架/基础设施层），可 import @anthropic-ai/*（仅取其 message 类型）。
//   核心包 packages/core 零框架、绝不出现 SDK 细节；本 mapper 把 SDK 私有 message 结构锁在此处，
//   对外只吐已归一的 AgentStreamEvent。只 import type 核心契约/类型 + 值 import 构造工厂/投影纯函数复用，
//   绝不重定义 14 类联合、不重写归一/投影规则。
//
// 【契约张力与决策】核心 EventMapper.mapEvent(raw): AgentStreamEvent | null 是「1 条进、0/1 条出」，
//   但一条完整 SDK `assistant` 消息（BetaMessage）可含多个 content block（text + 若干 thinking + 若干 tool_use），
//   天然要展开成多个核心事件。故本类：
//     - 主方法 mapMessage(raw): AgentStreamEvent[] —— 适配器用它，能把一条 SDK 消息展开成 0..N 个核心事件。
//     - 同时 implements 核心 EventMapper：mapEvent(raw) 委派 mapMessage，恰好 1 个时返回该事件、否则返回 null
//       （满足 implements 契约；适配器实际走 mapMessage 拿全量）。
//   本期映射【完整 assistant 消息】作为内容真相源（其 text 天然是全文，契合核心 text=累积全文 语义），
//   mapper 保持无状态、可表驱动测试；逐字增量流式（stream_event/SSE）留待 EPIC-ACCEPT。
//
// 【Kimi-K2.6 特性】litellm 网关路由的 Kimi 会带思维链——Anthropic 风格 thinking block 或
//   OpenAI 风格 reasoning_content（挂在 message 或 content 上）——都归一到 thinking 事件；正文归 text。
//
// 【降级铁律 AC-8】未识别 / 非对象 / 空 message → 返回空数组（mapEvent 返回 null），绝不抛、不伪造、不改语义。

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  BetaMessage,
  BetaContentBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import type { EventMapper } from '@codepilot/core';
import type {
  AgentStreamEvent,
  RuntimeTokenUsage,
  ToolUseInfo,
  ToolResultInfo,
} from '@codepilot/core';
import { dropUnknownEvent } from '@codepilot/core';

/**
 * 从 BetaUsage（NonNullableUsage）投影核心 TokenUsage（AC-9 反假数据）。
 *
 * 仅当 SDK 真实上报 input/output（>=0 的有限数）时才构造 TokenUsage；否则返回 undefined，
 * result 事件整体省略 tokenUsage 字段，绝不填 0。缓存/合计字段有值才带。
 * 不在此侧计算 totalTokens——只透传 SDK 上报的原始计数（口径归上游）。
 */
function projectUsage(usage: unknown): RuntimeTokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) {
    return undefined;
  }
  const u = usage as Record<string, unknown>;
  const input = u.input_tokens;
  const output = u.output_tokens;
  // 反假数据：input/output 是 TokenUsage 必填项，SDK 未上报（非有限数）则整体省略，不填 0。
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return undefined;
  }
  if (typeof output !== 'number' || !Number.isFinite(output)) {
    return undefined;
  }
  const projected: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    totalTokens?: number;
  } = {
    inputTokens: input,
    outputTokens: output,
  };
  const cacheRead = u.cache_read_input_tokens;
  if (typeof cacheRead === 'number' && Number.isFinite(cacheRead)) {
    projected.cacheReadInputTokens = cacheRead;
  }
  const cacheCreation = u.cache_creation_input_tokens;
  if (typeof cacheCreation === 'number' && Number.isFinite(cacheCreation)) {
    projected.cacheCreationInputTokens = cacheCreation;
  }
  return projected;
}

/** 从 tool_result 的 content（string | 结构化块数组）投影出纯文本字符串。 */
function toolResultContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    // 结构化块：拼接其中的 text 块（其余块类型对终态文本无贡献，跳过）。
    return content
      .map((block) => {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>).type === 'text' &&
          typeof (block as Record<string, unknown>).text === 'string'
        ) {
          return (block as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * 把一个 assistant content block 归一为对应核心事件（text / thinking / tool_use / tool_result）。
 * 无法归一的块类型返回 null（跳过）。thinking 块的 delta 载荷用其完整 thinking 文本
 *（本期映射完整消息，非逐字增量；delta 语义在完整消息下即该块全文）。
 */
function mapContentBlock(block: BetaContentBlock): AgentStreamEvent | null {
  const b = block as unknown as Record<string, unknown>;
  switch (b.type) {
    case 'text': {
      const text = b.text;
      if (typeof text !== 'string') return null;
      return { type: 'text', text };
    }
    case 'thinking': {
      // Anthropic 风格思维链块：{ type:'thinking', thinking:string }。
      const thinking = b.thinking;
      if (typeof thinking !== 'string') return null;
      return { type: 'thinking', delta: thinking };
    }
    case 'redacted_thinking': {
      // 脱敏思维链：无明文，跳过（不伪造内容）。
      return null;
    }
    case 'tool_use': {
      const id = b.id;
      const name = b.name;
      const input = b.input;
      if (typeof id !== 'string' || typeof name !== 'string') return null;
      const tool: ToolUseInfo = {
        id,
        name,
        input:
          typeof input === 'object' && input !== null
            ? (input as Readonly<Record<string, unknown>>)
            : {},
      };
      return { type: 'tool_use', tool };
    }
    case 'tool_result': {
      const toolUseId = b.tool_use_id;
      if (typeof toolUseId !== 'string') return null;
      const result: ToolResultInfo = {
        toolUseId,
        content: toolResultContentToText(b.content),
        isError: b.is_error === true,
      };
      return { type: 'tool_result', result };
    }
    default:
      return null;
  }
}

/**
 * ClaudeSdkEventMapper —— SDKMessage → AgentStreamEvent 归一（实现核心 EventMapper 契约）。
 *
 * 无状态、纯映射：同一 SDKMessage 归一为等价事件序列，不持有跨事件可变状态。
 */
export class ClaudeSdkEventMapper implements EventMapper {
  /**
   * 把一条 SDKMessage 归一为 0..N 个核心 AgentStreamEvent（适配器主用）。
   *
   * - assistant：展开 message.content 的各块 → text/thinking/tool_use/tool_result 事件；
   *   若消息带 OpenAI 风格 reasoning_content（Kimi）→ 追加一个 thinking 事件（正文块仍走 text）。
   * - result：终态事件，投影 usage（无上报省略，AC-9）。
   * - system(permission_denied) 等：本期不产出核心事件（权限中转属 c2-7），返回空。
   * - 未识别 / 非对象 → 空数组（降级，不抛不伪造）。
   */
  mapMessage(raw: unknown): AgentStreamEvent[] {
    if (typeof raw !== 'object' || raw === null) {
      return [];
    }
    const msg = raw as SDKMessage & Record<string, unknown>;
    switch (msg.type) {
      case 'assistant': {
        const events: AgentStreamEvent[] = [];
        // Kimi/OpenAI 风格思维链：reasoning_content 可能挂在 SDK 消息或其 message 上。
        const reasoning = extractReasoningContent(msg);
        if (reasoning) {
          events.push({ type: 'thinking', delta: reasoning });
        }
        const betaMessage = msg.message as BetaMessage | undefined;
        const content = betaMessage?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const event = mapContentBlock(block as BetaContentBlock);
            if (event !== null) {
              events.push(event);
            }
          }
        }
        return events;
      }
      case 'result': {
        const tokenUsage = projectUsage((msg as Record<string, unknown>).usage);
        // 反假数据：无上报则 tokenUsage 字段整体省略（不带 undefined 键也可，此处显式条件构造）。
        return tokenUsage !== undefined
          ? [{ type: 'result', tokenUsage }]
          : [{ type: 'result' }];
      }
      default:
        // stream_event（逐字增量，本期不逐字归一）、system、user 等：本期不产出核心事件。
        return [];
    }
  }

  /**
   * 核心 EventMapper 契约实现：1 条进、0/1 条出。
   * 委派 mapMessage——恰好 1 个事件时返回它；0 或多个时返回 null（多事件请走 mapMessage）。
   * 降级（未识别/非对象）经 mapMessage 返回空 → 这里落到 dropUnknownEvent()（返回 null，不抛不伪造，AC-8）。
   */
  mapEvent(raw: unknown): AgentStreamEvent | null {
    const events = this.mapMessage(raw);
    const only = events.length === 1 ? events[0] : undefined;
    return only ?? dropUnknownEvent();
  }
}

/**
 * 从 SDK assistant 消息尽力提取 OpenAI 风格思维链文本（Kimi-K2.6 经 litellm 可能带 reasoning_content）。
 * 挂点不固定：可能在 SDK 消息顶层，也可能在其 message 上。提取纯字符串，非字符串/缺失返回空串。
 */
function extractReasoningContent(msg: Record<string, unknown>): string {
  const top = msg.reasoning_content;
  if (typeof top === 'string' && top.length > 0) {
    return top;
  }
  const inner = msg.message;
  if (typeof inner === 'object' && inner !== null) {
    const r = (inner as Record<string, unknown>).reasoning_content;
    if (typeof r === 'string' && r.length > 0) {
      return r;
    }
  }
  return '';
}
