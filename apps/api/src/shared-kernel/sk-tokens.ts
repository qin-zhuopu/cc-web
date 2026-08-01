// apps/api/src/shared-kernel/sk-tokens.ts
// SharedKernel DI token 常量（对齐 architecture.md §5、AC-10）。
//
// 为何用 Symbol 常量而非接口本身作 DI token：
//   核心包（packages/core）里 7 个端口均为 TS interface，interface 在运行时被擦除，
//   无法充当 NestJS 的注入 token（NestJS token 需运行时存在的值）。故此处为每个端口
//   声明一个进程内唯一的 Symbol 常量作 token，Provider 用它绑定实现、消费者用它注入。
//
// 边界：本文件在 apps/api（SK 唯一带 NestJS 框架的部分），不含 @nestjs import，
//       仅为纯常量声明。核心包内绝不出现这些 token 或任何 @nestjs 依赖（AC-10）。

/** ErrorClassifier 端口 token —— 绑定核心包纯函数 defaultErrorClassifier。 */
export const ERROR_CLASSIFIER = Symbol('SK.ErrorClassifier');

/** Clock 端口 token —— 统一时间来源。 */
export const CLOCK = Symbol('SK.Clock');

/** IdGenerator 端口 token —— 全局唯一 ID 生成。 */
export const ID_GENERATOR = Symbol('SK.IdGenerator');

/** Platform 端口 token —— 只读平台信息。 */
export const PLATFORM = Symbol('SK.Platform');

/** Redactor 端口 token —— 敏感信息脱敏。 */
export const REDACTOR = Symbol('SK.Redactor');

/** RuntimeLog 端口 token —— 有界环形运行时日志。 */
export const RUNTIME_LOG = Symbol('SK.RuntimeLog');

/** TranslationPort 端口 token —— 文案翻译。 */
export const TRANSLATION_PORT = Symbol('SK.TranslationPort');
