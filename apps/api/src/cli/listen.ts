// apps/api/src/cli/listen.ts
// 验收链路 · CLI 监听客户端（epic-accept / accept-8，对齐 SPEC CAP-8、sprint-plan §一验收方式）。
//
// 一个【只监听 + 打印】的命令行 SSE 客户端，替代缺失的前端 UI 做端到端验收：
//   - `listen --new`               → POST /api/sessions/stream（带默认/传入 options + 首句），
//                                    从首事件拿到新 session id 并打印，随后滚动打印流式事件；
//   - `listen --session <id>`      → GET  /api/sessions/:id/stream 挂载已有会话滚动打印；
//   - 断线重连：记住最后收到的 seq（SSE id: 字段），重连时带 `Last-Event-ID` 请求头（对齐 accept-7 补发）。
//
// 【职责边界 · 薄层】本模块只做 SSE 客户端 + 友好打印，【不含任何业务逻辑】：
//   不建会话、不起回合、不落库、不解析领域语义——所有「造什么」由 apps/api 控制器 + 核心用例负责，
//   CLI 只是把 HTTP 字节流解析成 (seq, eventName, data) 并按事件类型渲染到 stdout。
//   连接建立用 Node 内置 fetch（Node 18+ 全局可用，本机 Node 22），不引入额外依赖。
//
// 【安全铁律】CLI 绝不打印 / 绝不落任何密钥：
//   - 不读 ANTHROPIC_AUTH_TOKEN / 不读 .env；鉴权与凭据全在 apps/api 服务端，CLI 这一侧零感知。
//   - 只把服务端推送的 SSE 事件正文（type/data）打到 stdout，事件体本身不含密钥（服务端已保证）。
//   - 错误信息只打印状态码 / 网络异常名，绝不回显请求头、绝不回显响应体之外的任何凭据。
//
// 【术语】全程中文；「领域边界」指 Conversation / AgentRuntime 等模块（禁用「上下文」一词指代 bounded context）。
//
// 【模块化】核心逻辑导出为纯函数（parseArgs / formatEvent / connect...），便于单测；
//   main() 仅做 argv 编排 + 信号处理，可被 bin/listen.mjs 直接调用。

import type { AgentStreamEvent } from '@codepilot/core';

/**
 * CLI 解析结果 —— 三种模式互斥。
 *
 * - mode='new'：走 POST /api/sessions/stream，需带首句 content + 默认/传入 options；
 * - mode='session'：走 GET /api/sessions/:id/stream 挂载已有会话；
 * - mode='help' / mode='error'：打印用法 / 报错后退出（不发起连接）。
 */
export interface ParsedArgs {
  readonly mode: 'new' | 'session' | 'help' | 'error';
  /** --session 模式下的会话 id（mode='session' 时必有）。 */
  readonly sessionId?: string;
  /** --new 模式下的第一句话（必填；缺省 error）。 */
  readonly content?: string;
  /** 模型标识（--new 模式下透传给 POST body，默认见 DEFAULTS）。 */
  readonly model?: string;
  /** Provider 标识（--new 模式下透传给 POST body，默认见 DEFAULTS）。 */
  readonly providerId?: string;
  /** 会话/回合模式：code/plan/ask（可选透传）。 */
  readonly mode2?: 'code' | 'plan' | 'ask';
  /** 工作目录（可选透传给建会话 body）。 */
  readonly workingDirectory?: string;
  /** 服务基地址（默认 http://127.0.0.1:3001，可 --base 覆盖）。 */
  readonly baseUrl?: string;
  /** 错误信息（mode='error' 时必有）。 */
  readonly error?: string;
}

/**
 * 默认值 —— 与 apps/api/.env / SPEC 对齐的 litellm 网关模型。
 * model / providerId 对齐 accept-1 stub（apps/api/src/agent-runtime/adapters/stub-provider-repository.ts）。
 */
export const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3001',
  model: 'Jereh-Kimi-K2.6',
  providerId: 'anthropic-claude',
} as const;

/** 用法文案（help / error 共用）。 */
export const USAGE = `用法：
  listen --new "--new 模式的第一句话" [--model <m>] [--provider <p>] [--mode code|plan|ask]
          [--cwd <dir>] [--base <url>]
    经 POST /api/sessions/stream 新建会话并跑第一轮，打印回推的新 session id，随后滚动打印流式事件。

  listen --session <id> [--base <url>]
    经 GET /api/sessions/:id/stream 挂载已有会话，滚动打印流式事件。

  listen --help
    打印本用法。

选项：
  --base <url>      服务基地址（默认 ${DEFAULTS.baseUrl}，本机 loopback，勿改公网）。
  --model <m>       模型标识（--new 用，默认 ${DEFAULTS.model}）。
  --provider <p>    Provider 标识（--new 用，默认 ${DEFAULTS.providerId}）。
  --mode <m>        会话/回合模式 code|plan|ask（--new 可选）。
  --cwd <dir>       工作目录（--new 可选，透传给建会话）。

说明：
  断线重连自动带 Last-Event-ID（最后收到的 seq），服务端据此补发 seq 之后的事件。
  CLI 只监听 + 打印，不含业务逻辑；绝不打印任何密钥。
`;

/**
 * 解析命令行参数（纯函数，便于单测）。
 *
 * 约定：
 *   - --new "<首句>"   首句以【下一个 argv】给出（必须引号包裹以保留空格），允许 --new 后跟自己的句子。
 *   - --session <id>   会话 id 走下一个 argv。
 *   - 其余 --key value 成对解析。
 *   - --help / 无参 → help。
 *   - 同时给 --new 与 --session、或都缺 → error。
 */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  // 复制一份可索引的工作数组（noUncheckedIndexedAccess 下 argv[i] 是 T|undefined）。
  const args = [...argv];

  if (args.length === 0) {
    return { mode: 'help' };
  }

  // 先扫一遍找标志位，区分模式。
  let hasNew = false;
  let hasSession = false;
  let hasHelp = false;
  for (const a of args) {
    if (a === '--help' || a === '-h') hasHelp = true;
    else if (a === '--new') hasNew = true;
    else if (a === '--session') hasSession = true;
  }

  if (hasHelp) {
    return { mode: 'help' };
  }
  if (hasNew && hasSession) {
    return { mode: 'error', error: '不能同时指定 --new 与 --session。' };
  }
  if (!hasNew && !hasSession) {
    return { mode: 'error', error: '必须指定 --new 或 --session <id> 之一（用 --help 查看用法）。' };
  }

  // 逐位取值。
  const result: {
    content?: string;
    sessionId?: string;
    model?: string;
    providerId?: string;
    mode2?: 'code' | 'plan' | 'ask';
    workingDirectory?: string;
    baseUrl?: string;
  } = {};

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === undefined) continue;
    switch (tok) {
      case '--new': {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) {
          return { mode: 'error', error: '--new 需要跟一句首句文本（用引号包裹）。' };
        }
        result.content = v;
        i += 1;
        break;
      }
      case '--session': {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) {
          return { mode: 'error', error: '--session 需要跟一个会话 id。' };
        }
        result.sessionId = v;
        i += 1;
        break;
      }
      case '--base': {
        const v = args[i + 1];
        if (v === undefined) {
          return { mode: 'error', error: '--base 需要跟一个 URL。' };
        }
        result.baseUrl = v;
        i += 1;
        break;
      }
      case '--model': {
        const v = args[i + 1];
        if (v === undefined) {
          return { mode: 'error', error: '--model 需要跟一个模型标识。' };
        }
        result.model = v;
        i += 1;
        break;
      }
      case '--provider': {
        const v = args[i + 1];
        if (v === undefined) {
          return { mode: 'error', error: '--provider 需要跟一个 Provider 标识。' };
        }
        result.providerId = v;
        i += 1;
        break;
      }
      case '--mode': {
        const v = args[i + 1];
        if (v !== 'code' && v !== 'plan' && v !== 'ask') {
          return { mode: 'error', error: '--mode 只能是 code|plan|ask。' };
        }
        result.mode2 = v;
        i += 1;
        break;
      }
      case '--cwd': {
        const v = args[i + 1];
        if (v === undefined) {
          return { mode: 'error', error: '--cwd 需要跟一个工作目录路径。' };
        }
        result.workingDirectory = v;
        i += 1;
        break;
      }
      default:
        return { mode: 'error', error: `未识别的参数：${tok}（用 --help 查看用法）。` };
    }
  }

  if (hasNew) {
    if (result.content === undefined) {
      return { mode: 'error', error: '--new 模式必须提供首句文本。' };
    }
    return { mode: 'new', ...result };
  }

  // hasSession
  if (result.sessionId === undefined) {
    return { mode: 'error', error: '--session 模式必须提供会话 id。' };
  }
  return { mode: 'session', ...result };
}

/**
 * 一帧 SSE 解析结果 —— 一个事件块（空行分隔）解析出的结构化字段。
 *
 * SSE 帧格式（服务端 session-stream.controller.ts 写出）：
 *   id: <seq>\n
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 * 其中 id 行可缺（首帧 session 事件不带 seq）；event 行可缺（默认 message）；data 可多行（JSON 应单行）。
 */
export interface SseFrame {
  /** SSE id 字段（会话内单调递增 seq；首帧 session 事件无 seq）。 */
  readonly id?: number;
  /** SSE event 字段（事件 type；缺省 'message'）。 */
  readonly event: string;
  /** SSE data 字段聚合（多行 data 用 \n 连接）。 */
  readonly data: string;
}

/**
 * 把【一个事件块】（已按空行切出的多行文本）解析成 SseFrame（纯函数）。
 *
 * @param block 不含尾随空行的多行字符串（缓冲区按 /\n\n/ 切出的片断）。
 * @returns 解析失败（无任何已知字段）返回 undefined，调用方可丢。
 */
export function parseSseBlock(block: string): SseFrame | undefined {
  let id: number | undefined;
  let event = 'message';
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    // SSE 规范：以冒号开头的行是注释，忽略。
    if (rawLine.startsWith(':')) continue;
    // 处理 "field: value" 与 "field:" 两种形式（冒号后可有一个前导空格）。
    const colon = rawLine.indexOf(':');
    if (colon < 0) continue;
    const field = rawLine.slice(0, colon);
    let value = rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') {
      // 仅纯数字才作 seq 游标（对齐服务端 parseLastEventId 的严格口径）。
      if (/^\d+$/.test(value)) {
        id = Number.parseInt(value, 10);
      }
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // 其余 field（retry 等）忽略，CLI 不需要。
  }

  // 无 data 且无 id 也无显式 event → 空块/无意义块，丢弃。
  if (id === undefined && event === 'message' && dataLines.length === 0) {
    return undefined;
  }

  return { id, event, data: dataLines.join('\n') };
}

/**
 * 把整条 SSE 字节流增量切成事件块（纯函数式状态机）。
 *
 * 维护一个累积缓冲区，按 /\n\n/ 切出完整事件块；尾段不足一个块则留待下次。
 * 用于把 fetch body 的流式 chunk 序列翻译成 SseFrame 序列（详见 connect 里的消费循环）。
 */
export class SseBuffer {
  private buf = '';

  /** 喂入一段文本，返回本次新切出的【完整事件块】列表（可能为空）。 */
  feed(chunk: string): string[] {
    this.buf += chunk;
    const blocks: string[] = [];
    // SSE 事件分隔为空行（\n\n）；兼容 \r\n\r\n 行尾。
    while (true) {
      const idx = this.buf.search(/\r?\n\r?\n/);
      if (idx < 0) break;
      const block = this.buf.slice(0, idx);
      // 跳过匹配到的分隔符（两个换行或两个 CRLF）。
      const match = this.buf.match(/\r?\n\r?\n/);
      const sepLen = match ? match[0].length : 2;
      this.buf = this.buf.slice(idx + sepLen);
      blocks.push(block);
    }
    return blocks;
  }

  /** 流结束时冲刷残余缓冲（若尾部有未以空行结尾的事件块，按规范仍解析）。 */
  flush(): string[] {
    if (this.buf.length === 0) return [];
    const rest = this.buf;
    this.buf = '';
    return [rest];
  }
}

/**
 * 把一个解析后的 SseFrame 格式化成【人类可读的一行 / 多行文本】（不含末尾换行）。
 *
 * 按事件 type 友好打印（对齐 AgentStreamEvent 14 类 + 服务端约定的 session 首帧）：
 *   - session：打印新会话 id（CLI --new 拿到的 id）；
 *   - text：正文（累积全文，直接打印）；
 *   - thinking：思考增量（加灰色前缀）；
 *   - tool_use / tool_result / tool_output：工具调用信息；
 *   - status：状态行；
 *   - result：回合结束（带 token 用量若有）；
 *   - error：错误（红色前缀）；
 *   - permission_request / permission_resolved：权限；
 *   - context_usage / rate_limit / file_changed / phase_changed：其余类型原样摘要；
 *   - 未知 type：原样打印 data。
 *
 * @param frame 已解析的 SSE 帧（data 应为 JSON；非法 JSON 时降级原样打印文本）。
 * @returns 可读字符串；调用方负责 process.stdout.write(frame + '\n')。
 */
export function formatEvent(frame: SseFrame): string {
  const { id, event, data } = frame;
  // seq 前缀（有则带上，便于断线重连时人眼对账）。
  const seqTag = id === undefined ? '' : `[seq:${id}] `;

  // session 首帧：data 形如 {"type":"session","sessionId":"..."}
  if (event === 'session') {
    const parsed = safeParseJson<{ sessionId?: unknown }>(data);
    const sid = typeof parsed?.sessionId === 'string' ? parsed.sessionId : data;
    return `${seqTag}【新会话】sessionId = ${sid}`;
  }

  // 其余事件：data 应为 AgentStreamEvent JSON。解析失败则原样打印。
  const ev = safeParseJson<AgentStreamEvent>(data);
  if (ev === undefined || typeof ev.type !== 'string') {
    // 非 JSON：直接打印 data 文本（仍是服务端推来的正文，无密钥）。
    return `${seqTag}${event}: ${data}`;
  }

  // 按 AgentStreamEvent 的 14 类 type + session 渲染。
  switch (ev.type) {
    case 'text':
      return `${seqTag}${ev.text}`;
    case 'thinking':
      return `${seqTag}[思考] ${ev.delta}`;
    case 'tool_use':
      return `${seqTag}[工具调用] ${ev.tool.name}(${summarizeInput(ev.tool.input)})`;
    case 'tool_result':
      return `${seqTag}[工具结果${ev.result.isError ? '·错误' : ''}] ${truncate(ev.result.content)}`;
    case 'tool_output':
      return `${seqTag}[工具输出] ${truncate(ev.data)}`;
    case 'status':
      return `${seqTag}[状态] ${ev.text}`;
    case 'result': {
      const parts: string[] = ['[回合结束]'];
      if (ev.tokenUsage !== undefined) {
        parts.push(
          `tokens 入${ev.tokenUsage.inputTokens}/出${ev.tokenUsage.outputTokens}` +
            (ev.tokenUsage.totalTokens !== undefined ? `/合${ev.tokenUsage.totalTokens}` : ''),
        );
      }
      if (ev.terminalReason !== undefined) {
        parts.push(`终因=${ev.terminalReason}`);
      }
      return `${seqTag}${parts.join(' ')}`;
    }
    case 'error':
      return `${seqTag}[错误] ${JSON.stringify(ev.error)}`;
    case 'permission_request':
      return `${seqTag}[权限请求] ${ev.request.toolName}(${summarizeInput(ev.request.input)})`;
    case 'permission_resolved':
      return `${seqTag}[权限决议] ${ev.permissionRequestId} → ${ev.status}`;
    case 'context_usage':
      return `${seqTag}[上下文占用] ${ev.usage.usedTokens}/${ev.usage.maxTokens}`;
    case 'rate_limit':
      return `${seqTag}[限流] ${JSON.stringify(ev.info)}`;
    case 'file_changed':
      return `${seqTag}[文件变更] ${ev.paths.join(', ')}`;
    case 'phase_changed':
      return `${seqTag}[相位] ${ev.phase}`;
    default: {
      // 兜底：未知类型原样打印（TS 层面 ev 已 never，但运行时防御）。
      const exhaustive: never = ev;
      return `${seqTag}[未知事件] ${JSON.stringify(exhaustive)}`;
    }
  }
}

/** 安全解析 JSON：失败返回 undefined（不抛）。 */
function safeParseJson<T = unknown>(text: string): T | undefined {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** 把工具入参对象摘要成短串（截断长值，避免刷屏）。 */
function summarizeInput(input: Readonly<Record<string, unknown>>): string {
  const s = JSON.stringify(input);
  return truncate(s, 80);
}

/** 截断长字符串，超过 max 加省略号。 */
function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（共 ${s.length} 字符）`;
}

/**
 * 连接状态 —— 跨重连记忆最后收到的 seq（Last-Event-ID 游标）。
 *
 * 每次 connect 收到带 id 的帧就更新 lastSeq；断线重连时把它放进 Last-Event-ID 请求头。
 */
export interface ListenState {
  /** 最后收到的 seq；undefined 表示尚未收到任何带 seq 的事件（重连不带 Last-Event-ID）。 */
  lastSeq?: number;
  /** --new 模式下从首事件拿到的会话 id；后续若切到 GET 挂载（重连）需带上。 */
  sessionId?: string;
}

/**
 * 连接选项 —— 把 ParsedArgs 解析后用于发起连接的扁平结构。
 */
export interface ConnectOptions {
  readonly baseUrl: string;
  /** 'new' 走 POST /api/sessions/stream；'session' 走 GET /api/sessions/:id/stream。 */
  readonly mode: 'new' | 'session';
  /** 'session' 模式必填；'new' 模式下首事件回填后存入 state.sessionId。 */
  readonly sessionId?: string;
  /** 'new' 模式的 POST body（首句 + options）。 */
  readonly body?: Record<string, unknown>;
  /** Last-Event-ID 游标（首次为 undefined；重连带最后 seq）。 */
  readonly lastEventId?: number;
  /** 流式回调：每解析出一帧调用之（默认打印到 stdout）。 */
  readonly onFrame?: (frame: SseFrame, text: string) => void;
  /** 自定义 fetch（默认用全局 fetch；单测注入 stub 用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 重连前等待毫秒（默认 1000；单测可设 0）。 */
  readonly reconnectDelayMs?: number;
  /** 退出信号：once true 则下次断线后不再重连（如 Ctrl+C）。 */
  readonly shouldStop?: () => boolean;
  /** 最大重连次数（默认 Infinity；单测可限定）。 */
  readonly maxReconnects?: number;
}

/**
 * 连接结果 —— 一次连接（自然结束或抛错）的汇总。
 * - 收到的最大 seq（更新 state.lastSeq 供下次重连）；
 * - 若 --new 模式从首事件拿到 sessionId，回填到 state；
 * - error：连接异常（非 2xx、网络错、解析错），由调用方决定是否重连。
 */
export interface ConnectResult {
  readonly lastSeq?: number;
  readonly sessionId?: string;
  readonly error?: string;
}

/**
 * 发起一次 SSE 连接（POST /stream 或 GET /:id/stream），逐帧解析回调。
 *
 * 不含重连逻辑（由 runReconnect 编排）；本函数只负责【一次连接】的生命周期：
 *   1. 构造请求（method/url/headers/body）；
 *   2. fetch → 校验响应状态 → 拿 body reader；
 *   3. text decoder 喂 SseBuffer，逐块 parseSseBlock → onFrame；
 *   4. 自然结束（body done）返回 lastSeq/sessionId；异常返回 error。
 *
 * 不重试、不退避——保持单次语义清晰，重连交给上层。
 */
export async function connectOnce(opts: ConnectOptions): Promise<ConnectResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const onFrame = opts.onFrame ?? defaultOnFrame;

  const url = buildUrl(opts);
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  // Last-Event-ID 游标（断线重连带最后 seq，对齐 accept-7 补发）。
  if (opts.lastEventId !== undefined) {
    headers['Last-Event-ID'] = String(opts.lastEventId);
  }

  const init: RequestInit = {
    method: opts.mode === 'new' ? 'POST' : 'GET',
    headers,
  };
  if (opts.mode === 'new' && opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let resp: Response;
  try {
    resp = await fetchImpl(url, init);
  } catch (e) {
    return { error: `连接失败：${describeError(e)}` };
  }

  if (!resp.ok) {
    return { error: `HTTP ${resp.status} ${resp.statusText}` };
  }
  if (resp.body === null) {
    return { error: '响应无 body 流。' };
  }

  // 增量解析：reader.read() → Uint8Array → text → SseBuffer.feed → parseSseBlock。
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const buffer = new SseBuffer();
  let lastSeq = opts.lastEventId;
  let sessionId = opts.sessionId;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const block of buffer.feed(text)) {
        const frame = parseSseBlock(block);
        if (frame === undefined) continue;
        if (frame.id !== undefined) {
          lastSeq = frame.id;
        }
        // --new 首事件回填 sessionId。
        if (frame.event === 'session') {
          const parsed = safeParseJson<{ sessionId?: unknown }>(frame.data);
          if (typeof parsed?.sessionId === 'string') {
            sessionId = parsed.sessionId;
          }
        }
        onFrame(frame, formatEvent(frame));
      }
    }
    // 冲刷尾部残余（流末尾未以空行结尾的事件块）。
    for (const block of buffer.flush()) {
      const frame = parseSseBlock(block);
      if (frame === undefined) continue;
      if (frame.id !== undefined) lastSeq = frame.id;
      if (frame.event === 'session') {
        const parsed = safeParseJson<{ sessionId?: unknown }>(frame.data);
        if (typeof parsed?.sessionId === 'string') {
          sessionId = parsed.sessionId;
        }
      }
      onFrame(frame, formatEvent(frame));
    }
  } catch (e) {
    return { lastSeq, sessionId, error: `流读取中断：${describeError(e)}` };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已关闭则忽略 */
    }
  }

  return { lastSeq, sessionId };
}

/** 默认 onFrame：把格式化后的文本打到 stdout（带换行）。 */
function defaultOnFrame(_frame: SseFrame, text: string): void {
  process.stdout.write(`${text}\n`);
}

/** 据 mode 构造请求 URL。 */
function buildUrl(opts: ConnectOptions): string {
  const base = trimTrailingSlash(opts.baseUrl);
  if (opts.mode === 'new') {
    return `${base}/api/sessions/stream`;
  }
  // session 模式：sessionId 必填（调用方保证）。
  const sid = opts.sessionId ?? '';
  return `${base}/api/sessions/${encodeURIComponent(sid)}/stream`;
}

/** 去掉 base url 末尾的斜杠（避免 //stream）。 */
function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** 把未知错误归一成短串（不回显任何敏感结构）。 */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.name === 'Error' ? e.message : e.name;
  return '未知错误';
}

/**
 * 带断线重连的连接循环。
 *
 * 流程：
 *   loop:
 *     connectOnce(state.lastSeq)
 *       → 成功（无 error）：自然结束，【对 SSE 而言连接被服务端关闭】→ 若未 shouldStop 则重连；
 *       → 失败（error）：打印错误 → 若未 shouldStop 且未超 maxReconnects 则等待后重连；
 *     重连带 Last-Event-ID = state.lastSeq（对齐 accept-7 补发）。
 *
 * 【为何成功结束也重连】SSE 是长连接：服务端 res.end()（如 POST /stream 一轮跑完）会令 body done。
 *   对 --new 模式，一轮结束后客户端通常想继续挂着等下一轮（由 POST /:id/messages 触发），
 *   故切到 GET /:id/stream 重连（用已拿到的 sessionId），带 Last-Event-ID 补发断线期间事件。
 *   对 --session 模式，连接断开同理重连。
 *
 * 返回最终 state（应 Ctrl+C 等退出时）。
 */
export async function runReconnect(
  opts: ConnectOptions,
  state: ListenState = {},
): Promise<ListenState> {
  const maxReconnects = opts.maxReconnects ?? Number.POSITIVE_INFINITY;
  const delayMs = opts.reconnectDelayMs ?? 1000;
  const shouldStop = opts.shouldStop ?? (() => false);
  let attempts = 0;
  // 是否已从 --new 切到 GET 挂载（切过后 mode 固定 session，不再 POST 重复建会话）。
  let mode: 'new' | 'session' = opts.mode;
  let curSessionId = opts.sessionId;

  // 当前连接的 lastSeq 初值取 state.lastSeq（断线重连的起点）。
  let lastSeq = state.lastSeq;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (shouldStop()) break;
    const result = await connectOnce({
      ...opts,
      mode,
      sessionId: curSessionId,
      // 首次 --new 连接不发 Last-Event-ID（无历史可补）；之后重连都带。
      lastEventId: lastSeq,
      // --new 切到 session 后不再带 body（GET 不需要）。
      body: mode === 'new' ? opts.body : undefined,
    });
    if (result.lastSeq !== undefined) lastSeq = result.lastSeq;
    if (result.sessionId !== undefined) curSessionId = result.sessionId;

    // --new 一次连接拿到 sessionId 后，后续重连切 GET /:id/stream。
    if (mode === 'new' && curSessionId !== undefined) {
      mode = 'session';
    }

    if (result.error !== undefined) {
      process.stderr.write(`[CLI] ${result.error}\n`);
    }

    if (shouldStop()) break;
    attempts += 1;
    if (attempts > maxReconnects) {
      process.stderr.write(`[CLI] 已达最大重连次数 ${maxReconnects}，退出。\n`);
      break;
    }

    // 自然结束（一轮跑完）也提示一句，便于人眼区分。
    if (result.error === undefined) {
      process.stderr.write('[CLI] 连接结束，尝试重连挂载…\n');
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    lastSeq,
    sessionId: curSessionId,
  };
}

/** Promise 化的 setTimeout。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CLI 主入口 —— 解析 argv、分发模式、装配 ConnectOptions 并启动重连循环。
 *
 * @param argv 通常取 process.argv.slice(2)。
 * @returns 退出码（0 正常 / 1 参数错 / 2 运行错）。Ctrl+C 优雅退出返回 0。
 *
 * 信号处理：SIGINT（Ctrl+C）置 shouldStop=true，让重连循环下次退出（不硬杀，
 *   避免半行输出；当前正在 connectOnce 的 fetch 会被信号打断自然返回 error）。
 */
export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.mode === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.mode === 'error') {
    process.stderr.write(`错误：${parsed.error ?? '参数解析失败'}\n\n`);
    process.stderr.write(USAGE);
    return 1;
  }

  const baseUrl = parsed.baseUrl ?? DEFAULTS.baseUrl;

  // SIGINT：优雅退出（重连循环下次判断 shouldStop 即停）。
  let stopped = false;
  const onSigInt = (): void => {
    stopped = true;
    process.stderr.write('\n[CLI] 收到退出信号，正在结束…\n');
  };
  process.on('SIGINT', onSigInt);

  try {
    if (parsed.mode === 'new') {
      // --new：POST /api/sessions/stream，首句 + options。
      const body: Record<string, unknown> = {
        content: parsed.content,
        model: parsed.model ?? DEFAULTS.model,
        providerId: parsed.providerId ?? DEFAULTS.providerId,
      };
      if (parsed.mode2 !== undefined) body.mode = parsed.mode2;
      if (parsed.workingDirectory !== undefined) body.workingDirectory = parsed.workingDirectory;

      await runReconnect(
        {
          baseUrl,
          mode: 'new',
          body,
          shouldStop: () => stopped,
        },
        {},
      );
      return 0;
    }

    // parsed.mode === 'session'
    await runReconnect(
      {
        baseUrl,
        mode: 'session',
        sessionId: parsed.sessionId,
        shouldStop: () => stopped,
      },
      {},
    );
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }
}

// —— 模块入口守卫 ————————————————————————————————————————————————
// 当本文件被【直接作为脚本运行】（node / tsx listen.ts ...）时，自动调 main() 并按退出码退出。
// 被 import（单测 / bin/listen.mjs 显式调 main）时 import.meta.main === false，不自动执行，
//   避免副作用（单测只测纯函数 + 显式 connectOnce/runReconnect）。
//
// Node 22.22 支持 import.meta.main（ESM 入口判定）；用 in 守卫防御旧版本缺字段。
//
// bin/listen.mjs 不经此守卫（它直接 await import 后调 main(argv)），故即便守卫不触发也不影响 bin 路径。
if (typeof import.meta === 'object' && import.meta !== null && 'main' in import.meta && import.meta.main === true) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((e) => {
      process.stderr.write(`[CLI] 异常退出：${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    });
}
