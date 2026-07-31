export const meta = {
  name: 'sk-4-i18n-di-guard',
  description: 'SK-4：串行实现 TranslationPort 端口→SharedKernelModule DI 接线(apps/api)→守卫补强，跑门禁再对抗评审',
  phases: [
    { title: 'TranslationPort', detail: 'sk-4-1 定义 TranslationPort 端口(核心包)' },
    { title: 'DIWiring', detail: 'sk-4-2 SharedKernelModule 绑定 7 端口(apps/api,含 NestJS)' },
    { title: 'GuardAlign', detail: 'sk-4-3 import 守卫补强与 AC-10 对齐' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审端口契约、DI 接线与 AC-10' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const CORE_RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
核心包铁律（packages/core，import 守卫 scripts/check-core-imports.mjs 会拦）：禁止 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid；禁止在核心内直调 Date.now()/new Date()/randomUUID（注释里也别出现连写 "Date.now(" 字样，用中文「系统时钟」描述）。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + 模块说明符带 .js 扩展名，否则 tsc --build 报错。strict、ES2022、NodeNext。
术语纪律：禁用「上下文」指代 bounded context，用全称（Shared Kernel/Conversation/AgentRuntime）或「领域边界」。注释中文。
测试用 vitest，测试文件与被测同目录 *.test.ts。不要运行 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段统一处理）。
`

// ---- sk-4-1 TranslationPort（核心包，零框架）----
phase('TranslationPort')
const r1 = await agent(
  `${CORE_RULES}

任务 sk-4-1：在核心包定义 TranslationPort 端口。对齐 architecture.md §4.4、prd.md FR-4、AC-5。零框架。

创建 packages/core/src/ports/translation-port.ts：
\`\`\`ts
export type Locale = string; // 如 'zh' | 'en'

export interface TranslationPort {
  /**
   * 按键 + 语言返回文案；支持插值参数。
   * 缺失键：返回 key 本身（不抛、不返回空串）。见 FR-4.3。
   */
  translate(key: string, locale: Locale, params?: Readonly<Record<string, string | number>>): string;
  /** 缺失键判定，供上层探测能力。 */
  has(key: string, locale: Locale): boolean;
}
\`\`\`
- 只定义 Locale 类型别名与 TranslationPort 接口。JSDoc 中文注释：SK 只贡献 SK_MESSAGE_KEYS，具体 locale 文案表由 apps/api 的 JsonTranslationTable 适配器提供（FR-4.2）；缺失键返回键名本身、不抛异常、不返回空串（AC-5/FR-4.3）；支持插值参数（FR-4.1）。本文件不含任何文案表与适配器实现。
- 零框架 import。

创建 translation-port.test.ts：用内联测试替身（一个最小 fakeTranslation 实现 TranslationPort，内部一张小 Map 文案表 + 插值）验证端口语义契约：
- AC-5：translate 一个不存在的 key → 返回该 key 本身（不抛、非空串）；has 该 key → false。
- 存在的 key → 返回文案；带 params 时插值生效。
- has 对存在/不存在返回 true/false。
测试替身仅在测试文件内，不进 src。`,
  { label: 'sk-4-1:translation-port', phase: 'TranslationPort' }
)

// ---- sk-4-2 SharedKernelModule DI（apps/api，带 NestJS）----
phase('DIWiring')
const r2 = await agent(
  `${CORE_RULES}

任务 sk-4-2：在 apps/api 装配 SharedKernelModule，绑定并 exports 全部 7 个 SK 端口 token。对齐 architecture.md §5、AC-10。
**重要边界**：本任务的代码在 apps/api（这是 SK 唯一带 NestJS 框架的部分）。packages/core 内绝对不得出现 @nestjs import（AC-10）——你只在 apps/api 下写 @nestjs 代码。apps/api 已装 @nestjs/common@10.4.15、@nestjs/core、reflect-metadata、rxjs。

背景：核心包 packages/core 已导出 7 个端口的接口类型：ErrorClassifier（+defaultErrorClassifier 值）、Clock、IdGenerator、Platform、Redactor、RuntimeLog、TranslationPort。SK-1 已提供纯函数 defaultErrorClassifier。其余端口的适配器（SystemClock/UuidGenerator/NodePlatform/RegexRedactor/RingBufferRuntimeLog/JsonTranslationTable）本轮尚未实现——本任务的重点是**接线骨架**：用 NestJS Provider 把每个端口 token 绑定到实现。

具体做法（务实、可编译、可测）：
1. 因 NestJS 用 interface 做 token 不便（TS interface 运行时擦除），用 InjectionToken 常量（Symbol 或字符串常量）作为每个端口的 DI token。创建 apps/api/src/shared-kernel/sk-tokens.ts 定义 7 个 token 常量（如 export const CLOCK = Symbol('SK.Clock') 等）。
2. 创建 apps/api/src/shared-kernel/shared-kernel.module.ts：一个 @Module，providers 把 7 个 token 绑定到实现：
   - ERROR_CLASSIFIER → useValue: defaultErrorClassifier（核心包已提供，真实可用）。
   - 其余 6 个端口的生产适配器尚未实现，本轮用**最小占位实现**（在 apps/api/src/shared-kernel/adapters/ 下各写一个最小类实现对应接口：SystemClock 用 Date.now()（注意：这是 apps/api 适配器层，允许直调系统时钟，不受核心包铁律约束）、UuidGenerator 用 node:crypto randomUUID、NodePlatform 读 process.platform/arch、RegexRedactor 做最小占位脱敏、RingBufferRuntimeLog 简单环形数组、JsonTranslationTable 空表返回 key）。这些占位适配器让 DI 图能装配、能被后续 epic 替换。useClass 绑定。
   - 全部 7 个 token providers + exports，供其余 Module imports 后注入。
3. 创建 apps/api/src/shared-kernel/shared-kernel.module.spec.ts：用 @nestjs/core 的 Test/编程式 NestFactory 或直接实例化验证：SharedKernelModule 能装配，从中解析出 7 个 token 都得到实现实例，且 ErrorClassifier token 解析出的能 classify（复用核心 defaultErrorClassifier）。
   - 注意 vitest + NestJS 需要 reflect-metadata（在测试文件顶部 import 'reflect-metadata'）、tsconfig 需 experimentalDecorators/emitDecoratorMetadata。若 apps/api/tsconfig.json 缺这两项，请补上（仅 apps/api，不动 base/core）。
4. apps/api/src/main.ts 可保持占位或轻量引用 SharedKernelModule，不强制。

铁律自检：确认 packages/core 下没有任何新增 @nestjs import（守卫会拦）。适配器里的 Date.now/randomUUID 只出现在 apps/api，不在 packages/core。
报告你创建的文件、7 个 token 的绑定方式、以及 apps/api 测试如何验证装配。`,
  { label: 'sk-4-2:di-wiring', phase: 'DIWiring' }
)

// ---- sk-4-3 守卫补强与 AC-10 对齐 ----
phase('GuardAlign')
const r3 = await agent(
  `${CORE_RULES}

任务 sk-4-3：import 守卫补强与 AC-10 验收对齐。守卫已存在于 scripts/check-core-imports.mjs（零依赖 Node 脚本，已接入 npm run test，配套 scripts/check-core-imports.test.ts）。本故事**不从零重写**，做补强与对齐：

1. 读 scripts/check-core-imports.mjs 现状，核对：
   - 扫描根是否覆盖 packages/core/src 全部（现在新增了 ports/translation-port.ts、domain/log/ 等，确认都在扫描范围）。
   - 禁用清单是否与 architecture.md 铁律一致：@nestjs/*、better-sqlite3、@anthropic-ai/*、uuid，及 Date.now(/randomUUID。
   - 空扫描是否仍视为失败、是否已在 npm run test 门禁内。
2. 关键补强点：sk-4-2 刚在 apps/api 引入了 @nestjs 与 randomUUID/Date.now（合法，因为在适配器层）。**确认守卫只扫 packages/core、不误伤 apps/api**（守卫的 scanRoot 应是 packages/core/src，apps/api 不在其内）。如果发现守卫会误扫 apps/api，修正 scanRoot 使其只限 packages/core。
3. 若发现任何真实缺口（新目录未覆盖、清单不全）则补齐，并给 scripts/check-core-imports.test.ts 补对应回归用例（如「apps/api 的 @nestjs import 不被 core 守卫拦截」这类边界，若可测）。
4. 不要削弱现有守卫能力。

报告：守卫现状核对结论、你做的补强（若有）、以及确认 AC-10（core 无框架 import）与「apps/api 允许框架」两者不冲突。`,
  { label: 'sk-4-3:guard-align', phase: 'GuardAlign' }
)

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(
  `${CORE_RULES}

SK-4 三故事文件已创建：
- packages/core/src/ports/translation-port.ts（Locale 类型 + TranslationPort 接口）+ test
- apps/api/src/shared-kernel/*（SharedKernelModule + tokens + 占位适配器 + spec）
- scripts/check-core-imports.mjs 可能有补强

合并+验证：
1. 读 translation-port.ts 确认导出名（Locale、TranslationPort）。
2. 编辑 packages/core/src/index.ts，在现有导出后追加（不删改现有行，全用 export type + .js）：Locale、TranslationPort。现有 index.ts 末尾是 Redactor/RuntimeLog/LogEntry/LogLevel 的导出，在其后加。
3. 项目根跑 npm run test（tsc --build 会构建 core 与 apps/api 两个 project；import 守卫；vitest 会扫 core 与 apps/api 的测试）。
   - 若 apps/api 的 NestJS 测试因 vitest 配置/reflect-metadata/装饰器 metadata 失败，修 apps/api 侧配置（tsconfig experimentalDecorators+emitDecoratorMetadata、测试顶部 import reflect-metadata、必要时根 vitest 配置纳入 apps/api 测试）。不得违反核心包铁律，不得让守卫命中 packages/core。
   - 反复修到全绿。
4. 报告 npm run test 结果摘要（typecheck/守卫命中数/测试通过数/退出码）+ index.ts 追加行 + 为使 apps/api 测试通过所做的配置改动。`,
  { label: 'sk-4:merge+verify', phase: 'Merge+Verify' }
)

// ---- Review ----
phase('Review')
const review = await agent(
  `你是挑剔的对抗性代码评审者。评审 SK-4：TranslationPort 端口、SharedKernelModule DI 接线、import 守卫补强。项目根：${PROJECT_ROOT}

读：packages/core/src/ports/translation-port.ts(+test)、apps/api/src/shared-kernel/ 全部、scripts/check-core-imports.mjs、packages/core/src/index.ts。

权威契约：
- TranslationPort(§4.4): { translate(key:string, locale:Locale, params?:Readonly<Record<string,string|number>>):string; has(key:string, locale:Locale):boolean }；Locale=string 别名。缺失键返回 key 本身、不抛、不空串（AC-5）。
- SharedKernelModule(§5): 绑定并 exports 全部 7 个端口 token（ErrorClassifier/Platform/Redactor/TranslationPort/RuntimeLog/Clock/IdGenerator）。
- AC-10: packages/core 内零框架 import（@nestjs 等只能在 apps/api）。

重点查（每条判断真缺陷/可接受）：
1. TranslationPort 签名与 §4.4 逐字一致？translate 的 params 类型、has 签名、Locale 别名。
2. **AC-10 关键**：packages/core 下是否真的零 @nestjs import？@nestjs 是否只出现在 apps/api？守卫 scanRoot 是否只限 packages/core（不误扫 apps/api，否则 apps/api 的合法 @nestjs 会被拦）？
3. SharedKernelModule 是否绑定并 exports 全部 7 个 token？ErrorClassifier 是否真用了核心的 defaultErrorClassifier？占位适配器是否各自实现了对应端口接口（能被解析）？
4. 占位适配器里的 Date.now/randomUUID/process.* 是否只在 apps/api（适配器层允许），没漏进 packages/core？
5. TranslationPort 测试是否真验证 AC-5（缺失键返回键名不抛不空串）？还是空断言？
6. DI 测试是否真的装配 module 并解析出 7 个 token 的实例？
7. verbatimModuleSyntax：core 侧 import type+.js；index.ts 用 export type 导出 Locale/TranslationPort。

按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'sk-4:review', phase: 'Review' }
)

return { r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null, mergeReport, review }
