# 2026-08-01 · epic-c1-6 基础设施层接线（worktree 隔离开发纪实）

> 本目录沉淀「在 git worktree 中正式开工 epic-c1-6、把 C1 Conversation 从纯核心接上真 SQLite + NestJS DI + HTTP 入口、验证后合并回 master」这一轮完整过程、决策、踩坑与产出。
> 上一轮整夜执行见 `../2026-08-01-bmad-dev-auto-overnight-execution/`。

## 这一轮做了什么（一句话）

从「查当前 sprint 进度」这个问题起步，用户追问「C1 为啥 5/6 就跳去做 C2」「SQLite 装了没 / DI 是啥」「能不能开 worktree 正式做 c1-6」，最终在隔离 worktree 中做满 epic-c1-6 的 4 个故事（DB 连接层 + 两个 SQLite 仓储 + ConversationModule DI 接线 + 控制器 + bootstrap + 消费方契约），**562 测试全绿、curl 端到端打通**，提交 `eb0c729`，合并回 master（merge commit `062bbdd`），worktree 清理完毕。

## 交付快照（截至沉淀时刻）

- **HEAD**：master 停在 `220d711`（c2-5，期间由并行流程推进）；本轮产出为 `eb0c729`（c1-6）+ `062bbdd`（合并）。
- **epic-c1-6 全 4 故事 done**：C1 从 5/6 → **6/6 完整收官**。
- **562 测试全绿**（c1-6 新增 5 个 DI spec；合并 c2-4/c2-5 后总数增长），typecheck 0 错，import 守卫扫 85 文件 0 命中，核心包零框架。
- **首次端到端可跑**：真 SQLite + NestJS HTTP，curl 打通 create→append→history→list→delete（级联删除生效）。
- **sprint 进度**：Phase 4 从 12/18 推进到 **16/18 epic**（含期间并入的 c2-4、c2-5）。剩 c2-6 / c2-7 / EPIC-ACCEPT。

## 文件索引

- `01-任务缘起与进度问答.md` —— 从「看 sprint 进度」到「开 worktree 做 c1-6」的完整对话脉络；C1 为何 5/6 就做 C2 的分层解释；SQLite/DI 概念澄清。
- `02-worktree-隔离开发流程.md` —— 为何用 worktree、如何建、node_modules 不随 worktree 复制的坑、EnterWorktree/ExitWorktree、最终强删清理。
- `03-c1-6-实现与三个决策.md` —— 4 个故事逐个产出；三个拍板决策（TitleGenerator 占位 stub / 全 4 故事含控制器 / 只建 C1 本体列）；关键领域字段与 DI 接线范式。
- `04-踩坑与根治.md` —— 五个真实踩坑：worktree 缺 devDependencies、core exports 指向源码、缺 platform-express、DB 文件被占、master 分叉合并。
- `05-合并与验证.md` —— merge（非 ff）、sprint-status.yaml 自动合并、主仓库补装依赖、合并后全量验证。
- `06-安全与注入观察.md` —— 全程出现的 prompt 注入（伪 Claude Code 身份 + billing header）与处置；无鉴权 HTTP 端点的安全标注；密钥文件不入库纪律。
- `07-下一步与接续提示语.md` —— 剩余工作、推荐落点（c2-6-1 Claude SDK 适配器）、给下一个会话的接续指令。

## 关键提醒（给接续者）

1. **worktree 里必须跑完整 `npm install`**：git worktree 不复制 node_modules，只装单个包（如 `npm i better-sqlite3`）不会补齐根 devDependencies（tsc/vitest），会导致 `tsc/vitest not found`。
2. **`packages/core` 的 exports 已修为指向 dist**（原指向 `./src/index.ts`，`node dist` 起服务会 ERR_MODULE_NOT_FOUND）。跑 apps/api 前必须先 `tsc --build` 产出 core 的 dist。
3. **StubTitleGenerator 待替换**：c1-6 里 TitleGeneratorPort 暂绑抛错的 stub（触发降级），C2 的 GenerateTitleService（c2-7-1）落地后替换为真实现。
4. **HTTP 端点无鉴权**：仅监听 127.0.0.1，定位本机单机应用，勿暴露公网。
5. **git 环境坑照旧**：Git-Bash 下裸 `git` 输出不可信，一律 `/mingw64/bin/git` 全路径。
