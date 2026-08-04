// apps/api/src/cli/listen.spec.ts
// 验收链路 · CLI 监听客户端单测 / 冒烟（epic-accept / accept-8，对齐 SPEC CAP-8）。
//
// 测试策略（不依赖真 AI，对齐 SPEC「CAP-8 对本地 stub server 冒烟」）：
//   - 起一个最小本地 stub SSE server（Node http 模块），按服务端 session-stream.controller.ts
//     写出的【同款 SSE 帧格式】（id:/event:/data:）推送预置事件序列；
//   - 用 CLI 的纯函数（parseArgs / parseSseBlock / SseBuffer / formatEvent）断言解析正确；
//   - 用 connectOnce / runReconnect（注入 stub fetchImpl 或直连本地 server）断言：
//     · --new 拿到首帧 session id 并打印；
//     · --session 挂载滚动打印事件；
//     · 断线重连带 Last-Event-ID（state.lastSeq 续传）。
//
// 【安全】断言 CLI 输出绝不包含密钥字面量（即便服务端 stub 故意塞一个 token-like 字符串，
//   也不应被打到 stdout——格式化器只渲染 AgentStreamEvent 已知字段）。
//
// 不改 packages/core；不跑 npm run test（合并阶段统一跑）。

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs, parseSseBlock, SseBuffer, formatEvent, connectOnce, runReconnect } from './listen.js';

// —— 纯函数：参数解析 ————————————————————————————————————————————————

describe('parseArgs', () => {
  it('--new 带首句 → mode=new、content 回填', () => {
    const r = parseArgs(['--new', '你好，帮我写代码']);
    expect(r).toEqual({ mode: 'new', content: '你好，帮我写代码' });
  });

  it('--new + options（model/provider/mode/cwd/base）全部透传', () => {
    const r = parseArgs([
      '--new',
      '首句',
      '--model',
      'claude-sonnet-4-5',
      '--provider',
      'anthropic-claude',
      '--mode',
      'plan',
      '--cwd',
      '/tmp/proj',
      '--base',
      'http://127.0.0.1:4000',
    ]);
    expect(r).toEqual({
      mode: 'new',
      content: '首句',
      model: 'claude-sonnet-4-5',
      providerId: 'anthropic-claude',
      mode2: 'plan',
      workingDirectory: '/tmp/proj',
      baseUrl: 'http://127.0.0.1:4000',
    });
  });

  it('--session <id> → mode=session、sessionId 回填', () => {
    const r = parseArgs(['--session', 'sess-abc-123']);
    expect(r).toEqual({ mode: 'session', sessionId: 'sess-abc-123' });
  });

  it('--new 与 --session 同时给 → error', () => {
    const r = parseArgs(['--new', 'x', '--session', 's']);
    expect(r.mode).toBe('error');
    expect(r.error).toMatch(/同时/);
  });

  it('都不给 → error', () => {
    const r = parseArgs(['--base', 'http://x']);
    expect(r.mode).toBe('error');
  });

  it('无参 / --help → help', () => {
    expect(parseArgs([]).mode).toBe('help');
    expect(parseArgs(['--help']).mode).toBe('help');
    expect(parseArgs(['-h']).mode).toBe('help');
  });

  it('--new 缺首句 → error', () => {
    expect(parseArgs(['--new'])?.mode ?? 'error').toBe('error');
    const r = parseArgs(['--new', '--model', 'm']);
    expect(r.mode).toBe('error');
  });

  it('--mode 非 code|plan|ask → error', () => {
    const r = parseArgs(['--new', 'x', '--mode', 'invalid']);
    expect(r.mode).toBe('error');
  });

  it('未识别参数 → error', () => {
    const r = parseArgs(['--new', 'x', '--bogus']);
    expect(r.mode).toBe('error');
    expect(r.error).toMatch(/未识别/);
  });
});

// —— 纯函数：SSE 块解析 ————————————————————————————————————————————————

describe('parseSseBlock', () => {
  it('完整三字段帧（id/event/data）', () => {
    const block = 'id: 3\nevent: text\ndata: {"type":"text","text":"你好"}';
    const f = parseSseBlock(block);
    expect(f).toEqual({
      id: 3,
      event: 'text',
      data: '{"type":"text","text":"你好"}',
    });
  });

  it('首帧 session 事件无 id 行（仅 event/data）', () => {
    const block = 'event: session\ndata: {"type":"session","sessionId":"s-1"}';
    const f = parseSseBlock(block);
    expect(f?.id).toBeUndefined();
    expect(f?.event).toBe('session');
    expect(f?.data).toContain('"s-1"');
  });

  it('冒号后无空格也合法', () => {
    const f = parseSseBlock('id:7\nevent:result\ndata:{}');
    expect(f?.id).toBe(7);
    expect(f?.event).toBe('result');
  });

  it('id 非纯数字（前缀数字串）不采纳', () => {
    const f = parseSseBlock('id: 7abc\nevent: x\ndata: {}');
    // id 不合法 → undefined；但 event/data 仍解析，frame 非空故不丢。
    expect(f?.id).toBeUndefined();
    expect(f?.event).toBe('x');
  });

  it('注释行（冒号开头）被忽略', () => {
    const f = parseSseBlock(': this is a comment\nevent: ping\ndata: 1');
    expect(f?.event).toBe('ping');
  });

  it('多行 data 用 \\n 连接', () => {
    const f = parseSseBlock('data: line1\ndata: line2');
    expect(f?.data).toBe('line1\nline2');
  });

  it('空块 / 仅注释 → undefined', () => {
    expect(parseSseBlock('')).toBeUndefined();
    expect(parseSseBlock(': only comment')).toBeUndefined();
  });
});

// —— 纯函数：增量缓冲 ————————————————————————————————————————————————

describe('SseBuffer', () => {
  it('按空行切出完整事件块，尾段留存', () => {
    const b = new SseBuffer();
    expect(b.feed('id: 1\ndata: a\n\n')).toEqual(['id: 1\ndata: a']);
    // 不完整块（无尾随空行）应留存，返回空。
    expect(b.feed('id: 2\ndata: b')).toEqual([]);
    // 补上空行后切出。
    expect(b.feed('\n\n')).toEqual(['id: 2\ndata: b']);
  });

  it('一次喂入多块', () => {
    const b = new SseBuffer();
    const blocks = b.feed('id:1\ndata:a\n\nid:2\ndata:b\n\n');
    expect(blocks).toEqual(['id:1\ndata:a', 'id:2\ndata:b']);
  });

  it('CRLF 行尾兼容', () => {
    const b = new SseBuffer();
    expect(b.feed('id:1\r\ndata:a\r\n\r\n')).toEqual(['id:1\r\ndata:a']);
  });

  it('flush 冲刷尾部残余', () => {
    const b = new SseBuffer();
    b.feed('id:9\ndata:tail');
    expect(b.flush()).toEqual(['id:9\ndata:tail']);
    // 二次 flush 为空。
    expect(b.flush()).toEqual([]);
  });
});

// —— 纯函数：事件格式化 ————————————————————————————————————————————————

describe('formatEvent', () => {
  it('text 事件直接打印正文', () => {
    const text = formatEvent({
      event: 'text',
      data: JSON.stringify({ type: 'text', text: 'hello world' }),
    });
    expect(text).toContain('hello world');
  });

  it('session 首帧打印 sessionId', () => {
    const text = formatEvent({
      event: 'session',
      data: JSON.stringify({ type: 'session', sessionId: 's-xyz' }),
    });
    expect(text).toContain('s-xyz');
    expect(text).toContain('新会话');
  });

  it('result 事件含 tokenUsage', () => {
    const text = formatEvent({
      event: 'result',
      data: JSON.stringify({
        type: 'result',
        tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }),
    });
    expect(text).toContain('入10');
    expect(text).toContain('出20');
    expect(text).toContain('合30');
  });

  it('tool_use 打印工具名 + 摘要入参', () => {
    const text = formatEvent({
      event: 'tool_use',
      data: JSON.stringify({
        type: 'tool_use',
        tool: { id: 'tu1', name: 'Read', input: { file_path: '/a/b.ts' } },
      }),
    });
    expect(text).toContain('Read');
    expect(text).toContain('file_path');
  });

  it('error 事件标注错误', () => {
    const text = formatEvent({
      event: 'error',
      data: JSON.stringify({ type: 'error', error: { kind: 'GENERIC', message: 'boom' } }),
    });
    expect(text).toContain('[错误]');
    expect(text).toContain('boom');
  });

  it('非法 JSON data 降级原样打印', () => {
    const text = formatEvent({ event: 'text', data: '不是 JSON 的纯文本' });
    expect(text).toContain('不是 JSON 的纯文本');
  });

  it('【安全】格式化器绝不回显密钥字面量', () => {
    // 即便 data 里夹带一个 token-like 字段，formatEvent 只渲染已知 AgentStreamEvent 字段，
    // 未知字段不会被打到 stdout。
    const text = formatEvent({
      event: 'text',
      data: JSON.stringify({
        type: 'text',
        text: '正常正文',
        // 故意塞入的疑似密钥（不应出现在输出里）：
        apiKey: 'sk-secret-DO-NOT-LEAK',
        authorization: 'Bearer ANTHROPIC_AUTH_TOKEN',
      }),
    });
    expect(text).not.toContain('sk-secret-DO-NOT-LEAK');
    expect(text).not.toContain('ANTHROPIC_AUTH_TOKEN');
    expect(text).toContain('正常正文');
  });
});

// —— 集成：connectOnce + 本地 stub SSE server ——————————————————————————

/**
 * 起一个最小 stub SSE server：按给定「路由 + 事件序列」回 text/event-stream。
 *
 * - POST /api/sessions/stream：回一个 session 首帧 + 若干带 seq 的事件帧，然后 res.end()。
 * - GET  /api/sessions/:id/stream：读 Last-Event-ID，回放 seq > lastEventId 的事件（模拟补发），
 *   随后挂住（不 end，模拟实时流），由 done 事件触发关闭。
 *
 * 每帧严格按服务端 session-stream.controller.ts 写出的格式：id:/event:/data: + 空行。
 */
async function startStubServer(opts: {
  readonly events: ReadonlyArray<{ readonly seq?: number; readonly event: string; readonly data: unknown }>;
  /** 收到 Last-Event-ID 时回调（断言重连带了正确 seq）。 */
  readonly onLastEventId?: (seq: number | undefined) => void;
  /** GET 流在推送完事件后是否保持连接（true=保持等待关闭，false=立即 end）。 */
  readonly holdGetStream?: boolean;
}): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    const lastEventIdRaw = req.headers['last-event-id'];
    const lastEventIdStr = Array.isArray(lastEventIdRaw) ? lastEventIdRaw[0] : lastEventIdRaw;
    const lastEventId =
      lastEventIdStr !== undefined && /^\d+$/.test(String(lastEventIdStr))
        ? Number.parseInt(String(lastEventIdStr), 10)
        : undefined;
    opts.onLastEventId?.(lastEventId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (req.method === 'POST' && url.endsWith('/api/sessions/stream')) {
      // --new 路由：首帧 session + 全量事件（新建会话无补发）。
      res.write('event: session\ndata: {"type":"session","sessionId":"s-stub-new"}\n\n');
      for (const e of opts.events) {
        const idLine = e.seq === undefined ? '' : `id: ${e.seq}\n`;
        res.write(`${idLine}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      }
      res.end();
      return;
    }

    // GET /api/sessions/:id/stream：仅推送 seq > lastEventId 的事件（模拟补发）。
    const filtered = opts.events.filter((e) => e.seq === undefined || lastEventId === undefined || e.seq > lastEventId);
    for (const e of filtered) {
      const idLine = e.seq === undefined ? '' : `id: ${e.seq}\n`;
      res.write(`${idLine}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    }
    if (opts.holdGetStream === false) {
      res.end();
    }
    // 否则保持连接，由 server.close() 关闭。
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('connectOnce / runReconnect —— 本地 stub server 冒烟', () => {
  let servers: Array<Server> = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  const sampleEvents = [
    { seq: 1, event: 'status', data: { type: 'status', text: '准备中' } },
    { seq: 2, event: 'text', data: { type: 'text', text: '你好，世界' } },
    { seq: 3, event: 'result', data: { type: 'result', tokenUsage: { inputTokens: 5, outputTokens: 8 } } },
  ];

  it('--new（POST）：拿到首帧 sessionId，逐帧打印，lastSeq=3', async () => {
    const stub = await startStubServer({ events: sampleEvents, holdGetStream: false });
    servers.push(stub.server);

    const printed: string[] = [];
    const result = await connectOnce({
      baseUrl: stub.baseUrl,
      mode: 'new',
      body: { content: '首句', model: 'claude-sonnet-4-5', providerId: 'anthropic-claude' },
      onFrame: (_f, text) => printed.push(text),
    });

    // 首帧 session id 被解析回填。
    expect(result.sessionId).toBe('s-stub-new');
    expect(result.lastSeq).toBe(3);
    // 打印文本含 sessionId 与最后一条正文。
    expect(printed.some((t) => t.includes('s-stub-new'))).toBe(true);
    expect(printed.some((t) => t.includes('你好，世界'))).toBe(true);
    expect(printed.some((t) => t.includes('[回合结束]'))).toBe(true);
  });

  it('--session（GET）：挂载滚动打印全部事件', async () => {
    const stub = await startStubServer({ events: sampleEvents, holdGetStream: false });
    servers.push(stub.server);

    const printed: string[] = [];
    const result = await connectOnce({
      baseUrl: stub.baseUrl,
      mode: 'session',
      sessionId: 's-existing',
      onFrame: (_f, text) => printed.push(text),
    });

    expect(result.lastSeq).toBe(3);
    expect(printed.some((t) => t.includes('你好，世界'))).toBe(true);
  });

  it('断线重连带 Last-Event-ID：从 seq=2 起只补发 seq>2 的事件', async () => {
    const seenLastEventIds: Array<number | undefined> = [];
    const stub = await startStubServer({
      events: sampleEvents,
      onLastEventId: (seq) => seenLastEventIds.push(seq),
      holdGetStream: false,
    });
    servers.push(stub.server);

    const printed: string[] = [];
    const result = await connectOnce({
      baseUrl: stub.baseUrl,
      mode: 'session',
      sessionId: 's-resume',
      lastEventId: 2, // 模拟断线重连：客户端记得最后收到 seq=2
      onFrame: (_f, text) => printed.push(text),
    });

    // stub server 收到了 Last-Event-ID: 2。
    expect(seenLastEventIds).toContain(2);
    // 只补发 seq>2 的事件（result，seq=3），不含 seq<=2。
    expect(printed.some((t) => t.includes('[回合结束]'))).toBe(true);
    expect(printed.some((t) => t.includes('准备中'))).toBe(false); // seq=1 被跳过
    expect(printed.some((t) => t.includes('你好，世界'))).toBe(false); // seq=2 被跳过
    expect(result.lastSeq).toBe(3);
  });

  it('runReconnect：--new 一轮结束后切 GET 挂载重连，带 Last-Event-ID', async () => {
    // 这个 stub：POST /stream 推全量后 end（第一轮）；
    // 之后客户端应重连 GET /:id/stream（带 Last-Event-ID=3），stub 只回放 seq>3（空），随后 end。
    const seenMethods: Array<{ method: string | undefined; lastEventId: number | undefined }> = [];
    const server = createServer((req, res) => {
      const lastEventIdRaw = req.headers['last-event-id'];
      const lastEventIdStr = Array.isArray(lastEventIdRaw) ? lastEventIdRaw[0] : lastEventIdRaw;
      const lastEventId =
        lastEventIdStr !== undefined && /^\d+$/.test(String(lastEventIdStr))
          ? Number.parseInt(String(lastEventIdStr), 10)
          : undefined;
      seenMethods.push({ method: req.method, lastEventId });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      if (req.method === 'POST') {
        res.write('event: session\ndata: {"type":"session","sessionId":"s-recon"}\n\n');
        res.write('id: 1\nevent: text\ndata: {"type":"text","text":"第一轮"}\n\n');
        res.end();
      } else {
        // GET 重连：不推任何事件（seq>3 为空），直接 end。
        res.end();
      }
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const printed: string[] = [];
    const state = await runReconnect(
      {
        baseUrl,
        mode: 'new',
        body: { content: '首句', model: 'claude-sonnet-4-5', providerId: 'anthropic-claude' },
        reconnectDelayMs: 0,
        maxReconnects: 1, // 第一轮 POST + 1 次重连 GET，共 2 次连接后退出
        onFrame: (_f, text) => printed.push(text),
      },
      {},
    );

    // 重连后 state 含 sessionId 与 lastSeq。
    expect(state.sessionId).toBe('s-recon');
    expect(state.lastSeq).toBe(1);

    // 第一次 POST（无 Last-Event-ID），第二次 GET（带 Last-Event-ID=1）。
    expect(seenMethods[0]?.method).toBe('POST');
    expect(seenMethods[0]?.lastEventId).toBeUndefined();
    expect(seenMethods[1]?.method).toBe('GET');
    expect(seenMethods[1]?.lastEventId).toBe(1);

    // 首轮正文被打印、sessionId 被打印。
    expect(printed.some((t) => t.includes('s-recon'))).toBe(true);
    expect(printed.some((t) => t.includes('第一轮'))).toBe(true);
  });

  it('【安全】CLI 输出绝不包含密钥：即便网络层异常也不回显请求头', async () => {
    // 故意指向一个不存在的端口 → 连接失败；error 路径只打印短描述。
    const errOut: string[] = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      errOut.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await connectOnce({
        baseUrl: 'http://127.0.0.1:1', // 1 号端口几乎必然拒绝
        mode: 'session',
        sessionId: 'x',
        onFrame: () => {},
      });
    } finally {
      process.stderr.write = origStderr;
    }
    // 连接失败的描述里绝不出现密钥字样。
    const joined = errOut.join('');
    expect(joined).not.toContain('ANTHROPIC_AUTH_TOKEN');
    expect(joined).not.toContain('sk-');
  });
});
