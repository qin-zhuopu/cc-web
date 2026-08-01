// conversation/domain/session/title-origin.ts
// C1 会话领域：标题来源枚举 + 覆盖优先级谓词。
// 对齐 architecture §3.2。零框架 import，仅值对象与纯谓词。

/**
 * 标题来源。优先级由低到高：default < ai < user。
 * - default：系统默认标题（如占位标题）。
 * - ai：AI 生成的标题。
 * - user：用户手工设置的标题。
 */
export type TitleOrigin = 'default' | 'ai' | 'user';

// 优先级权重：数值越大优先级越高。default(0) < ai(1) < user(2)。
const PRIORITY: Readonly<Record<TitleOrigin, number>> = {
  default: 0,
  ai: 1,
  user: 2,
};

/**
 * 判断 incoming 来源能否覆盖 current 来源的标题。
 *
 * 规则（优先级 default < ai < user）：
 * - 仅当 incoming 的优先级 >= current 时才允许覆盖。
 * - default 可被任何来源覆盖（含 default 自身）。
 * - ai 可被 ai / user 覆盖；严禁被 default 覆盖。
 * - user 严禁被 ai / default 覆盖；仅可被 user 自身覆盖（用户再次改名）。
 *
 * @param current  当前已存在标题的来源。
 * @param incoming 试图写入的新标题来源。
 * @returns 允许覆盖返回 true，否则 false。
 */
export function canOverrideTitle(
  current: TitleOrigin,
  incoming: TitleOrigin,
): boolean {
  return PRIORITY[incoming] >= PRIORITY[current];
}
