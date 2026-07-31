export const meta = {
  name: 'c1-2-message-content',
  description: 'C1-E2 MessageContent 编解码：串行 类型联合→往返→脏输入降级→工具块保真→纯文本，合并门禁再对抗评审',
  phases: [
    { title: 'Types', detail: 'c1-2-1 ContentBlock 5 类联合' },
    { title: 'Roundtrip', detail: 'c1-2-2 encode/decode 往返 + MessageContent 富类型' },
    { title: 'Degrade', detail: 'c1-2-3 decode 脏输入降级为单 text 块' },
    { title: 'ToolFidelity', detail: 'c1-2-4 tool_use/tool_result 保真' },
    { title: 'PlainText', detail: 'c1-2-5 toPlainText 转纯文本' },
    { title: 'Merge+Verify', detail: '桶文件导出+跑 npm run test' },
    { title: 'Review', detail: '对抗评审编解码往返/降级/保真' },
  ],
}

const PROJECT_ROOT = 'C:/home/14409.JEREH/repo/github.com/op7418/codepilot-web'

const RULES = `
项目：CodePilot Web 后端，六边形架构。项目根：${PROJECT_ROOT}
你在 packages/core/src/conversation/domain/message/ 下落地 C1 的 MessageContent（编解码）。C1 核心零框架依赖、纯函数无 I/O。
现状：C1-E1 已完成，message-content.ts 是占位（export type MessageContent = unknown），本 epic 把它落成 5 类内容块联合 + encode/decode/textContent/toPlainText。Message 实体已引用 MessageContent，不改 Message 其它字段。
5 类内容块（architecture §3.4 逐字）：
  text{type:'text';text:string} / thinking{type:'thinking';thinking:string} /
  tool_use{type:'tool_use';id:string;name:string;input:unknown} /
  tool_result{type:'tool_result';toolUseId:string;content:string;isError?:boolean;media?:ReadonlyArray<MediaRef>;sources?:ReadonlyArray<ExternalSourceRef>} /
  code{type:'code';language:string;code:string}
核心包铁律：禁 import @nestjs/*/better-sqlite3/@anthropic-ai/*/uuid；禁直调 Date.now()/randomUUID（注释也别连写 "Date.now("）。禁 phase（无 StreamSession/.phase/active/settling/terminal）。
TypeScript（verbatimModuleSyntax）：类型-only import 用 import type + .js 扩展名。字段全 readonly。strict/ES2022/NodeNext。
术语中文。测试用 vitest，*.test.ts 同目录。不要跑 npm run test（合并阶段统一跑）。不要改 packages/core/src/index.ts（合并阶段处理）。
完成后报告改/建的文件。
`

// 串行 5 故事——都改同一批 content 文件，必须顺序执行避免冲突
phase('Types')
const r1 = await agent(`${RULES}

任务 c1-2-1：定义 ContentBlock 5 类判别联合 + MediaRef/ExternalSourceRef 辅助类型。对齐 architecture §3.4（先读文档第 148-154 行确认字段）。
创建 packages/core/src/conversation/domain/message/content-block.ts：
- 5 类内容块 interface，各以 type 作判别标签，字段逐字如上，全 readonly。
- MediaRef / ExternalSourceRef：以够 tool_result 往返保真的最小形状定义（读 §3.4；若文档未逐字给出，用最小合理形状 + 注释来源，不臆造多余字段）。
- export type ContentBlock = 上述 5 类的联合。
- 本故事只定义类型联合，不含 encode/decode/toPlainText 实现。零框架、无 I/O。
创建 content-block.test.ts：类型层断言——5 类块各构造合法字面量、type 判别可收窄、tool_use.input 接受任意 JSON、tool_result 可选字段可省略。`,
  { label: 'c1-2-1:types', phase: 'Types' })

phase('Roundtrip')
const r2 = await agent(`${RULES}

任务 c1-2-2：把占位 MessageContent 落成富类型 + 实现 encode/decode/textContent 往返（合法路径）。对齐 architecture §3.4 第 156-166 行。
c1-2-1 已建 content-block.ts（导出 ContentBlock 及 5 类块、MediaRef、ExternalSourceRef）。
编辑 packages/core/src/conversation/domain/message/message-content.ts：
- 把 export type MessageContent = unknown 替换为富类型 interface MessageContent { readonly blocks: ReadonlyArray<ContentBlock>; toPlainText(): string }。
  （toPlainText 的完整拼接规则属 c1-2-5，本故事可先给一个最小可用实现或占位，c1-2-5 再补全；但类型签名要先到位。）
- 实现 encodeContent(content: MessageContent): string —— 序列化 blocks 为 JSON string（落库用）。
- 实现 decodeContent(raw: string): MessageContent —— 合法路径：JSON.parse → 数组逐块归一化为 ContentBlock → 包成 MessageContent。（脏输入降级属 c1-2-3，本故事先给合法路径，但 decode 签名与基本结构要到位。）
- 实现 textContent(text: string): MessageContent —— 便捷构造单 text 块。
- import type { ContentBlock } from './content-block.js'。
创建 message-content.test.ts：表驱动覆盖全 5 类块 encode∘decode 往返不丢字段、幂等（decode(encode(x)) 深等 x 的 blocks，二次 encode 结果稳定）。`,
  { label: 'c1-2-2:roundtrip', phase: 'Roundtrip' })

phase('Degrade')
const r3 = await agent(`${RULES}

任务 c1-2-3：decodeContent 脏输入永不抛、降级为单 text 块。对齐 architecture §3.4 第 169 行语义。
编辑 message-content.ts 的 decodeContent：
- 尝试 JSON.parse；若结果为数组 → 逐块归一化（数组中未知 type 的块的处理规则：请在实现中固定为「降级为 {type:'text', text: 该块的字符串化}」或「丢弃」二选一，注释写明选择，并单测该规则，不留待决）。
- 任何异常（JSON.parse 抛）/ 非数组结果（对象/标量/null）→ 降级为 { blocks: [{type:'text', text: raw}] }（原始串作为 text）。
- 绝不抛、绝不静默吞（降级是显式行为）。
在 message-content.test.ts 补：喂非 JSON 字符串（如 'not json {'）断言不抛、结果单 text 块且 text===raw；喂 JSON 对象（非数组）断言降级；喂含未知块类型的数组断言按固定规则处理。反假数据：降级非静默丢弃。`,
  { label: 'c1-2-3:degrade', phase: 'Degrade' })

phase('ToolFidelity')
const r4 = await agent(`${RULES}

任务 c1-2-4：tool_use / tool_result 输入保真。在 c1-2-2 往返基础上补齐工具块可选字段/任意 input 的保真断言。对齐 §3.4、AC-6。
- 确认 encode/decode 对 tool_use.input（任意 JSON：对象/数组/标量/深层嵌套）原样保留。
- 确认 tool_result 的 isError:boolean、media:ReadonlyArray<MediaRef>、sources:ReadonlyArray<ExternalSourceRef> 可选字段往返一致；省略时 decode 后仍为 undefined（不落假值）。
- 若发现 c1-2-2 的 encode/decode 实现会丢工具块字段，修正 decodeContent 的归一化逻辑使其保真。
在 message-content.test.ts 补表驱动：带全部可选字段的 tool_result 往返不丢；带嵌套对象/数组 input 的 tool_use 往返 input 深等；省略可选字段的 tool_result 往返后可选字段为 undefined。不新增块类型。`,
  { label: 'c1-2-4:tool-fidelity', phase: 'ToolFidelity' })

phase('PlainText')
const r5 = await agent(`${RULES}

任务 c1-2-5：实现 MessageContent.toPlainText() 转稳定纯文本。对齐 §3.4 第 159 行注释。
编辑 message-content.ts：完善 toPlainText()（若 c1-2-2 给的是占位）——
- 拼接 text 块的 text 与 code 块的 code（对齐 §3.4 注释「拼 text/code 块」）；非文本块（thinking/tool_use/tool_result）的处理规则在实现中固定并注释（如跳过，或 code 块带 language 标注）。
- 拼接顺序=blocks 顺序；块间分隔符固定（如 '\\n'），注释写明。
- 产出稳定可断言（同输入同输出，纯函数）。供列表预览与喂 C2.TitleGenerator 的 recentMessages 纯文本投影。
在 message-content.test.ts 补：混合块（text+thinking+tool_use+code）输入 → toPlainText 产出稳定纯文本，断言只含 text/code 内容、非文本块按规则处理、顺序与分隔正确。本故事不碰会话/消息用例。`,
  { label: 'c1-2-5:plaintext', phase: 'PlainText' })

phase('Merge+Verify')
const mergeReport = await agent(`${RULES}

C1-E2 文件已落地：content-block.ts（ContentBlock 5 类 + MediaRef/ExternalSourceRef）、message-content.ts（MessageContent 富类型 + encode/decode/textContent/toPlainText）+ 测试。
合并+验证：
1. 读 content-block.ts、message-content.ts 确认实际导出名。
2. 编辑 packages/core/src/index.ts：C1 段里 message-content 之前导出的占位 MessageContent 现在是富类型——确认导出正确。追加导出 ContentBlock（及 5 类块类型、MediaRef、ExternalSourceRef 若需对外）用 export type；encodeContent/decodeContent/textContent 是函数值用 export。不删改无关行。注意现有 index.ts 已有一行 export type 从 conversation/domain/message/message-content.js 导出 MessageContent，若 message-content 现导出了函数值需相应补 export（非 export type）行。
3. 项目根跑 npm run test。失败就修（verbatimModuleSyntax、往返/降级断言、导出）。反复到全绿。守卫需保持 0 命中、不误伤。
4. 报告 npm run test 摘要 + index.ts 对 C1-E2 的导出调整。`,
  { label: 'c1-2:merge+verify', phase: 'Merge+Verify' })

phase('Review')
const review = await agent(`你是挑剔的对抗性代码评审者。评审 C1-E2 MessageContent 编解码。项目根：${PROJECT_ROOT}
读 packages/core/src/conversation/domain/message/content-block.ts(+test)、message-content.ts(+test)、index.ts 的相关导出。权威源 docs/contexts/c1-conversation/architecture.md §3.4。

重点查（每条判断真缺陷/可接受）：
1. ContentBlock 5 类字段是否与 §3.4 逐字一致（type 判别标签、tool_use.input:unknown、tool_result 可选字段 isError/media/sources、code 的 language/code）？MediaRef/ExternalSourceRef 是否臆造了多余字段？
2. 【往返保真】encode∘decode 是否对 5 类块都不丢字段、幂等？测试是否表驱动真覆盖全 5 类，还是只测了 text？
3. 【脏输入降级】decodeContent 是否真的永不抛？非 JSON/非数组/解析异常是否都降级为单 text 块且 text===raw？未知块类型规则是否固定并测了（而非留待决）？是否静默吞异常？
4. 【工具块保真】tool_use.input 任意 JSON（嵌套对象/数组/标量）是否原样保留？tool_result 可选字段省略时往返后是否 undefined 而非假值？
5. 【toPlainText】拼接规则是否固定、稳定、纯函数？非文本块处理是否明确？
6. 核心零框架/无 I/O、禁 phase、readonly、import type+.js。
按严重度排序，简洁输出。无实质问题则明说「无阻断性缺陷」并列 nitpick。`,
  { label: 'c1-2:review', phase: 'Review' })

return { r1ok: r1 != null, r2ok: r2 != null, r3ok: r3 != null, r4ok: r4 != null, r5ok: r5 != null, mergeReport, review }
