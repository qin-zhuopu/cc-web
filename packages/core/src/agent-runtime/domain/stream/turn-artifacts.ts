// agent-runtime/domain/stream/turn-artifacts.ts
// C2 · AgentRuntime —— 累积产物值对象 TurnArtifacts + 纯函数 buildFinalContent。
// 对齐 architecture §3.4、PRD FR-2.6 / FR-4。
//
// 【本故事（c2-1-4）范围】只定义只读值对象与无副作用纯函数投影。
// 不实现 StreamSession.apply 的累积行为（属 epic-c2-2），不接 SDK / NestJS DI。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* / node:child_process / codex。
// 不取 Clock（无时间戳）、不生成 id（纯投影）；ToolUseInfo / ToolResultInfo 用 import type + .js 扩展名。
// 绝不落库、绝不 import C1 的持久 StreamStatus（NFR-2 / AC-15）。

import type { ToolUseInfo, ToolResultInfo } from '../event/agent-stream-event.js';

/**
 * TurnArtifacts —— 一次回合累积产物的只读值对象（对齐 architecture §3.4）。
 *
 * 由 StreamSession.apply 在消费归一事件时累积（累积行为属 epic-c2-2）：
 *  - text：累积后的全文（非增量）。空回合为空串。
 *  - thinking：累积后的思考全文。空则为空串。
 *  - toolUses：本回合发起的工具调用序列（保持产出顺序）。
 *  - toolResults：本回合的工具结果序列（保持产出顺序；孤儿结果亦在其中）。
 */
export interface TurnArtifacts {
  readonly text: string;
  readonly thinking: string;
  readonly toolUses: ReadonlyArray<ToolUseInfo>;
  readonly toolResults: ReadonlyArray<ToolResultInfo>;
}

/**
 * 落 C1 的内容块判别联合的本地投影形状（对齐 C1 ContentBlock 的 JSON 结构）。
 *
 * 【为何不 import C1 类型】buildFinalContent 的产出是「序列化后交 C1.AppendMessageUseCase
 * 的 JSON 字符串」，这里刻画的是该 JSON 的形状契约，而非引用 C1 领域类型——C2 类型层
 * 保持对 C1 领域实体零耦合（只在端口层 import type C1 用例），故在本地按 §3.4 的块结构
 * 定义投影形状。字段名与 C1 ContentBlock 逐字对齐以保证反序列化一致。
 */
interface TextContentBlock {
  readonly type: 'text';
  readonly text: string;
}
interface ThinkingContentBlock {
  readonly type: 'thinking';
  readonly thinking: string;
}
interface ToolUseContentBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}
interface ToolResultContentBlock {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
}
type FinalContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock;

/**
 * buildFinalContent —— 把累积产物投影成落 C1 的最终消息内容（对齐 architecture §3.4）。
 *
 * 五路投影（无副作用纯函数）：
 *  1. 纯文本回合（仅 text、无 thinking / 无 tool_use / 无 tool_result）→ 直接返回 text 原文。
 *  2. 含 thinking / tool 的复合回合 → 组装有序 blocks[]（text → thinking → tool_use* → tool_result*）
 *     并序列化为 JSON 字符串。
 *  3. 孤儿 tool_result（无匹配的 tool_use）→ 仍作为独立块保留（toolResults 全量入块，不做配对过滤）。
 *  4. 混合回合 → 按上述顺序合并各类块序列化。
 *  5. 全空回合（text/thinking 皆空且无任何 tool_use / tool_result）→ 返回 null（空回合不落库，FR-2.6）。
 *
 * @returns 纯文本回合返回文本原文；复合回合返回 blocks[] 的 JSON 字符串；空回合返回 null。
 */
export function buildFinalContent(artifacts: TurnArtifacts): string | null {
  const hasText = artifacts.text.length > 0;
  const hasThinking = artifacts.thinking.length > 0;
  const hasToolUses = artifacts.toolUses.length > 0;
  const hasToolResults = artifacts.toolResults.length > 0;

  // 5. 全空回合 → null（空回合不落库，FR-2.6）
  if (!hasText && !hasThinking && !hasToolUses && !hasToolResults) {
    return null;
  }

  // 1. 纯文本回合 → 直接返回文本原文
  if (hasText && !hasThinking && !hasToolUses && !hasToolResults) {
    return artifacts.text;
  }

  // 2./3./4. 复合回合 → 有序 blocks[] 序列化（text → thinking → tool_use* → tool_result*）
  const blocks: FinalContentBlock[] = [];

  if (hasText) {
    blocks.push({ type: 'text', text: artifacts.text });
  }
  if (hasThinking) {
    blocks.push({ type: 'thinking', thinking: artifacts.thinking });
  }
  for (const toolUse of artifacts.toolUses) {
    blocks.push({
      type: 'tool_use',
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
    });
  }
  // 孤儿 tool_result 亦全量保留为独立块（不与 tool_use 配对过滤）
  for (const toolResult of artifacts.toolResults) {
    blocks.push({
      type: 'tool_result',
      toolUseId: toolResult.toolUseId,
      content: toolResult.content,
      isError: toolResult.isError,
    });
  }

  return JSON.stringify(blocks);
}
