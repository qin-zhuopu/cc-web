export const meta = {
  name: 'sk-3-redaction-runtime-log',
  description: 'SK-3 脱敏与运行时日志：串行实现 Redactor→RuntimeLog端口+LogEntry→写入自动脱敏契约，跑门禁再对抗评审',
  phases: [
    { title: 'Redactor', detail: 'sk-3-1 定义 Redactor 端口+语义契约' },
    { title: 'RuntimeLog', detail: 'sk-3-2 RuntimeLog 端口+LogEntry 值对象' },
    { title: 'AutoRedact', detail: 'sk-3-3 收敛写入自动脱敏契约' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审端口契约与脱敏语义' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const COMMON = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core（核心包 @codepilot/core，零框架依赖）工作。

核心包铁律（违反会导致 import 守卫 scripts/check-core-imports.mjs 命中而门禁失败）：
- 禁止 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid。
- 禁止在核心内直调 Date.now() / new Date() / randomUUID（注释里也不要出现连写的 "Date.now(" 字样，用中文「系统时钟」描述规避守卫字面量扫描）。
- 本 epic 只定义「端口接口 + 值对象 + 语义契约」，不含适配器实现（RegexRedactor/RingBufferRuntimeLog 属 apps/api 适配器层，本轮不做）。
  例外：architecture.md §4.3 允许 Redactor 随核心包提供纯函数默认实现——但 sk-3-1 本轮仅定义端口契约，默认实现留给适配器层，不要在本轮写正则实现。

TypeScript 约定（verbatimModuleSyntax 已启用）：类型-only import 必须 import type + 模块说明符带 .js 扩展名，否则 tsc --build 报错。strict、ES2022。

术语纪律：禁止用「上下文」指代 bounded context；用全称或「领域边界」。注释中文。
测试用 vitest。测试文件与被测文件同目录，命名 *.test.ts。不要运行 npm run test（合并阶段统一跑）。不要修改 packages/core/src/index.ts（并行安全，桶文件由合并阶段统一处理）。
已存在可复用：packages/core/src/ports/clock.ts 导出 interface Clock { now(): number }。
完成后报告你创建/修改的文件路径。
`

// ---- sk-3-1 Redactor ----
phase('Redactor')
const r1 = await agent(
  `${COMMON}

任务 sk-3-1：定义 Redactor 端口与语义契约。对齐 architecture.md §4.3、prd.md FR-3、AC-3/AC-4。

创建 packages/core/src/ports/redactor.ts：
\`\`\`ts
export interface Redactor {
  /** 对字符串脱敏，返回脱敏后新串。 */
  redactString(input: string): string;
  /** 对结构化对象深度脱敏，返回脱敏后新副本，不修改原对象。 */
  redact<T>(input: T): T;
}
\`\`\`
- 只定义接口 Redactor。JSDoc 中文注释说明：内建规则集须覆盖 API Key / Bearer token / 绝对路径中的用户名段 / 邮箱 / 常见密钥前缀（FR-3.2）；脱敏用占位符 ***REDACTED*** 替换、保留可读结构（FR-3.3）；返回新副本、原对象不变（AC-4/FR-3.1）；纯函数无副作用。具体正则规则集与纯函数默认实现属适配器层，本文件不含实现。
- 零框架 import。

创建 redactor.test.ts：用内联测试替身（一个最小 fakeRedactor 实现 Redactor，把匹配 /sk-[A-Za-z0-9_-]+/ 之类的敏感样式替换为 ***REDACTED***）验证端口语义契约：
- AC-3：对含 API Key（如 'sk-xxxx'）/ Bearer token / 邮箱的输入，redactString 后原始敏感值不出现在输出。
- AC-4：redact 一个对象后，返回新副本，原对象未被修改（断言原对象字段不变、返回对象为不同引用）。
- 占位符 ***REDACTED*** 出现在脱敏输出中。
测试替身仅存在于测试文件内，不进 src 生产代码。`,
  { label: 'sk-3-1:redactor', phase: 'Redactor' }
)

// ---- sk-3-2 RuntimeLog + LogEntry ----
phase('RuntimeLog')
const r2 = await agent(
  `${COMMON}

任务 sk-3-2：定义 RuntimeLog 端口 + LogEntry/LogLevel 值对象。对齐 architecture.md §4.5/§3.4、prd.md FR-5、AC-6、NFR-6。
依赖：sk-3-1 的 Redactor（已创建 ports/redactor.ts）与 SK-2.1 的 Clock（ports/clock.ts 已存在）。

创建 packages/core/src/domain/log/log-entry.ts：
\`\`\`ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly timestamp: number;   // 来自 Clock.now()
  readonly level: LogLevel;
  readonly source: string;      // 来源标识，如 'c2.stream' / 'c7.doctor'
  readonly message: string;     // 已脱敏
  readonly meta?: Readonly<Record<string, unknown>>; // 已脱敏
}
\`\`\`

创建 packages/core/src/ports/runtime-log.ts：
\`\`\`ts
import type { LogEntry } from '../domain/log/log-entry.js';
export interface RuntimeLog {
  /** 追加一条日志；message/meta 写入前自动经 Redactor 脱敏。 */
  append(entry: Omit<LogEntry, 'timestamp'>): void;
  /** 导出当前环形缓冲快照（已脱敏、时间升序）。 */
  snapshot(): ReadonlyArray<LogEntry>;
  /** 清空缓冲。 */
  clear(): void;
  /** 当前容量上限。 */
  readonly capacity: number;
}
\`\`\`
- LogEntry 全字段 readonly；timestamp 语义来自 Clock.now()（注释说明，不在核心直调系统时钟）。
- JSDoc 中文注释说明语义契约：有界环形缓冲，写 N+K 条仅保留最新 N 条 FIFO 覆盖（AC-6/FR-5.1）；写入 O(1)（NFR-6）；snapshot 时间升序、内容已脱敏；具体 RingBufferRuntimeLog(capacity, clock, redactor) 实现属适配器层，本轮不写。
- 零框架 import；类型 import 用 import type + .js。

创建 runtime-log.test.ts（端口契约测试，用内联测试替身）：
- 实现一个最小 InMemoryRingBuffer implements RuntimeLog（capacity 注入，用数组做 FIFO 覆盖，append 时用一个注入的假 clock 计数器产生递增 timestamp），验证 AC-6：capacity=N 时写 N+K 条，snapshot 只剩最新 N 条、且时间升序。
- 验证 append 接受 Omit<LogEntry,'timestamp'>、snapshot 返回带 timestamp 的完整 LogEntry。
- 测试替身仅在测试文件内。`,
  { label: 'sk-3-2:runtime-log', phase: 'RuntimeLog' }
)

// ---- sk-3-3 写入自动脱敏契约 ----
phase('AutoRedact')
const r3 = await agent(
  `${COMMON}

任务 sk-3-3：收敛 RuntimeLog 写入自动脱敏的语义契约。对齐 architecture.md §4.5、prd.md FR-5.3/NFR-4、AC-7。
依赖：sk-3-1（Redactor，ports/redactor.ts）+ sk-3-2（RuntimeLog 端口 + LogEntry，已创建）。

本故事不新增端口文件（RuntimeLog 端口已在 sk-3-2 定义），而是：
1. 检查 ports/runtime-log.ts 的 append 注释是否已明确「message/meta 写入前自动经 Redactor 脱敏、端口不暴露绕过 Redactor 的写入路径（NFR-4）」。若不够明确，补强 JSDoc 契约注释（只改注释/文档性内容，不改接口签名）。
2. 创建 packages/core/src/ports/runtime-log.auto-redact.test.ts —— 用内联测试替身验证 AC-7 反例断言：
   - 实现一个 RedactingRingBuffer implements RuntimeLog，内部持有注入的 Redactor（fakeRedactor 把 'sk-xxxx'/邮箱等替换为 ***REDACTED***）与假 clock；append 时对 entry.message 与 entry.meta 先经 Redactor 再存。
   - 断言：写入含敏感值（如 message 含 'sk-SECRET123'、meta 含 token）的日志后，snapshot() 中该敏感原值不出现、被 ***REDACTED*** 取代（AC-7）。
   - 断言：端口仅 append 一条写入路径，无绕过 Redactor 的旁路（通过「只要走 append 就一定脱敏」的断言体现）。
   - 测试替身仅在测试文件内。
类型 import 用 import type + .js。报告你补强的注释与新增测试文件。`,
  { label: 'sk-3-3:auto-redact', phase: 'AutoRedact' }
)

// ---- Merge+Verify ----
phase('Merge+Verify')
const mergeReport = await agent(
  `${COMMON}

三个故事文件已创建：
- ports/redactor.ts（interface Redactor）
- domain/log/log-entry.ts（type LogLevel; interface LogEntry）
- ports/runtime-log.ts（interface RuntimeLog）
- 及各自 *.test.ts

合并+验证任务：
1. 读上述端口/值对象文件确认实际导出名（以文件为准）。
2. 编辑 packages/core/src/index.ts，在现有导出后追加（不删改现有行）：Redactor、RuntimeLog、LogEntry、LogLevel。全是类型（interface/type），用 export type，模块说明符带 .js。现有 index.ts：
\`\`\`ts
// packages/core 桶文件：导出领域类型与端口契约。
export { ErrorCode } from './domain/error/error-code.js';
export { SK_MESSAGE_KEYS } from './domain/error/message-keys.js';
export type { ClassifiedError } from './domain/error/classified-error.js';
export type { ErrorClassifier } from './ports/error-classifier.js';
export { defaultErrorClassifier } from './ports/error-classifier.js';
export type { Clock } from './ports/clock.js';
export type { IdGenerator } from './ports/id-generator.js';
export type { OsType, ArchType, PlatformInfo, Platform } from './ports/platform.js';
\`\`\`
3. 项目根跑 npm run test（tsc --build → import 守卫 → vitest）。失败就读错误修复（verbatimModuleSyntax 的 import type/.js、守卫命中、断言问题），重跑到全绿。不得违反核心包铁律，不得改已有 error/ports 既有文件的行为。
4. 报告：npm run test 结果摘要（typecheck/守卫命中数/测试通过数/退出码）+ 你对 index.ts 追加的具体行。`,
  { label: 'sk-3:merge+verify', phase: 'Merge+Verify' }
)

// ---- Review ----
phase('Review')
const review = await agent(
  `你是挑剔的对抗性代码评审者。评审 SK-3 脱敏与运行时日志的端口/值对象定义与语义测试。项目根：${PROJECT_ROOT}

读：ports/redactor.ts(+test)、domain/log/log-entry.ts、ports/runtime-log.ts(+test)、ports/runtime-log.auto-redact.test.ts、packages/core/src/index.ts。

权威契约：
- Redactor(§4.3): { redactString(input:string):string; redact<T>(input:T):T }
- LogEntry(§3.4): { readonly timestamp:number; readonly level:LogLevel; readonly source:string; readonly message:string; readonly meta?:Readonly<Record<string,unknown>> }；LogLevel='debug'|'info'|'warn'|'error'
- RuntimeLog(§4.5): { append(entry:Omit<LogEntry,'timestamp'>):void; snapshot():ReadonlyArray<LogEntry>; clear():void; readonly capacity:number }

核心包铁律：零框架 import；禁直调 Date.now/new Date/randomUUID；只定义契约不含适配器实现；import type + .js。

重点查（每条判断真缺陷/可接受）：
1. 三处签名是否与 §4.3/§3.4/§4.5 逐字一致（方法名/返回类型/字段名/readonly/可选 meta/LogLevel 成员）。
2. 是否混入适配器实现（redactor.ts 里真写了正则规则？runtime-log.ts 里真实现了环形缓冲？端口文件应零实现）。
3. 测试是否真验证语义：AC-3(脱敏后敏感值不出现)、AC-4(返回新副本原对象不变)、AC-6(写N+K仅留最新N、时间升序)、AC-7(写入含敏感值 snapshot 已脱敏、无绕过路径)。是否空断言？
4. 核心包铁律违规、verbatimModuleSyntax 违规（缺 import type/.js）、注释里是否出现会触发守卫的 "Date.now(" 字面量。
5. index.ts 是否用 export type 正确导出 Redactor/RuntimeLog/LogEntry/LogLevel。

按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'sk-3:review', phase: 'Review' }
)

return { r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null, mergeReport, review }
