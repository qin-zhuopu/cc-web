# 2026-08-01 · BMad dev-auto 整夜无人值守执行纪实

> 本目录沉淀「验证 bmad-dev-auto 全自动开发链路」这一轮从 sk-1-1 起步到整夜批量推进 12 个 epic 的完整过程、决策、踩坑与产出。
> 上一轮规划见 `../2026-07-31-bmad-conversation-management-readiness/`。

## 这一轮做了什么（一句话）

从「用 bmad-quick-dev 跑通 S1 地基 + 第一个故事 sk-1-1」起步，验证 dev-auto 全自动链路能否走通；确认可行后切换到 **workflow 编排**模式，整夜无人值守批量推进，最终交付 **12 个 epic、499 个测试全绿**，稳定停在干净断点 `b4a8b3e`。

## 交付快照（截至沉淀时刻）

- **HEAD**：`b4a8b3e`（C2-E3），工作区干净、全部入库。
- **12/18 epic 完成**：SK 全 4（sk-1~4）+ C1 纯核心全 5（c1-1~5）+ C2 前 3（c2-1~3）。
- **499 测试全绿**，import 守卫扫 85 文件 0 命中，核心包零框架。
- **剩余**：C2-E4/E5（纯核心，可续）+ 基础设施层 C1-E6 / C2-E6-7 / EPIC-ACCEPT（需真 litellm 代理，须人在场验证）。

## 文件索引

- `01-任务缘起与范围.md` —— 用户初始诉求、本轮真实目的（验证 dev-auto 链路）、范围边界。
- `02-执行链路演进-从quickdev到workflow.md` —— 三种执行模式的尝试与切换：bmad-quick-dev（手动五步）→ run-dev-auto.sh（CLI 编排，失败）→ Workflow（成功）。
- `03-每个epic的交付与评审发现.md` —— 12 个 epic 逐个的产出、对抗评审抓到的真缺陷及修复。
- `04-踩坑与根治.md` —— CRLF 误报、退休模型、Git-Bash git 异常、network 抖动、输出退化等所有踩坑与处置。
- `05-架构与铁律沉淀.md` —— 六边形铁律、SK/C1/C2 关键设计决策、phase 不落库、反假数据等在实现中固化的约束。
- `06-工作流机制与哨兵.md` —— workflow 脚本模式、幂等自检、哨兵 cron、stop+resume 恢复。
- `07-下一步与接续提示语.md` —— 剩余工作、恢复方式、给下一个会话的精确接续指令。

## 关键提醒（给接续者）

1. **git 环境有坑**：Git-Bash 下裸 `git` 输出异常、`find` 不稳，一律用 `/mingw64/bin/git` 全路径或 Glob。项目是**独立 git 仓库**（`codepilot-web/` 自身即根），勿混入上层 dotfiles。
2. **模型配置**：`run-dev-auto.sh` 依赖的 `claude -p` 子进程继承环境 `ANTHROPIC_MODEL`，若该值是退休模型会空转。**workflow 子代理继承会话模型，绕开此问题**——这是最终选定 workflow 的关键原因。
3. **`_bmad-output/` 已入库**：进度（sprint-status.yaml）、spec、wf-*.mjs 全部版本化，中断后可完全恢复。
4. **每 epic 一个断点提交**，`git log` 一串 `feat` 即进度全貌。
