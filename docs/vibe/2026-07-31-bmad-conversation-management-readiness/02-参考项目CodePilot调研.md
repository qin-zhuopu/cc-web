# 02 · 参考项目 CodePilot 调研

调研目的：为 codepilot-web 复刻「会话管理 + Claude Agent SDK 集成」提供一手依据。方法：读一手代码 + 派子代理深挖，两边结论吻合。

## 定位

CodePilot 是多模型 AI Agent 桌面客户端：Electron 40 外壳 + Next.js 16（App Router，前端 + API 层）+ better-sqlite3 本地持久化 + Claude Agent SDK 与 AI 交互。数据目录 `~/.codepilot/`。

## 1. Claude Agent SDK 用法

核心在 `src/lib/claude-client.ts`（3600+ 行，核心函数 `streamClaudeSdk`）。SDK 只有一个入口：

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
const conversation = query({ prompt, options });
for await (const message of conversation) { /* 处理消息流 */ }
```

关键 options：
- `cwd` 工作目录、`abortController` 中断控制
- `includePartialMessages: true` 开启流式增量（text delta）
- `env` / `settingSources` 子进程环境与配置来源
- `model`、`systemPrompt`（{type:'preset', preset:'claude_code', append}）
- `mcpServers`、`permissionMode`、`allowedTools`/`disallowedTools`
- `canUseTool` 权限回调、`hooks`（PreToolUse / PermissionDenied）
- **`resume: sdkSessionId`** —— 会话延续的关键

**会话延续机制**：SDK 通过 `options.resume = sdkSessionId` 恢复。`sdkSessionId` 来自上一轮 SDK 首条 `system/init` 消息里的 `session_id`，持久化到 DB 的 `chat_sessions.sdk_session_id`。resume 失败（会话文件损坏 / cwd 不存在）会 fallback 到全新 query 并把历史拼进 prompt（`buildFallbackContext`）。

## 2. 流式响应形态（消息类型 switch）

消息循环里 `switch(message.type)`：
- `assistant`：助手消息，遍历 content 找 `tool_use` 块
- `user`：工具执行结果（`tool_result` 块）
- `stream_event`（SDKPartialAssistantMessage）：实时增量，`content_block_delta` 里取 `delta.text` / `delta.thinking`
- `system`：`subtype:'init'`（返回 session_id、model、tools）、status、task_started/progress、api_retry
- `result`：终结消息，含 usage（token）、session_id、is_error
- `tool_progress`

每种消息转成自定义 SSE 事件（type: text/thinking/tool_use/tool_result/status/result/...）`enqueue` 进 `ReadableStream<string>`。SSE 格式：`data: ${JSON.stringify(event)}\n\n`（`formatSSE`）。

## 3. 会话数据模型（SQLite）

schema 在 `src/lib/db.ts` 的 `initDb()`。两张核心表：

```sql
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT 'New Chat',
  created_at TEXT, updated_at TEXT,
  model TEXT, system_prompt TEXT,
  working_directory TEXT,
  sdk_session_id TEXT DEFAULT ''          -- SDK resume 用
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,                   -- 纯文本或 JSON.stringify(blocks)
  created_at TEXT,
  token_usage TEXT,                        -- JSON
  stream_status TEXT DEFAULT 'completed',  -- streaming/completed/interrupted/error
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
```

运行时通过一系列 ALTER TABLE 补了很多列，`chat_sessions` 关键新增：`status`、`mode`、`provider_id`、`provider_name`、`runtime_pin`、`sdk_cwd`、`runtime_status`（idle/running/waiting_permission）、`permission_profile`、`context_summary`、`source`（user/task）、`title_origin`；`messages` 新增 `task_run_id`、`is_heartbeat_ack`。启用 WAL + 外键。

## 4. 会话管理业务逻辑（都在 db.ts）

- **新建**：`createSession(...)`，16 字节 hex id，sdk_session_id 初始空
- **列历史**：`getAllSessions({includeSources})`，`ORDER BY updated_at DESC`，按 source 过滤（默认隐藏 task 会话）
- **活跃 vs 历史**：`getActiveSessions()` —— `WHERE runtime_status IN ('running','waiting_permission')`；历史即全量
- **继续聊**：核心是 `updateSdkSessionId(id, sdkSessionId)`。发消息时读出 session.sdk_session_id 传给 streamClaude → options.resume；SDK 返回新 session_id 时写回；压缩/失败时清空让下一轮走全新会话 + 拼历史
- **并发保护**：`session_runtime_locks` 表 + acquire/renew/release/isLockOwner，所有 session 级写入用 isLockOwner 门控，防旧轮次覆盖新轮次

## 5. API 层与 SSE

| 接口 | 方法 | 作用 |
|---|---|---|
| /api/chat/sessions | GET/POST | 列表 / 新建 |
| /api/chat/sessions/[id] | GET/PATCH/DELETE | 单会话增删改 |
| /api/chat/sessions/[id]/messages | GET | 分页取消息（limit/before 游标）|
| /api/chat | POST | 发消息 + 流式返回 |
| /api/chat/interrupt | POST | 中断 |
| /api/chat/permission | POST | 回应工具权限请求 |

**流式返回 = SSE**（非 WebSocket）。`/api/chat` POST 流程：校验 → getSession → acquireSessionLock → setSessionRuntimeStatus('running') → 存用户消息 → 读历史做上下文预算 → streamClaude 得 ReadableStream → `stream.tee()` 分两路（一路 collectStreamResponse 后台持久化 + 回写 sdk_session_id，一路直接返回 text/event-stream）。持久化在 `src/lib/chat-collect-stream-response.ts`。

## 6. Windows 兼容（必须移植）

npm 在 Windows 上把 Claude CLI 装成 `.cmd` wrapper，不能直接 spawn。`resolveScriptFromCmd`（claude-client.ts ~137）解析 wrapper 拿到真实 `cli.js` 路径，传给 `options.pathToClaudeCodeExecutable`。本机是 Windows，复刻时这段必须移植，否则 SDK spawn 失败。

## 关键文件绝对路径清单

- `C:\home\14409.JEREH\repo\github.com\op7418\CodePilot\src\lib\claude-client.ts`（SDK 集成，核心 streamClaudeSdk）
- `...\src\lib\conversation-registry.ts`（全局 Map 存活跃 Query 句柄，支持 interrupt）
- `...\src\lib\db.ts`（schema + 全部 session/message CRUD）
- `...\src\lib\chat-collect-stream-response.ts`（SSE 消费 + blocks 序列化 + 回写 session_id）
- `...\src\app\api\chat\route.ts`（发消息主流程）
- `...\src\app\api\chat\sessions\route.ts` 及 `[id]\messages\route.ts`（会话/消息 API）
- `...\src\types\index.ts`（ChatSession/Message 等业务类型）
- `...\ARCHITECTURE.md`（目录结构与数据流总览）

## NestJS 复刻要点

- `ReadableStream<string>` → NestJS 用 `@Sse()` 装饰器 / 返回 Observable / 手动写 raw response
- conversation-registry（全局 Map + interrupt）→ NestJS `@Injectable()` 单例 service
- 会话锁 + isLockOwner 门控建议保留
- 注意：CodePilot 是生产级复杂封装（多 runtime、权限、MCP、子代理），codepilot-web 只需精简复刻核心
