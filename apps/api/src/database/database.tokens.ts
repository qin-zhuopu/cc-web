// apps/api/src/database/database.tokens.ts
// Database DI token（对齐 shared-kernel/sk-tokens.ts 的 Symbol 约定）。
//
// 为何用 Symbol 常量作 DI token：better-sqlite3 的连接实例是运行时值，
// 但我们要经 NestJS 容器把「同一个连接」注入给多个仓储适配器（SqliteSessionRepository /
// SqliteMessageRepository），需要一个进程内唯一、运行时存在的注入标识。
//
// 边界：本文件在 apps/api（适配器层），better-sqlite3 依赖只落此层；packages/core 绝不出现。

/** Database 连接 token —— 绑定 better-sqlite3 的单例连接实例。 */
export const DATABASE = Symbol('DATABASE');
