// agent-runtime/domain/runtime/runtime-kind.ts
// C2 · AgentRuntime —— Runtime 种类枚举（对齐 architecture §3.6）。
// 零框架 import；仅枚举常量。发起回合时锁定，落入 StreamSession 快照。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* / node:child_process / codex。

/**
 * RuntimeKind —— 一次回合选用的运行时种类（发起时锁定，见 architecture §3.2 / §3.6）。
 *
 * - CLAUDE_SDK：@anthropic-ai/claude-agent-sdk 的 Query 句柄（适配器在 apps/api）。
 * - NATIVE：Native HTTP provider 的 SSE 流。
 * - CODEX：Codex app-server 子进程（进程复杂度全隔离在适配器内）。
 */
export enum RuntimeKind {
  CLAUDE_SDK = 'claude-sdk',
  NATIVE = 'native',
  CODEX = 'codex',
}
