// apps/api/src/conversation/conversation.tokens.ts
// C1 Conversation DI token（对齐 shared-kernel/sk-tokens.ts 的 Symbol 约定）。
//
// 为何用 Symbol 常量作 token：核心包的端口均为 TS interface，运行时被擦除，无法充当
// NestJS 注入 token。故此处为每个出站端口/驱动用例/跨边界端口声明进程内唯一的 Symbol。
//
// 边界：本文件在 apps/api，仅常量声明，不含 @nestjs import。核心包绝不出现这些 token。

// —— 出站端口（driven）——
/** SessionRepository 出站端口 token —— 绑 SqliteSessionRepository。 */
export const SESSION_REPOSITORY = Symbol('C1.SessionRepository');
/** MessageRepository 出站端口 token —— 绑 SqliteMessageRepository。 */
export const MESSAGE_REPOSITORY = Symbol('C1.MessageRepository');
/**
 * TitleGeneratorPort token —— 权威实现归 C2（GenerateTitleService，尚未落地）。
 * 本 epic 暂绑 StubTitleGenerator（触发降级路径），C2 落地后替换为 forwardRef 注入的真实现。
 */
export const TITLE_GENERATOR = Symbol('C1.TitleGeneratorPort');

// —— 驱动用例（driving）——
/** ManageSessionUseCase token —— 绑 ManageSessionService。 */
export const MANAGE_SESSION_USECASE = Symbol('C1.ManageSessionUseCase');
/** SetSessionTitleUseCase token —— 绑 SetSessionTitleService。 */
export const SET_SESSION_TITLE_USECASE = Symbol('C1.SetSessionTitleUseCase');
/** AppendMessageUseCase token —— 绑 AppendMessageService。 */
export const APPEND_MESSAGE_USECASE = Symbol('C1.AppendMessageUseCase');
/** GetSessionHistoryUseCase token —— 绑 GetSessionHistoryService。 */
export const GET_SESSION_HISTORY_USECASE = Symbol('C1.GetSessionHistoryUseCase');
