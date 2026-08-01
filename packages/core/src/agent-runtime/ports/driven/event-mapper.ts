// agent-runtime/ports/driven/event-mapper.ts
// C2 · AgentRuntime 出站侧契约：EventMapper —— 外部 Runtime 原始事件 → 内部 AgentStreamEvent 归一。
// 对齐 architecture §3.5、§5.1、§7；PRD FR-4.2/4.3、AC-8。
//
// 【本故事（c2-3-2）范围】只定义 EventMapper 契约接口 + 未知事件降级语义骨架（纯函数），
// 不实现三 Runtime 具体 Mapper（ClaudeSdkEventMapper / NativeSseEventMapper / CodexEventMapper 属 c2-6，
// 位于基础设施层适配器内），不接 SDK / 子进程 / HTTP、不接 NestJS DI。
//
// 【铁律】核心零框架：本文件不 import @anthropic-ai/* / better-sqlite3 / @nestjs/* / node:child_process / codex / uuid。
// 只 import type 引用 c2-1-5 已定义的 AgentStreamEvent（绝不重定义联合成员、不改值对象签名）。
// 归一目标里唯有 phase_changed 由 C2 核心产出（相位迁移时），【绝不】由 EventMapper 伪造（见 phase-changed-event.ts）。

import type { AgentStreamEvent } from '../../domain/event/agent-stream-event.js';

/**
 * EventMapper —— 单个 Runtime 的原始事件归一契约（出站侧，由适配器实现）。
 *
 * 职责：把某个外部 Runtime（Claude SDK message / Native SSE 帧 / Codex JSON-RPC 通知）
 * 的**一条**原始事件，归一为内部统一的 AgentStreamEvent，或表示「无归一结果」（返回 null）。
 * 具体各 Runtime 实现属 c2-6，位于 apps/api 适配器层；核心只定义此契约 + 降级语义。
 *
 * 【降级铁律（AC-8 / FR-4.3）】面对无法识别的原始事件，实现必须：
 *   1. 绝不抛异常——一条坏事件不得中断整条回合事件流；
 *   2. 绝不伪造已识别事件——不得凭空造 text/result/error 等改变回合语义；
 *   3. 绝不静默改变已识别事件的语义——识别到的事件按其本义归一，不得张冠李戴；
 *   4. 未识别 / 非预期 / 空 / 非对象输入 → 返回 null（安全丢弃，跳过该条）。
 *
 * 【为何降级即返回 null（当前无 raw 载体）】c2-1-5 定义的 14 类 AgentStreamEvent 联合
 * 【不含】任何 raw / unknown 载体成员，无处安放「原样保留的未知原始事件」。故核心侧唯一
 * 安全路径是返回 null（丢弃 / 跳过）。若未来确需保留 raw 原文（如调试透传），需新增联合载体成员——
 * 那属 correct-course 范畴，本 epic【不擅自扩联合】，仅在此约定 null 降级语义。
 *
 * 无状态与幂等性：mapEvent 应为纯映射（同一 raw 归一为等价结果），不持有跨事件可变状态；
 * 若某 Runtime 需累积（如 text 全文），累积口径由适配器自身持有，不改变本契约的纯映射语义。
 */
export interface EventMapper {
  /**
   * 归一一条 Runtime 原始事件。
   *
   * @param raw 外部 Runtime 的一条原始事件（对核心不透明，类型为 unknown）。
   * @returns 归一后的 AgentStreamEvent；无法识别 / 非预期输入时返回 null（降级丢弃，不抛、不伪造）。
   */
  mapEvent(raw: unknown): AgentStreamEvent | null;
}

/**
 * dropUnknownEvent —— 契约层的「未知事件降级」纯函数骨架（AC-8）。
 *
 * 任何 EventMapper 实现在其分支穷尽后（走到 default / 无匹配分支）应调用本函数收口：
 * 统一返回 null，表达「安全丢弃这条未识别原始事件」。集中此处，便于：
 *   - 语义单点可读（降级 = 返回 null，非抛、非伪造）；
 *   - 未来若引入 raw 载体（correct-course）只改这一处收口，不散落各适配器。
 *
 * 本函数【故意不接受参数、不做日志、不抛异常】——契约层保持零副作用、零框架依赖；
 * 观测（如 RuntimeLog 记一条 debug）由适配器在调用点自行决定，不侵入核心契约。
 *
 * @returns 恒为 null（降级：丢弃 / 跳过该条原始事件）。
 */
export function dropUnknownEvent(): null {
  return null;
}
