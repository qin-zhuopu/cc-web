# EPIC-ACCEPT · accept-9 端到端 smoke checklist

> 对齐 SPEC CAP-9、sprint-plan §五 S9。把验收链路（SSE 三件套 + 一式三份 + 断线补发 + CLI）串起来验证。
> 自动化部分见同目录 `e2e-smoke.sh`（`bash apps/api/scripts/e2e-smoke.sh`）；本文件是**人工双终端**观察步骤与已知阻塞。

## 0. 前置条件

- 仓库根已 `npm install`；`apps/api/dist/main.js` 存在（改过源码先 `npm run typecheck` 增量出 dist）。
- `apps/api/.env` 已配：
  - `ANTHROPIC_BASE_URL=https://litellm.jereh.cn`
  - `ANTHROPIC_AUTH_TOKEN=<真实值>`（gitignored，绝不入库/回显）
- **模型名注意（重要）**：`.env` 默认 `ANTHROPIC_MODEL=Jereh-Kimi-K2.6` 经验证 **当前 litellm 网关不认**
  （`GET /v1/models` 列表里实际是 `JerehW-kimi-k2.6`，大小写敏感、多了 `W`）。本 smoke 在起服务时
  用 shell 环境变量覆盖为有效名（**不改 `.env` 文件**，见下方「起服务」）。详见 `deferred-work.md` accept-9 条目。

## 1. 起服务（绑 loopback，注入 .env，覆盖 *_MODEL）

```bash
cd apps/api
set -a; . ./.env; set +a        # 注入 .env 到本 shell 环境（token 不进 ps、不进日志）
ANTHROPIC_MODEL=JerehW-kimi-k2.6 \
CLAUDE_CODE_SUBAGENT_MODEL=JerehW-kimi-k2.6 \
ANTHROPIC_DEFAULT_OPUS_MODEL=JerehW-kimi-k2.6 \
ANTHROPIC_DEFAULT_SONNET_MODEL=JerehW-kimi-k2.6 \
ANTHROPIC_DEFAULT_HAIKU_MODEL=JerehW-kimi-k2.6 \
node dist/main.js
```

预期 stdout 末行：`codepilot-api 已启动：http://127.0.0.1:3001（本机单机，无鉴权，勿暴露公网）`。
所有 accept 路由被 Mapped：`POST /api/sessions/stream`、`POST /api/sessions/:id/messages`、`GET /api/sessions/:id/stream`。

> 【安全】服务只绑 `127.0.0.1`；token 经 `set -a/.env` 注入进程内存，不进命令行参数（ps 可见面）、不进响应体/事件日志/CLI 输出。

## 2. 终端 A：CLI `listen --new` 拿 id 并实时滚事件

另开一个终端（终端 A）：

```bash
node apps/api/bin/listen.mjs --new "用一句话介绍你自己，然后停止。"
```

预期：
- 首行打印 `【新会话】sessionId = <uuid>`（记下这个 id，终端 B 要用）。
- 随后滚动打印流式事件，每条带 `[seq:N]` 前缀，seq 从 1 起严格递增。
- 回合结束打印 `[回合结束]`（带 token 用量），随后 `[CLI] 连接结束，尝试重连挂载…`（一轮跑完后切 GET 挂载，符合 `listen.ts` 设计）。

> **当前已知阻塞**：若 litellm 网关返回 `API Error: 400 [模型不存在]`，说明 SDK↔网关 anthropic 协议层的模型名协商未通
> （非本 epic 代码问题——直接 `curl /v1/messages` 同名模型可成功，但经 Claude Agent SDK 不行；详见 deferred-work.md）。
> 此时链路编排本身（建会话→首事件→SSE 流→seq 递增→日志落盘→终态落库）全部正常，只是 AI 正文为错误回包。

## 3. 终端 B：curl `POST /api/sessions/:id/messages` 发第二句

```bash
SID=<终端A打印的id>
curl -i -X POST "http://127.0.0.1:3001/api/sessions/$SID/messages" \
  -H 'Content-Type: application/json' \
  -d '{"content":"再补一句。","model":"JerehW-kimi-k2.6","providerId":"anthropic-claude","mode":"ask"}'
```

**预期（accept-6 契约）**：立即返回 `202 Accepted`，body `{"accepted":true,"streamId":"..."}`（不阻塞在事件流上）；
终端 A（若仍挂在 GET stream）实时滚出第二轮事件。

> **当前已知阻塞（路由遮蔽）**：实测返回 `500`，服务端日志报 `NOT NULL constraint failed: messages.role`，
> 抛自 `MessageController.append`（C1 既有控制器，`@Controller('api')` 注册了 `POST sessions/:id/messages`）。
> accept-6 的 `SessionStreamController`（`@Controller('api/sessions')`）注册了**完全相同**的 `POST :id/messages` 路由，
> 因 `ConversationModule` 在 `AppModule.imports` 里排在 `AgentRuntimeModule` 之前，C1 的路由先注册、**遮蔽**了 accept-6。
> 修法见 `deferred-work.md`（属 accept-6 范围，本 smoke 仅记录）。

## 4. 断开 A、带 Last-Event-ID 重挂补发（accept-7）

终端 A 按 Ctrl+C 断开。然后用 curl 验证补发：

```bash
SID=<id>
# 从头补发全部（Last-Event-ID: 0）
curl -N -H "Last-Event-ID: 0" "http://127.0.0.1:3001/api/sessions/$SID/stream"
# 只补发 seq>2
curl -N -H "Last-Event-ID: 2" "http://127.0.0.1:3001/api/sessions/$SID/stream"
```

**预期**（已自动验证通过）：
- `Last-Event-ID: 0` → 回放该会话全部历史事件，每条带**原 seq** 作 SSE `id:`，有序不重。
- `Last-Event-ID: 2` → 只回放 seq>2 的事件（不含 seq<=2）。
- 补发完毕 SSE 长连接保持打开（等实时事件）；curl 不会立即退出是预期行为（Ctrl+C 断开即可）。

## 5. 关掉重开 `listen --session <id>` 接着聊（resume 续接，accept-8 / c2-6）

```bash
node apps/api/bin/listen.mjs --session <id>
```

**预期**：CLI 经 GET 挂载，先补发历史（带 Last-Event-ID 语义由 CLI 内部维护），再滚实时事件。
resume 续接（跨轮上下文衔接）由 c2-6 `ClaudeSdkRuntimeAdapter` 保证（依赖 SDK 自身 session 续接能力，本 epic 不重写）。

## 6. 一式三份落点核查（可在任意时刻检查）

```bash
cd apps/api
# ① 文件事件日志（一式三份第二份）：每会话一个，一行一事件含 seq
ls event-logs/
cat event-logs/<sessionId>.log        # 每行 {"seq":N,"event":{...}}，seq 严格 +1
# ③ SQLite 最终落库（一式三份第三份）：会话 + 最终 assistant 消息
node -e "const D=require('better-sqlite3');const db=new D('codepilot.db',{readonly:true});console.log(db.prepare('SELECT id,mode,status FROM chat_sessions').all());console.log(db.prepare('SELECT session_id,role,stream_status FROM messages').all());"
```

- 文件日志是流水账（含中途 text/result/error 全部事件）；SQLite 只存最终 assistant 消息（一轮一条，`stream_status` 反映终态）。
- 控制器**不重复落库**、不边流边塞 SQLite（一式三份落点分离，核心 c2-7 接线负责第三份）。

## 自动化等价

`bash apps/api/scripts/e2e-smoke.sh` 自动覆盖第 0/1/2/4/6 步的可机器判定部分（首事件 id、seq 单调、日志落盘、SQLite 落库、Last-Event-ID 补发、CLI 连通），并如实报告两个已知阻塞（模型协商、路由遮蔽）。第 3 步（POST messages）因路由遮蔽当前返回 500；第 5 步（resume 续接）需人工双终端观察且依赖真实 AI 可用。
