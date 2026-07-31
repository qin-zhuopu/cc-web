# 延后工作清单（Deferred Work）

> 由 bmad-quick-dev 评审流程追加。每条记录一个真实但非当前故事范围的发现，供后续 story 聚焦处理。追加式，勿改既有条目。

- source_spec: `spec-sk-1-1-define-16-error-codes-and-domain-types.md`
  summary: import 静态守卫升级为 ESLint 规则并扩展拦截能力（node:* 内建、别名绕过 Date.now/Math.random、blocklist 改 allowlist、.mts/.cts 扫描、跨行/块注释）。
  evidence: 本轮守卫为零依赖正则脚本，够用于 sk-1-1 门禁但存在多条已知绕过面（别名调用、node:fs 等内建、backtick 模块说明符、非白名单第三方包）。SK-4 story 4.3「禁用 import 静态检查守卫」正是这条能力的正式落地位；spec Design Notes 已声明「后续 SK-4 可升级为 ESLint 规则」。本轮只做到零依赖脚本级门禁。

- source_spec: `epic-sk-4/SPEC.md`
  summary: SharedKernelModule 冒烟测试补 TranslationPort（真实 JsonTranslationTable 适配器）的 AC-5 行为断言；check-core-imports.mjs 块注释扫描顺延项措辞更新。
  evidence: SK-4 对抗评审低优先项。TranslationPort 的 AC-5（缺失键返回键名、has 返回 false）目前只在核心端口测试的内联 FakeTranslation 上验证，真实占位适配器 JsonTranslationTable 仅有 toBeDefined 断言，缺行为断言。中等问题（JsonTranslationTable 未 implements）已在本轮修复。

- source_spec: `epic-sk-4/SPEC.md`
  summary: SK-4 的 6 个占位适配器（SystemClock/UuidGenerator/NodePlatform/RegexRedactor/RingBufferRuntimeLog/JsonTranslationTable）为 DI 装配用最小实现，需在后续 story 替换为生产级实现（真实脱敏正则、有界环形缓冲、locale 文案表等）。
  evidence: 本轮 SK-4 重点是 SharedKernelModule 接线骨架，占位适配器让 DI 图能装配、能被解析、能被替换。生产级适配器实现（含各自完整单测）属后续工作。
