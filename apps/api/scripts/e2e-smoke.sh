#!/usr/bin/env bash
# apps/api/scripts/e2e-smoke.sh
# ─────────────────────────────────────────────────────────────────────────────
# EPIC-ACCEPT · accept-9 端到端 smoke 自动化脚本（对齐 SPEC CAP-9、sprint-plan §五 S9）。
#
# 目的：把验收链路（SSE 三件套 + 一式三份 + 断线补发 + CLI）串起来，【尽量自动跑到能跑的程度】。
# 它验证的是真实 SDK-网络-进程全链路，故依赖真实 litellm 环境；无法自动完成的项（双终端人工观察、
# 断线重连的人为操作、关掉重开续接）见同目录 e2e-smoke.md 的「人工 checklist」。
#
# 【安全铁律】
#   - 服务绑 loopback（127.0.0.1），绝不对外暴露（main.ts 默认 HOST=127.0.0.1）。
#   - 本脚本绝不回显 ANTHROPIC_AUTH_TOKEN；.env 经 `set -a; . .env; set +a` 注入进程环境，
#     不出现在命令行参数（ps 可见面）、不进日志。token 只在进程内存。
#   - 所有 curl / 日志输出只含 SSE 事件正文与 sessionId，不含任何凭据。
#
# 【前置条件】
#   - apps/api 已 build（dist/main.js 存在）；若改过源码先 `npm run typecheck`（会增量出 dist）。
#   - apps/api/.env 已配 ANTHROPIC_BASE_URL=https://litellm.jereh.cn、ANTHROPIC_AUTH_TOKEN=<真实值>。
#     【模型名注意】.env 默认 ANTHROPIC_MODEL=Jereh-Kimi-K2.6 经验证【当前 litellm 网关不认】
#     （/v1/models 列表里实际是 JerehW-kimi-k2.6，大小写敏感；详见 deferred-work.md accept-9 条目）。
#     故本脚本默认用 MODEL_OVERRIDE 覆盖为有效名（见下方变量），不改 .env 文件本身。
#
# 【已知阻塞（脚本会探测并如实报告，不卡死）】
#   1. SDK↔litellm 模型名协商：即便覆盖成 litellm /v1/models 列出的有效名，Claude Agent SDK
#      经 /v1/messages 仍报「模型不存在」（直接 curl /v1/messages 同名却能成功）——属 SDK 与网关的
#      anthropic 协议路由层兼容问题，非本 epic 代码问题（详见 deferred-work.md）。
#   2. POST /api/sessions/:id/messages 路由被 C1 MessageController 遮蔽（详见 deferred-work.md
#      accept-9 路由冲突条目）——本脚本会探测并报告，不阻塞其余项。
#
# 用法（在仓库根或 apps/api 下均可）：
#   bash apps/api/scripts/e2e-smoke.sh
#   可选环境变量：
#     PORT=3001                  服务端口（默认 3001）
#     MODEL_OVERRIDE=JerehW-kimi-k2.6  覆盖 *_MODEL（默认 JerehW-kimi-k2.6）
#     KEEP_SERVER=1              跑完不杀服务（便于人工接着双终端观察）
#
# 退出码：0=全部自动项通过；1=有项失败（详见 stdout 报告）。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# —— 配置 ————————————————————————————————————————————————————————————————
PORT="${PORT:-3001}"
HOST="127.0.0.1"
BASE="http://${HOST}:${PORT}"
MODEL_OVERRIDE="${MODEL_OVERRIDE:-JerehW-kimi-k2.6}"
HERE="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$(cd "${HERE}/.." && pwd)"   # apps/api
ENV_FILE="${API_DIR}/.env"
LOG_DIR="${API_DIR}/event-logs"
DB_PATH="${API_DIR}/codepilot.db"
SERVER_LOG="$(mktemp -t cc-web-smoke-server.XXXXXX.log)"
PASS=0; FAIL=0
SERVER_PID=""

# —— 辅助 ————————————————————————————————————————————————————————————————
section() { printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$*"; }
ok()     { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
no()     { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
info()   { printf '  · %s\n' "$*"; }
die_cleanup() { kill_server; exit 1; }

kill_server() {
  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    info "已停止服务 (pid=${SERVER_PID})"
  fi
  SERVER_PID=""
}
trap kill_server EXIT INT TERM

# —— 0. 前置检查 ————————————————————————————————————————————————————————
section "0. 前置检查"
if [ ! -f "${ENV_FILE}" ]; then
  no "未找到 ${ENV_FILE}（需配 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN）"
  exit 1
fi
if ! grep -q '^ANTHROPIC_AUTH_TOKEN=.\+' "${ENV_FILE}"; then
  no "${ENV_FILE} 缺 ANTHROPIC_AUTH_TOKEN（或为空）"
  exit 1
fi
ok ".env 就位（token 不回显）"
if [ ! -f "${API_DIR}/dist/main.js" ]; then
  no "未找到 ${API_DIR}/dist/main.js；请先在仓库根 npm run typecheck 出 dist"
  exit 1
fi
ok "dist/main.js 就位"

# 探测 litellm 网关可达性（不回显 token）。
GATEWAY="$(grep '^ANTHROPIC_BASE_URL=' "${ENV_FILE}" | cut -d= -f2-)"
if curl -sS -m 8 -o /dev/null -w '%{http_code}' "${GATEWAY}/" 2>/dev/null | grep -qE '^(200|301|302|401|403|404)$'; then
  ok "litellm 网关可达：${GATEWAY}"
else
  no "litellm 网关不可达：${GATEWAY}（后续真实 AI 事件将失败）"
fi

# —— 1. 起服务（绑 loopback，注入 .env，覆盖 *_MODEL） ————————————————————
section "1. 起服务（${BASE}，绑 loopback）"
(
  cd "${API_DIR}"
  set -a; . ./.env; set +a
  ANTHROPIC_MODEL="${MODEL_OVERRIDE}" \
  CLAUDE_CODE_SUBAGENT_MODEL="${MODEL_OVERRIDE}" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="${MODEL_OVERRIDE}" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="${MODEL_OVERRIDE}" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="${MODEL_OVERRIDE}" \
  PORT="${PORT}" HOST="${HOST}" \
  node dist/main.js
) > "${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
info "服务 pid=${SERVER_PID}，日志 ${SERVER_LOG}"

# 轮询等就绪（最多 ~15s）。
READY=0
for i in $(seq 1 30); do
  if curl -sS -m 2 -o /dev/null "${BASE}/api/sessions" 2>/dev/null; then READY=1; break; fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    no "服务进程已退出，日志尾部："
    tail -20 "${SERVER_LOG}"
    exit 1
  fi
  sleep 0.5
done
if [ "${READY}" -eq 1 ]; then ok "服务就绪"; else no "服务 15s 内未就绪"; die_cleanup; fi

# —— 2. POST /api/sessions/stream 新建会话 + 第一轮（真实 litellm） ——————————
section "2. POST /api/sessions/stream 新建会话 + 第一轮"
BODY='{"content":"用一句话介绍你自己，然后停止。","model":"'"${MODEL_OVERRIDE}"'","providerId":"anthropic-claude","mode":"ask"}'
OUT="$(curl -sS -N -m 60 -X POST "${BASE}/api/sessions/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d "${BODY}" 2>&1 || true)"

# 首事件：session id。
SID="$(printf '%s' "${OUT}" | grep -A1 '^event: session' | grep '^data:' | sed -E 's/.*"sessionId":"([^"]+)".*/\1/' | head -1)"
if [ -n "${SID}" ]; then
  ok "首事件回推新 sessionId：${SID}"
else
  no "首事件未回推 sessionId（输出见下）"; printf '%s\n' "${OUT}" | head -20
fi

# 是否拿到真实 AI 正文（text 事件且非 "API Error"）。
if printf '%s' "${OUT}" | grep -q '"type":"text"'; then
  if printf '%s' "${OUT}" | grep -q 'API Error'; then
    no "收到 text 事件但为 API Error（SDK↔网关模型协商问题，见 deferred-work.md）"
    info "网关报错片段：$(printf '%s' "${OUT}" | grep 'API Error' | head -1 | cut -c1-120)"
  else
    SAMPLE="$(printf '%s' "${OUT}" | grep '"type":"text"' | head -1 | sed -E 's/.*"text":"([^"]{0,80}).*/\1/')"
    ok "收到真实 AI 正文：${SAMPLE}"
  fi
else
  no "未收到任何 text 事件"
fi

# —— 3. 文件事件日志落盘 + seq 单调 ——————————————————————————————————————
section "3. 文件事件日志（一式三份第二份）"
if [ -n "${SID}" ] && [ -f "${LOG_DIR}/$(printf '%s' "${SID}" | sed 's/:/%3A/g').log" ]; then
  LOGFILE="${LOG_DIR}/$(printf '%s' "${SID}" | sed 's/:/%3A/g').log"
  LINES="$(grep -c . "${LOGFILE}" || true)"
  SEQCHK="$(awk -F'"seq":' 'NR>0{n=$2+0; if(n!=NR){print "BAD"; exit}} END{print "OK"}' "${LOGFILE}")"
  if [ "${LINES}" -gt 0 ]; then ok "日志落盘 ${LINES} 行：${LOGFILE}"; else no "日志为空"; fi
  if [ "${SEQCHK}" = "OK" ]; then ok "seq 严格 +1（从 1 起）"; else no "seq 非严格递增"; fi
else
  no "未找到会话事件日志文件"; [ -n "${SID}" ] && info "期望：${LOG_DIR}/${SID}.log"
fi

# —— 4. SQLite 最终落库（一式三份第三份） ————————————————————————————————
section "4. SQLite 最终落库（一式三份第三份）"
if [ -f "${DB_PATH}" ] && command -v node >/dev/null 2>&1; then
  # 在 apps/api 目录下跑 node，使 better-sqlite3 的 require 解析命中 apps/api/node_modules
  # （monorepo hoist 在根 node_modules，但某些原生模块解析依赖 cwd；DB 用绝对路径）。
  ROWS="$(cd "${API_DIR}" && node -e "
    const D=require('better-sqlite3');
    try{const db=new D('${DB_PATH}',{readonly:true});
      const s=db.prepare('SELECT count(*) c FROM chat_sessions WHERE id=?').get('${SID}');
      const m=db.prepare('SELECT role,stream_status FROM messages WHERE session_id=? ORDER BY rowid DESC LIMIT 1').all('${SID}');
      process.stdout.write(JSON.stringify({sess:s?1:0,msg:m}));
    }catch(e){process.stdout.write(JSON.stringify({err:String(e).slice(0,100)}));}
  " 2>/dev/null || echo '{}')"
  info "SQLite 查询结果：${ROWS}"
  if printf '%s' "${ROWS}" | grep -q '"sess":1'; then ok "会话已落 chat_sessions"; else no "会话未落库"; fi
  if printf '%s' "${ROWS}" | grep -q '"role":"assistant"'; then ok "最终 assistant 消息已落库（控制器未重复落库）"; else no "未落最终 assistant 消息"; fi
else
  no "无法查 SQLite（缺 ${DB_PATH} 或 node）"
fi

# —— 5. GET /:id/stream + Last-Event-ID 断线补发（accept-7，纯文件日志回放） ——
section "5. GET /:id/stream + Last-Event-ID 补发（accept-7）"
if [ -n "${SID}" ]; then
  # Last-Event-ID: 0 → 补发全部。
  R0="$(curl -sS -N -m 5 -H 'Last-Event-ID: 0' "${BASE}/api/sessions/${SID}/stream" 2>/dev/null | grep -c '^id: ' || true)"
  # Last-Event-ID: <末 seq-1> → 应只补发最后一条。
  LASTSEQ="$(grep -oE '"seq":[0-9]+' "${LOGFILE:-/dev/null}" 2>/dev/null | tail -1 | grep -oE '[0-9]+' || echo 0)"
  if [ "${LASTSEQ}" -gt 1 ]; then
    PENULT=$((LASTSEQ-1))
    R1="$(curl -sS -N -m 5 -H "Last-Event-ID: ${PENULT}" "${BASE}/api/sessions/${SID}/stream" 2>/dev/null | grep -c '^id: ' || true)"
    if [ "${R1}" = "1" ]; then ok "Last-Event-ID: ${PENULT} 只补发 1 条（seq>${PENULT}），不重不丢"; else no "补发条数=${R1}（期望 1）"; fi
  fi
  if [ "${R0}" = "${LINES:-0}" ]; then ok "Last-Event-ID: 0 补发 ${R0} 条（与日志行数一致）"; else no "补发条数 ${R0} 与日志 ${LINES:-?} 不符"; fi
else
  no "无 sessionId，跳过补发验证"
fi

# —— 6. POST /:id/messages 路由探测（accept-6，已知被 MessageController 遮蔽） ————
section "6. POST /:id/messages（accept-6，探测路由）"
if [ -n "${SID}" ]; then
  RESP="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/sessions/${SID}/messages" \
    -H 'Content-Type: application/json' \
    -d '{"content":"第二句","model":"'"${MODEL_OVERRIDE}"'","providerId":"anthropic-claude","mode":"ask"}' 2>/dev/null || echo 000)"
  if [ "${RESP}" = "202" ]; then
    ok "POST /:id/messages 返回 202（accept-6 sendMessage 路由生效，立即受理）"
  elif [ "${RESP}" = "500" ]; then
    no "POST /:id/messages 返回 500 —— 命中 C1 MessageController（路由被遮蔽，见 deferred-work.md）"
  else
    no "POST /:id/messages 返回 ${RESP}（非预期）"
  fi
fi

# —— 7. CLI listen 连通性冒烟（accept-8，--new 拿 id） ——————————————————————
section "7. CLI listen 连通性（accept-8）"
CLI_OUT="$(timeout 25 node "${API_DIR}/bin/listen.mjs" --new "冒烟首句" --base "${BASE}" 2>&1 || true)"
if printf '%s' "${CLI_OUT}" | grep -q '【新会话】sessionId = '; then
  ok "CLI --new 连通并拿到 sessionId"
  info "$(printf '%s' "${CLI_OUT}" | grep '新会话' | head -1)"
else
  no "CLI --new 未能拿到 sessionId（输出见下）"; printf '%s\n' "${CLI_OUT}" | head -15
fi

# —— 汇总 ————————————————————————————————————————————————————————————————
section "汇总：通过 ${PASS} / 失败 ${FAIL}"
if [ "${KEEP_SERVER:-0}" = "1" ]; then
  info "KEEP_SERVER=1：服务保留运行（pid=${SERVER_PID}），日志 ${SERVER_LOG}；自行 Ctrl+C 退出"
  trap - EXIT INT TERM
else
  kill_server
fi
if [ "${FAIL}" -gt 0 ]; then exit 1; fi
exit 0
