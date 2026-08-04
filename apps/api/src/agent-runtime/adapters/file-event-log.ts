// apps/api/src/agent-runtime/adapters/file-event-log.ts
// 文件事件日志适配器 —— 每会话 append-only 一行一事件，单调递增 seq（epic-accept / accept-3，SPEC CAP-3）。
//
// 【一式三份中的第二份】每个流式归一事件三个落点：① SSE 实时推（seq=SSE id，属广播中枢 CAP-2）；
//   ② 本文件事件日志 append-only 一行一事件含 seq（实时缓冲 + 断线补发数据源，本文件）；
//   ③ SQLite 最终落库（一轮结束经 C1 存消息用例存最终 assistant 消息，属 c2-7 接线）。
//   三者落点分离：本日志是「流水账」，只追加、不覆盖、不改写；SQLite 只存干净最终结果。
//
// 【seq 语义】每会话内单调递增：从 1 起严格 +1，即 SSE `id:` 字段来源，是断线重连游标。
//   本期单机单进程，seq 单调性由内存计数保证；进程重启后首次访问某会话时读文件末尾恢复最大 seq。
//   不处理多进程 / 多副本并发写同一会话日志的 seq 竞争（SPEC「非目标」明确排除）。
//
// 【铁律】本文件在 apps/api（框架层），允许 node:fs / node:path / node:readline；只 import type
//   核心事件类型（@codepilot/core），绝不进 packages/core，绝不含领域逻辑。
//
// 【安全】日志落盘会话全部流式内容（用户输入 + AI 回复正文），属潜在敏感数据，本期存明文于本机
//   工作目录，不加密 / 不轮转 / 不清理，仅供本机验收（安全事实已记录在 SPEC）。密钥
//   ANTHROPIC_AUTH_TOKEN 绝不写入日志——本适配器只序列化传入的 AgentStreamEvent，不触碰任何 env / 凭据。

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentStreamEvent } from '@codepilot/core';

/**
 * EventLogEntry —— 日志中的一条记录：单调递增 seq + 归一事件。
 * append 写入与 readAfter 读出的最小单元。
 */
export interface EventLogEntry {
  readonly seq: number;
  readonly event: AgentStreamEvent;
}

/**
 * AppendResult —— append 分配到的 seq（调用方据此写 SSE `id:` 字段）。
 */
export interface AppendResult {
  readonly seq: number;
}

/**
 * 默认日志基目录。对齐 database.module 的 process.env 约定（读 env 属框架层职责，核心禁读）。
 * 每会话一个日志文件落于此目录下（文件名由会话 id 安全编码得到）。
 */
function defaultBaseDir(): string {
  return process.env.CODEPILOT_EVENT_LOG_DIR ?? path.resolve('event-logs');
}

/**
 * 把 sessionId 安全编码为单段文件名：编码掉路径分隔符等，杜绝目录穿越（`../`、绝对路径）。
 * encodeURIComponent 会把 `/`、`\`、`.` 之外的分隔字符转义，UUID 形态的会话 id 原样可读。
 */
function sessionLogFileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.log`;
}

/**
 * FileEventLog —— 每会话 append-only 文件事件日志适配器。
 *
 * - append(sessionId, event)：分配下一个 seq、序列化成一行 JSON 追加写（绝不覆盖既有行），返回 { seq }。
 * - readAfter(sessionId, afterSeq)：有序产出 seq > afterSeq 的历史记录，供断线补发；坏行（脏 JSON）跳过不炸。
 *
 * seq 分配在单进程内经「每会话串行写链」保证不竞争、不交错：同会话的并发 append 依次执行，
 * 每次 seq 严格 +1，写入的行天然按 seq 升序排列（readAfter 无需再排序）。
 */
export class FileEventLog {
  private readonly baseDir: string;

  // sessionId → 该会话已分配的最大 seq（0 表示尚无事件）。首次访问经读文件末尾恢复。
  private readonly lastSeq = new Map<string, number>();

  // sessionId → 串行写链，序列化同会话的并发 append，避免 seq 竞争与行交错。
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? defaultBaseDir();
  }

  /**
   * 追加一个事件到该会话日志，分配下一个单调递增 seq。
   *
   * 同会话的多次 append 经写链串行执行：即使调用方并发触发，seq 也严格 +1、行不交错。
   * 单次 append 失败不打断后续 append（写链以吞错续接），失败的 Promise 仍如实抛给本次调用方。
   */
  append(sessionId: string, event: AgentStreamEvent): Promise<AppendResult> {
    const previous = this.writeChains.get(sessionId) ?? Promise.resolve();
    const result = previous.then(() => this.doAppend(sessionId, event));
    // 写链吞掉本次结果的成败，保证后续 append 仍能续接执行；本次成败照常返回给调用方。
    this.writeChains.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async doAppend(sessionId: string, event: AgentStreamEvent): Promise<AppendResult> {
    const seq = (await this.currentLastSeq(sessionId)) + 1;
    const entry: EventLogEntry = { seq, event };
    // 一行一事件（JSON + 换行）。append 模式绝不覆盖既有行。
    const line = `${JSON.stringify(entry)}\n`;

    await mkdir(this.baseDir, { recursive: true });
    await appendFile(this.filePath(sessionId), line, 'utf8');

    this.lastSeq.set(sessionId, seq);
    return { seq };
  }

  /**
   * 有序产出 seq > afterSeq 的历史记录。空 / 不存在的日志产出空序列。
   *
   * 逐行读取（node:readline），行按写入顺序即 seq 升序；坏行（脏 JSON / 缺 seq）跳过不炸，
   * 保证一条坏行不阻断整段补发。afterSeq <= 0 时等价从头补发全部记录。
   */
  async *readAfter(sessionId: string, afterSeq: number): AsyncIterable<EventLogEntry> {
    const entries = this.streamLines(this.filePath(sessionId));
    for await (const entry of entries) {
      if (entry.seq > afterSeq) {
        yield entry;
      }
    }
  }

  private filePath(sessionId: string): string {
    return path.join(this.baseDir, sessionLogFileName(sessionId));
  }

  /**
   * 恢复 / 返回某会话已分配的最大 seq：内存有则直接用；否则读文件末尾解析出最大 seq
   * （文件不存在按 0 记）。恢复后写入内存缓存，供后续 append 快速 +1。
   */
  private async currentLastSeq(sessionId: string): Promise<number> {
    const cached = this.lastSeq.get(sessionId);
    if (cached !== undefined) {
      return cached;
    }

    let max = 0;
    let raw: string;
    try {
      raw = await readFile(this.filePath(sessionId), 'utf8');
    } catch (error) {
      // 文件不存在（ENOENT）视为空日志、最大 seq 为 0；其它读错误同样按 0 起（本期单机验收容忍）。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 非「不存在」的读错误：不静默吞成 0 掩盖故障，直接上抛由调用方感知。
        throw error;
      }
      this.lastSeq.set(sessionId, 0);
      return 0;
    }

    for (const rawLine of raw.split('\n')) {
      const parsed = parseEntry(rawLine);
      if (parsed !== undefined && parsed.seq > max) {
        max = parsed.seq;
      }
    }
    this.lastSeq.set(sessionId, max);
    return max;
  }

  /**
   * 逐行读取日志文件并解析为 EventLogEntry；坏行跳过。文件不存在时产出空序列。
   */
  private async *streamLines(filePath: string): AsyncIterable<EventLogEntry> {
    // createReadStream 对不存在文件是异步 'error' 事件：readline 的 for-await 会以该错误 reject，
    // 需在迭代处 try/catch 拦截，ENOENT 视为空日志（返回空序列），其它错误上抛不静默掩盖。
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const rawLine of rl) {
        const parsed = parseEntry(rawLine);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // 文件不存在：空日志，产出空序列。
    } finally {
      rl.close();
      stream.destroy();
    }
  }
}

/**
 * 把一行原始文本解析为 EventLogEntry：空行 / 脏 JSON / 结构不符（缺 seq 或 event）一律返回 undefined，
 * 由调用方跳过，保证一条坏行不阻断整段读取。
 */
function parseEntry(rawLine: string): EventLogEntry | undefined {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { seq?: unknown }).seq !== 'number' ||
    !Number.isInteger((value as { seq: number }).seq) ||
    typeof (value as { event?: unknown }).event !== 'object' ||
    (value as { event: unknown }).event === null
  ) {
    return undefined;
  }
  const { seq, event } = value as { seq: number; event: AgentStreamEvent };
  return { seq, event };
}
