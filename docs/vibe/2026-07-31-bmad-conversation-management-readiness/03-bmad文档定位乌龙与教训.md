# 03 · BMad 文档定位乌龙与教训

这是本次会话最重要的一段插曲，务必如实记录，供今后避免同类错误。

## 用户的质疑

在我基于「BMad 产出为空」的初判往下走时，用户打断并质疑：

> 我看下这个项目的 bmad 目录，我记得之前做过一部分工作啊？为啥你好像啥也不知道？不是通过文档传递信息吗？之前的文档呢？

用户是对的——之前确实做过大量 BMad 工作。

## 我的连续误判过程

1. 一开始我用 `cd <项目> && find docs -type f` 这类命令查文档，**连续多次返回空**。
2. 据此我错误地下了结论：「44 份 BMad 文档从未 commit 进 git、工作区已清空、文档丢失了」，还煞有介事地给出了「证据链」（git 只有 1 个 commit、docs/contexts 在历史里 0 次出现、工作区 clean）。
3. 我甚至建议用户「用 CodePilot 里的会话沉淀文档作蓝本重建」。

**这个结论是完全错误的。**

## 真相

- 用户给了关键线索：`docs/vibe/session-2026-07-30-dev-tooling-and-hexagonal-bmad.md`（这份在 CodePilot 仓库里），并要我给绝对路径。
- 我用 Glob（专用工具）搜，命中了 `codepilot-web/docs/architecture/hexagonal-decomposition.md`，`ls -la` 显示它 **4248 字节、确实存在**。
- 换用可靠方式重查，发现 **44 份 BMad 文档一份不少**，全在 `codepilot-web/docs/` 下：
  - `docs/architecture/`：index.md、overview.md、hexagonal-decomposition.md、context-boundaries.md
  - `docs/bmad-progress/progress.md`（34KB）
  - `docs/contexts/<11 个上下文>/`：每个 product-brief + prd + architecture + epics-stories

## 根因

我一直用 `cd ... && find` 的写法，但这个 shell **每条命令执行后工作目录会重置**，导致 `find docs` 在错误的目录下执行，连续返回空。文档从头到尾都好好地在磁盘上。**是我的排查方法有问题，不是文档丢了，更不是用户记忆有误。**

## 教训（今后必守）

1. **shell cwd 重置陷阱**：本环境里 Bash 工具每条命令后 cwd 会重置回项目根。跨命令不能依赖 `cd` 的持久效果；要用绝对路径，或在同一条命令里 `cd A && cmd`。
2. **优先用专用工具**：查文件用 Glob、读文件用 Read、搜内容用 Grep，而不是 `cd && find`。专用工具不受 cwd 重置影响，结果可靠。系统提示本就要求这样做。
3. **不要凭空下「丢失/不存在」的重结论**：`find` 返回空 ≠ 文件不存在。在断言「文档丢失」这种影响重大的结论前，必须换至少一种独立方法交叉验证（Glob + ls -la 绝对路径）。
4. **相信用户的记忆线索**：用户说「做过工作」时，应优先假设是我没找到，而不是用户记错。用户提供的 `docs/vibe/...` 线索直接解开了谜题。

## 附：那份 2026-07-30 沉淀文档说了什么

`CodePilot/docs/vibe/session-2026-07-30-dev-tooling-and-hexagonal-bmad.md` 记录了 07-30 那次会话：dev 端口工具、v0.62 升级、**codepilot-web 六边形架构 BMad 文档工程**（主体）。它明确写了产出到 `codepilot-web/docs/contexts/` 等，共 44 份，且「本次会话未执行任何 git commit」——这解释了为什么 git 历史里看不到（未提交，但文件在工作区），也是我误判「丢失」的诱因之一。但真相是文件都在，只是未纳入 git 跟踪。
