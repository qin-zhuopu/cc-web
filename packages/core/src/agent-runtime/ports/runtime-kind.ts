// agent-runtime/ports/runtime-kind.ts
// C2 · AgentRuntime —— RuntimeKind 枚举 + RuntimeAvailability 可用性值对象。
// 对齐 architecture §3.6。零框架 import；仅枚举 / 判别联合类型。
//
// 【本故事（c2-1-6）范围】只定义 RuntimeKind 枚举与 RuntimeAvailability 值对象，
// 供驱动/出站端口签名引用。不实现可用性探测（属适配器层）、不接 SDK、不接 NestJS DI。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* /
// node:child_process；不取 Clock、不生成 id。字段全 readonly。

/**
 * RuntimeKind —— 一次回合发起时锁定的运行时种类（对齐 architecture §3.6）。
 *
 * 由 StartStreamService 经 C7.ProviderRepository 解析 providerId 后选定（FR-2.2），
 * 之后 AgentRuntimePort 依此路由到对应适配器：
 *  - CLAUDE_SDK：ClaudeSdkRuntimeAdapter（封装 @anthropic-ai/claude-agent-sdk 的 Query）。
 *
 * AgentRuntimePort 是预留的**未具名扩展点**：本期只实现 CLAUDE_SDK 一个具体运行时，
 * 将来新增 agent 时由其适配器声明自己的枚举成员；枚举不预先具名任何尚未实现的 agent。
 *
 * 采用 TS enum（对齐架构 §3.6 原文与 StreamPhaseKind / TerminalSubstate 风格），
 * 字面量值与运行时路由键对齐。
 */
export enum RuntimeKind {
  CLAUDE_SDK = 'claude-sdk',
}

/**
 * RuntimeAvailability —— 运行时可用性探测结果值对象（判别联合，对齐 architecture §3.6）。
 *
 * 由 AgentRuntimePort.availability() 产出，供 RuntimeController 暴露可用性。
 *
 * 三态语义：
 *  - ready：探测成功，可用；version 为探到的版本（Runtime 提供时；未知则省略）。
 *  - unavailable：探测失败，不可用；reason 为失败原因（已脱敏文案 / key）。
 *    【反假数据】探测失败绝不显假 ready——必须落 unavailable 并带 reason。
 *  - unknown：尚未探测 / 无法判定，UI 据此显「未知」而非假定可用。
 *
 * 所有字段 readonly——可用性值对象不可变。
 */
export type RuntimeAvailability =
  | { readonly kind: 'ready'; readonly version?: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'unknown' };
