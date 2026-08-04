// agent-runtime/domain/runtime/runtime-kind.ts
// C2 · AgentRuntime —— Runtime 种类枚举（对齐 architecture §3.6）。
// 零框架 import；仅枚举常量。发起回合时锁定，落入 StreamSession 快照。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* / node:child_process。

/**
 * RuntimeKind —— 一次回合选用的运行时种类（发起时锁定，见 architecture §3.2 / §3.6）。
 *
 * - CLAUDE_SDK：本期唯一实现，@anthropic-ai/claude-agent-sdk 的 Query 句柄（适配器在 apps/api）。
 *
 * AgentRuntimePort 是预留的**未具名扩展点**：将来新增 agent 时再扩枚举成员，
 * 现在不预设任何具体 agent 名（避免把"将来可能用什么"固化进核心）。
 */
export enum RuntimeKind {
  CLAUDE_SDK = 'claude-sdk',
}
