export const meta = {
  name: 'sk-2-deterministic-ports',
  description: '并行实现 SK-2 三个确定性基础端口（Clock/IdGenerator/Platform），合并桶文件跑门禁，再对抗评审端口契约',
  phases: [
    { title: 'Implement', detail: '三端口并行：各建 ports/*.ts + 测试，禁碰 index.ts' },
    { title: 'Merge+Verify', detail: '统一加桶文件导出并跑 npm run test' },
    { title: 'Review', detail: '对抗评审端口契约与语义' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

// 三端口共享的核心包铁律与约定，注入每个实现 agent（它们是全新上下文）。
const COMMON = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core（核心包 @codepilot/core，零框架依赖）里工作。

核心包铁律（违反会导致 import 静态守卫 scripts/check-core-imports.mjs 命中而门禁失败）：
- 禁止 import @nestjs/*、better-sqlite3、@anthropic-ai/*、uuid。
- 禁止在核心内直调 Date.now() / new Date() / randomUUID。
- 本故事只定义「端口接口签名 + 语义契约」，不含任何适配器实现（SystemClock/UuidGenerator/NodePlatform 属 apps/api 适配器层，本轮不做）。

TypeScript 约定（tsconfig.base.json 启用 verbatimModuleSyntax）：
- 类型-only import 必须用 import type，且模块说明符带 .js 扩展名（NodeNext 解析），否则 tsc --build 报错。
- 目标 ES2022、strict。

术语纪律：禁止用「上下文」指代 bounded context；指代模块用全称（Shared Kernel / Conversation / AgentRuntime）或「领域边界」。注释用中文。

重要边界（并行安全）：绝对不要修改 packages/core/src/index.ts（桶文件）——它由后续合并阶段统一处理，你改了会与其他并行 agent 冲突。只创建你负责的端口文件与其同目录测试文件。

测试用 vitest（import { describe, it, expect } from 'vitest'）。测试文件放在被测端口同目录，命名 *.test.ts。
不要运行 npm run test（合并阶段统一跑）。完成后报告你创建的文件路径。
`

const PORTS = [
  {
    key: 'clock',
    label: 'sk-2-1:clock',
    prompt: `${COMMON}

任务 sk-2-1：定义 Clock 端口。

创建 packages/core/src/ports/clock.ts，严格对齐 architecture.md §4.6：
\`\`\`ts
export interface Clock {
  /** 当前时刻，epoch 毫秒。 */
  now(): number;
}
\`\`\`
- 只定义接口 Clock，方法 now(): number 返回 epoch 毫秒。
- 用 JSDoc 中文注释说明：生产适配器 SystemClock 返回系统真实时间（Date.now），测试替身 FrozenClock/MutableClock 可注入冻结/可推进时间；上层禁止直接 Date.now()，一律经 Clock（FR-6.3）。注意注释里若出现 Date.now 字样，写成「Date. now」或用中文描述避免触发守卫的字面量扫描——更稳妥：注释里不要出现连写的 Date.now( 字样，改用「系统时钟」等中文描述。
- 零框架 import。

创建同目录测试 clock.test.ts：
- 因为端口只是接口无实现，测试用一个内联的测试替身来验证「端口语义契约」：定义一个 FrozenClock 实现 Clock（now() 恒返回注入的固定值），断言两次 now() 返回相同值（对应 AC-8：冻结时钟两次取值相同）。
- 再定义一个 MutableClock 演示可推进语义（可选）。
- 该测试替身仅存在于测试文件内，不进 src 生产代码。`,
  },
  {
    key: 'id-generator',
    label: 'sk-2-2:id-generator',
    prompt: `${COMMON}

任务 sk-2-2：定义 IdGenerator 端口。

创建 packages/core/src/ports/id-generator.ts，严格对齐 architecture.md §4.7：
\`\`\`ts
export interface IdGenerator {
  /** 生成全局唯一 ID。 */
  next(): string;
}
\`\`\`
- 只定义接口 IdGenerator，方法 next(): string。
- JSDoc 中文注释：生产适配器 UuidGenerator 返回真实唯一 ID，测试替身 SequentialIdGenerator 返回确定性序列；上层禁止直接调用 uuid/随机库，一律经 IdGenerator（FR-7.3）。
- 零框架 import。

创建同目录测试 id-generator.test.ts：
- 用内联测试替身验证端口语义契约：定义 SequentialIdGenerator 实现 IdGenerator（next() 依次返回 'id-1','id-2',...），断言连续 next() 与预期序列一致（对应 AC-9：注入确定性序列后生成结果与预期一致）。
- 测试替身仅存在于测试文件内。`,
  },
  {
    key: 'platform',
    label: 'sk-2-3:platform',
    prompt: `${COMMON}

任务 sk-2-3：定义 Platform 端口。

创建 packages/core/src/ports/platform.ts，严格对齐 architecture.md §4.2：
\`\`\`ts
export type OsType = 'darwin' | 'win32' | 'linux' | 'unknown';
export type ArchType = 'x64' | 'arm64' | 'unknown';

export interface PlatformInfo {
  readonly os: OsType;
  readonly arch: ArchType;
  readonly runtime: 'node';
}

export interface Platform {
  /** 返回只读平台信息，进程内稳定。 */
  info(): PlatformInfo;
}
\`\`\`
- 定义 OsType / ArchType 类型别名、PlatformInfo（全字段 readonly）、Platform 接口。
- JSDoc 中文注释：生产适配器 NodePlatform 读 process.platform/arch（在适配器层）；Platform 只读不可变，上层不得通过它修改环境状态（FR-2.2）；进程内稳定（FR-2.3）。
- 零框架 import。

创建同目录测试 platform.test.ts：
- 用内联测试替身验证契约：定义一个 fakePlatform 实现 Platform（info() 返回固定 PlatformInfo），断言 os/arch/runtime 字段存在且 runtime==='node'；断言 PlatformInfo 字段为只读（可用类型层面的 @ts-expect-error 尝试赋值，或断言返回对象结构）。对应 AC-11：返回值与运行环境一致且只读、进程内稳定。
- 测试替身仅存在于测试文件内。`,
  },
]

// ---- Implement：三端口并行 ----
phase('Implement')
const implResults = await parallel(
  PORTS.map((p) => () =>
    agent(p.prompt, { label: p.label, phase: 'Implement' })
  )
)

// ---- Merge+Verify：串行合并桶文件并跑门禁 ----
phase('Merge+Verify')
const mergeReport = await agent(
  `${COMMON}

现在三个端口文件已由并行 agent 创建完毕：
- packages/core/src/ports/clock.ts（导出 interface Clock）
- packages/core/src/ports/id-generator.ts（导出 interface IdGenerator）
- packages/core/src/ports/platform.ts（导出 type OsType, ArchType; interface PlatformInfo, Platform）

你的任务（合并 + 验证）：
1. 先读这三个端口文件确认它们的实际导出名（以文件为准，不要假设）。
2. 编辑 packages/core/src/index.ts（桶文件），在现有导出后追加这三个端口的导出。注意 verbatimModuleSyntax：接口/类型别名用 \`export type { ... } from './ports/xxx.js'\`，若有值导出才用 \`export { ... }\`。Clock/IdGenerator/Platform/PlatformInfo/OsType/ArchType 全是类型，用 export type。模块说明符带 .js。
   现有 index.ts 内容（在其后追加，不要删改现有行）：
\`\`\`ts
// packages/core 桶文件：导出领域类型与端口契约。
export { ErrorCode } from './domain/error/error-code.js';
export { SK_MESSAGE_KEYS } from './domain/error/message-keys.js';
export type { ClassifiedError } from './domain/error/classified-error.js';
export type { ErrorClassifier } from './ports/error-classifier.js';
export { defaultErrorClassifier } from './ports/error-classifier.js';
\`\`\`
3. 在项目根运行 \`npm run test\`（该命令串联 tsc --build → import 守卫 → vitest）。
   - 若失败，读错误、修复（可能是 verbatimModuleSyntax 的 import type 问题、守卫命中 Date.now 字面量、或测试断言问题），重跑直到全绿。
   - 修复端口文件或测试文件均可，但不得违反核心包铁律，不得改动 error 领域已有文件。
4. 报告：最终 npm run test 的结果摘要（typecheck / 守卫命中数 / 测试通过数 / 退出码），以及你对 index.ts 做的具体追加行。`,
  { label: 'merge+verify', phase: 'Merge+Verify' }
)

// ---- Review：对抗评审端口契约 ----
phase('Review')
const review = await agent(
  `你是挑剔的对抗性代码评审者。评审目标：SK-2 三个确定性基础端口（Clock/IdGenerator/Platform）的接口定义与其语义测试。项目根：${PROJECT_ROOT}

请读这些文件：
- packages/core/src/ports/clock.ts 与 clock.test.ts
- packages/core/src/ports/id-generator.ts 与 id-generator.test.ts
- packages/core/src/ports/platform.ts 与 platform.test.ts
- packages/core/src/index.ts（确认三端口已正确导出）

权威契约（architecture.md §4.2/§4.6/§4.7）：
- Clock: interface { now(): number }（epoch 毫秒）
- IdGenerator: interface { next(): string }
- Platform: interface { info(): PlatformInfo }；PlatformInfo { readonly os: OsType; readonly arch: ArchType; readonly runtime: 'node' }；OsType='darwin'|'win32'|'linux'|'unknown'；ArchType='x64'|'arm64'|'unknown'

核心包铁律：零框架 import；禁直调 Date.now/new Date/randomUUID；只定义端口契约不含适配器实现；类型-only import 用 import type + .js。

重点查（每条判断是真缺陷还是可接受）：
1. 三个接口签名是否与 §4.2/§4.6/§4.7 逐字一致（方法名、返回类型、字段名、字面量联合类型的成员是否有增删改）。
2. PlatformInfo 字段是否全部 readonly；OsType/ArchType 联合成员是否完整（含 'unknown'）。
3. 是否混入了适配器实现（如端口文件里真的调了 process.platform / Date.now / uuid）——端口文件应零实现。
4. 测试是否真的验证了语义契约（AC-8 冻结时钟两次相同 / AC-9 确定性序列 / AC-11 只读且稳定），还是只是空断言。
5. 是否有核心包铁律违规、verbatimModuleSyntax 违规（缺 import type 或缺 .js）。
6. index.ts 是否正确用 export type 导出了纯类型（Clock/IdGenerator/Platform/PlatformInfo/OsType/ArchType）。

按严重度排序，简洁输出。若无实质问题，明确说「无阻断性缺陷」并列出任何 nitpick。`,
  { label: 'review:port-contracts', phase: 'Review' }
)

return {
  implemented: implResults.map((r, i) => ({ port: PORTS[i].key, ok: r != null })),
  mergeReport,
  review,
}
