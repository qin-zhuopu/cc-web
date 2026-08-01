# CLAUDE.md

本文件为在此仓库工作的 Claude 提供项目约定。

## 沟通术语约定

- **禁止使用「上下文」一词指代限界上下文（bounded context）**，该词歧义太大（易与对话上下文、context window 混淆）。
- 指代 SK / C1 / C2 等模块时，**要么用全称**（如「Shared Kernel」「Conversation」「AgentRuntime」），**要么用「领域边界」**。
- 全程使用中文沟通。

## 环境与工具约定

- **Git-Bash 环境下 `git` 输出异常**：本机 Git-Bash 里 `git status --short` 会返回伪造/固定文案，`find -newermt` 无输出。凡需可靠读取 git 状态或枚举文件时，统一用全路径 `/mingw64/bin/git` 直调，或改用 Glob 工具枚举文件，不要依赖裸 `git status` / `find` 的输出。
- **本项目有独立 git 仓库**：`codepilot-web/` 自身即仓库根（上层 dotfiles 仓库的 `.gitignore` 用 `/repo/` 忽略了整个子树，勿把项目提交进 dotfiles 仓库）。
- **LLM 运行时模型配置**：本机集成/E2E 及 C2 SDK 适配器统一走 litellm 网关（`ANTHROPIC_BASE_URL=https://litellm.jereh.cn`）、模型 `Jereh-Kimi-K2.6`。值的**单一真相源是 `apps/api/.env`**（含密钥 `ANTHROPIC_AUTH_TOKEN`，已 gitignored、绝不入库/回显）；入库模板见 `apps/api/.env.example`；承接者说明见 `docs/contexts/c2-agent-runtime/architecture.md §7.1` 与 `epics-stories.md S6.1`。这些 env 由 apps/api 适配层运行时读取并注入 `query()` 的 `options.env`，**不注入 workflow 子代理**（子代理继承会话模型）；核心包 `packages/core` 禁读 `process.env`、禁 `@anthropic-ai/*`。

## TypeScript 约定

- **`tsconfig.base.json` 启用 `verbatimModuleSyntax`**：核心包（及各领域边界）里**类型-only import 必须用 `import type`**，且**模块说明符带 `.js` 扩展名**（NodeNext 解析），否则 `tsc --build` 报错。每个 SK / C1 / C2 故事都会碰到这条。
