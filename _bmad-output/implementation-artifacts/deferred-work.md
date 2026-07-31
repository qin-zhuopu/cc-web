# 延后工作清单（Deferred Work）

> 由 bmad-quick-dev 评审流程追加。每条记录一个真实但非当前故事范围的发现，供后续 story 聚焦处理。追加式，勿改既有条目。

- source_spec: `spec-sk-1-1-define-16-error-codes-and-domain-types.md`
  summary: import 静态守卫升级为 ESLint 规则并扩展拦截能力（node:* 内建、别名绕过 Date.now/Math.random、blocklist 改 allowlist、.mts/.cts 扫描、跨行/块注释）。
  evidence: 本轮守卫为零依赖正则脚本，够用于 sk-1-1 门禁但存在多条已知绕过面（别名调用、node:fs 等内建、backtick 模块说明符、非白名单第三方包）。SK-4 story 4.3「禁用 import 静态检查守卫」正是这条能力的正式落地位；spec Design Notes 已声明「后续 SK-4 可升级为 ESLint 规则」。本轮只做到零依赖脚本级门禁。
