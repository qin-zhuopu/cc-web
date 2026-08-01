# 02 · worktree 隔离开发流程

## 为何用 worktree

用户主动提议「在 ~/wt/codepilot-web/xxx 开个 worktree 做 c1-6，再合并回来」。这个选择恰好解决一个真实问题：master 工作区当时挂着 c2-4 的未跟踪文件（`epic-c2-4/`、`wf-c2-4.mjs`、`agent-runtime/usecases/`）。worktree 从 HEAD（`dbb77d3`）新建，**不携带未跟踪文件**，天然把 c1-6 的开发与 c2-4 那批文件隔离开。

## 创建流程

1. 用可靠的 `/mingw64/bin/git` 全路径（项目约定：Git-Bash 下裸 git 输出不可信）确认 `~/wt/` 父目录存在、当前干净停在 `dbb77d3 [master]`。
2. `git worktree add -b epic-c1-6 ~/wt/codepilot-web/epic-c1-6 dbb77d3` —— 用有意义的名字 `epic-c1-6` 替代 xxx，从 dbb77d3 拉出新分支。
3. `EnterWorktree`（path 模式）切入 worktree，session 工作目录转到该 worktree。

## 关键坑：node_modules 不随 worktree 复制

git worktree 只复制**版本控制的文件**，`node_modules` 不受版本控制、不会复制。这埋了一个后来暴露的雷：
- 我在 worktree 里只跑了 `npm install better-sqlite3`（装单个包），它只补了 better-sqlite3 子树。
- **根 devDependencies（typescript / vitest / tsx）从没进入这个 worktree** —— 后来跑 `npm run lint` 时报 `'tsc' is not recognized`、`node_modules/typescript` 不存在。
- 根治：在 worktree 里跑一次完整 `npm install` 补齐（详见 04 踩坑文档）。

**教训**：新建 worktree 后、跑任何构建/测试前，先跑完整 `npm install`，别只装你以为需要的那一个包。

## 收尾：退出与清理

1. 完工提交后，`ExitWorktree(action: keep)` 先退回 master 主仓库（保留分支和产出，因为合并要在主仓库做）。
2. 合并回 master 后（详见 05），worktree 使命完成，移除：
   - `git worktree remove <path>` —— 报 `Directory not empty`（node_modules + dist 残留，git 不敢删），但**已把 worktree 从 git 登记注销**。
   - `git branch -d epic-c1-6` —— 分支已合并，安全删除成功。
   - `git worktree remove --force` 反而报 `not a working tree`（因为上一步已注销登记）。
   - 最后 `rm -rf <path>` 直接删磁盘残留目录，干净收场。

**教训**：worktree 目录含 node_modules 时，`git worktree remove` 会因非空失败但已注销登记；此后目录已是普通残留，直接文件系统删除即可，不必纠结 git 命令。
