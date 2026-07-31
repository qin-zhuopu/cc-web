# 02 · 执行链路演进：从 quick-dev 到 workflow

本轮最有价值的经验是**执行模式的三次演进**。记录每种模式的做法、成败、原因。

## 模式一：bmad-quick-dev（手动五步，用于首个故事）

用 `bmad-quick-dev` 技能跑通 S1 地基 + sk-1-1，走完整五步：
`clarify-and-route → plan → implement → review → present`

- **step-01 路由**：识别 sk-1-1 为 epic story，编译 epic context 缓存。
- **step-02 规划**：起草 spec（`spec-sk-1-1-*.md`），CHECKPOINT-1 halt 等用户批准。用户答「批准」。
- **step-03 实现**：设 baseline_commit、状态推进 in-progress、同步 sprint-status，派子代理实现（spec 为唯一真相源）。
- **step-04 评审**：构造 diff，并行三路对抗评审（Blind Hunter / Edge Case Hunter / Verification Gap），triage 分类（intent_gap/bad_spec/patch/defer/reject），patch 回修。
- **step-05 呈现**：追加 Suggested Review Order、标记 done、提交。

**结论**：五步链路本身走得通，但**每个故事都要人工 checkpoint 批准**，不适合无人值守批量跑。适合首个故事建立范式。

## 模式二：run-dev-auto.sh（CLI 外层编排，失败）

`_bmad-output/implementation-artifacts/run-dev-auto.sh` 是外层脚本，按 stories.yaml 顺序用 `claude -p`（headless）逐个分派 dev-auto。

**我给它加了 3 处中断保护**（都验证有效）：
1. Python 解释器探测（本机无 `python3`，退回 `python`/`py`）。
2. Git-Bash 下用 `/mingw64/bin/git` 全路径规避裸 git 输出异常。
3. **每故事 done 后自动 git 提交断点 + dispatch 前工作区脏检查** —— 让「任意位置中断 → --from 续跑」有干净的故事边界。

**为什么失败**：`claude -p` 子进程继承环境变量 `ANTHROPIC_MODEL=kr/claude-opus-4.8`，而该模型**已于 2026-06-15 退休**。子进程起来就撞退休错误、空转、反复重启却产不出任何东西。这是**环境/账号配置问题，不是脚本逻辑问题**（脚本骨架、保护、python 探测都验证过对）。

**副产品收获**：脏检查保护第一次跑时立刻拦住了「工作区不干净」——但那次脏是 CRLF 误报（见 04），倒逼我根治了 `.gitattributes`，否则整条链路根本起不来。

## 模式三：Workflow（JS 编排，成功，最终选定）

用 `Workflow` 工具写 `wf-<epic>.mjs` 脚本编排子代理。

**为什么 workflow 绕开了退休模型问题**：workflow 的 `agent()` 子代理**继承当前会话的模型**，根本不碰 `claude -p` CLI 子进程，不受环境 `ANTHROPIC_MODEL` 影响。这是选定 workflow 的决定性原因。

**workflow 脚本范式**（每个 epic 一个 `wf-*.mjs`）：
- `phase()` 分阶段；`parallel([...])` 并行无依赖的故事；串行 `await agent()` 处理有依赖链的故事。
- 典型结构：**波次1 并行建独立类型/值对象 → 波次2 并行建依赖前者的判定/实体 → 波次3 端口+守卫 → Merge+Verify（合并桶文件 index.ts + 跑 npm run test，失败自修到绿）→ Review（对抗评审）**。
- 关键约束写进每个 agent 的 prompt（子代理是全新上下文）：核心包铁律、verbatimModuleSyntax（import type + .js）、术语纪律、「不要改 index.ts（合并阶段统一处理，避免并行写冲突）」、「不要跑 npm run test（合并阶段统一跑）」。

**每个 epic 完成后我在会话里做**（不放进 workflow，保持控制）：
1. **独立复跑 `npm run test`** 验证（不轻信 workflow 汇报）。
2. 审读对抗评审结论，裁决 patch/defer/reject，**亲自修真缺陷**。
3. 更新 `sprint-status.yaml` 对应 epic 与故事为 done。
4. **git 提交断点**（一个 epic 一个 commit）。

## 拆 stories：子代理

每个 epic 实现前，先派一个 `general-purpose` 子代理拆 stories —— 读权威源（architecture/prd/epics-stories）+ 参照已完成 epic 的范式，产出 `epic-<x>/SPEC.md` + `stories.yaml`，遵守 `stories-schema.md`。拆完我验证合规再写 workflow。

## 三种模式对比结论

| 模式 | 无人值守 | 绕开退休模型 | 速度 | 结论 |
|---|---|---|---|---|
| quick-dev 五步 | ✗（每步 checkpoint） | 继承会话模型 ✓ | 慢 | 建范式用 |
| run-dev-auto.sh | ✓ | ✗（撞退休模型空转） | — | 环境问题失败 |
| **Workflow** | ✓ | ✓（继承会话模型） | 快（并行波次） | **最终选定** |
