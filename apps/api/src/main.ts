// apps/api 占位入口。
// 本轮 sk-1-1 仅让 workspace 结构成立、可被 tsconfig 引用；
// 不接 NestJS DI、不装配 SharedKernelModule、不含任何业务逻辑（属后续 story）。
export const API_PLACEHOLDER = 'codepilot-api' as const;
