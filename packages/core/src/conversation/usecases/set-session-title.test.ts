// conversation/usecases/set-session-title.test.ts
// C1 会话标题设置用例 setByUser 的单元测试（vitest）。
// 全用内存假替身 + 冻结时钟，断言用户手改恒生效：写入 title 且 titleOrigin='user'，
// 且从 'ai' / 'default' 态都能改成 user（user 覆盖恒放行）。
// generateByAi / 降级属后续故事，本文件不覆盖。

import { describe, it, expect, beforeEach } from 'vitest';
import { SetSessionTitleService } from './set-session-title.js';
import type {
  ChatSession,
  SessionId,
} from '../domain/session/chat-session.js';
import { SessionMode, SessionSource, SessionStatus } from '../domain/session/chat-session.js';
import type { TitleOrigin } from '../domain/session/title-origin.js';
import type { SessionStatus as SessionStatusType } from '../domain/session/chat-session.js';
import type { SessionRepository } from '../ports/driven/session-repository.js';
import type {
  TitleGeneratorPort,
  TitleGenerationInput,
} from '../ports/driven/title-generator-port.js';
import type {
  GetSessionHistoryUseCase,
  HistoryQuery,
} from '../ports/driving/get-session-history-usecase.js';
import type { Message } from '../domain/message/message.js';
import { textContent } from '../domain/message/message-content.js';
import type { LogEntry } from '../../domain/log/log-entry.js';
import type { RuntimeLog } from '../../ports/runtime-log.js';
import type { Clock } from '../../ports/clock.js';

// —— 假替身 ——

/** 内存会话仓储：Map 存储，记录 setTitle 调用参数供断言。 */
class FakeSessionRepository implements SessionRepository {
  readonly store = new Map<SessionId, ChatSession>();
  readonly setTitleCalls: Array<{
    id: SessionId;
    title: string;
    origin: TitleOrigin;
  }> = [];

  async listAll(): Promise<ReadonlyArray<ChatSession>> {
    return [...this.store.values()];
  }
  async getById(id: SessionId): Promise<ChatSession | undefined> {
    return this.store.get(id);
  }
  async save(session: ChatSession): Promise<void> {
    this.store.set(session.id, session);
  }
  async touch(id: SessionId, updatedAt: number): Promise<void> {
    const cur = this.store.get(id);
    if (cur) this.store.set(id, { ...cur, updatedAt });
  }
  async setTitle(
    id: SessionId,
    title: string,
    origin: TitleOrigin,
  ): Promise<void> {
    this.setTitleCalls.push({ id, title, origin });
    const cur = this.store.get(id);
    if (cur) this.store.set(id, { ...cur, title, titleOrigin: origin });
  }
  async setStatus(id: SessionId, status: SessionStatusType): Promise<void> {
    const cur = this.store.get(id);
    if (cur) this.store.set(id, { ...cur, status });
  }
  async delete(id: SessionId): Promise<void> {
    this.store.delete(id);
  }
}

/**
 * 假 TitleGenerator：可注入成功标题 / 抛错 / 超时（永挂）。
 * 记录调用次数，供断言 setByUser 全程不触碰生成端口。
 */
class FakeTitleGenerator implements TitleGeneratorPort {
  calls = 0;
  constructor(
    private readonly behavior:
      | { kind: 'ok'; title: string }
      | { kind: 'throw'; error: Error }
      | { kind: 'hang' } = { kind: 'ok', title: 'AI 标题' },
  ) {}
  async generateTitle(_input: TitleGenerationInput): Promise<string> {
    this.calls += 1;
    if (this.behavior.kind === 'throw') throw this.behavior.error;
    if (this.behavior.kind === 'hang') return new Promise<string>(() => {});
    return this.behavior.title;
  }
}

/** 假历史用例：返回预置 prompt 视图；记录调用供断言。 */
class FakeGetSessionHistory implements GetSessionHistoryUseCase {
  promptViewCalls = 0;
  constructor(private readonly promptMessages: ReadonlyArray<Message> = []) {}
  async getHistory(_query: HistoryQuery): Promise<ReadonlyArray<Message>> {
    return this.promptMessages;
  }
  async getPromptView(_query: HistoryQuery): Promise<ReadonlyArray<Message>> {
    this.promptViewCalls += 1;
    return this.promptMessages;
  }
}

/** 记录调用的假 RuntimeLog（本故事不触发降级日志，仅满足契约）。 */
class FakeRuntimeLog implements RuntimeLog {
  readonly entries: Array<Omit<LogEntry, 'timestamp'>> = [];
  readonly capacity = 100;
  append(entry: Omit<LogEntry, 'timestamp'>): void {
    this.entries.push(entry);
  }
  snapshot(): ReadonlyArray<LogEntry> {
    return [];
  }
  clear(): void {
    this.entries.length = 0;
  }
}

/** 冻结时钟：now 恒返回注入的固定时刻。 */
class FrozenClock implements Clock {
  constructor(private readonly fixed: number) {}
  now(): number {
    return this.fixed;
  }
}

// —— 测试 ——

describe('SetSessionTitleService.setByUser', () => {
  let sessions: FakeSessionRepository;
  let history: FakeGetSessionHistory;
  let titleGen: FakeTitleGenerator;
  let runtimeLog: FakeRuntimeLog;
  let service: SetSessionTitleService;

  // 预置一条会话，可覆盖 title/titleOrigin 以验证不同起始态。
  function seed(over: Partial<ChatSession> & Pick<ChatSession, 'id'>): void {
    const full: ChatSession = {
      title: '原标题',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '',
      projectName: '',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    };
    sessions.store.set(full.id, full);
  }

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    history = new FakeGetSessionHistory();
    titleGen = new FakeTitleGenerator();
    runtimeLog = new FakeRuntimeLog();
    service = new SetSessionTitleService(
      sessions,
      history,
      titleGen,
      new FrozenClock(1),
      runtimeLog,
    );
  });

  it('写入新标题并标 titleOrigin=user', async () => {
    seed({ id: 's1', title: '原标题', titleOrigin: 'default' });
    const s = await service.setByUser('s1', '我的新标题');
    expect(s.title).toBe('我的新标题');
    expect(s.titleOrigin).toBe('user');
    // 落库亦为 user 态。
    const stored = sessions.store.get('s1')!;
    expect(stored.title).toBe('我的新标题');
    expect(stored.titleOrigin).toBe('user');
  });

  it('经 SessionRepository.setTitle 写入 origin=user', async () => {
    seed({ id: 's1' });
    await service.setByUser('s1', '标题A');
    expect(sessions.setTitleCalls).toEqual([
      { id: 's1', title: '标题A', origin: 'user' },
    ]);
  });

  it('从 default 态可改成 user', async () => {
    seed({ id: 's1', titleOrigin: 'default' });
    const s = await service.setByUser('s1', 'X');
    expect(s.titleOrigin).toBe('user');
  });

  it('从 ai 态可改成 user（用户手改覆盖 AI 标题）', async () => {
    seed({ id: 's1', title: 'AI 起的标题', titleOrigin: 'ai' });
    const s = await service.setByUser('s1', '用户改的标题');
    expect(s.title).toBe('用户改的标题');
    expect(s.titleOrigin).toBe('user');
  });

  it('从 user 态仍可再次改名（user 覆盖 user）', async () => {
    seed({ id: 's1', title: '旧用户标题', titleOrigin: 'user' });
    const s = await service.setByUser('s1', '新用户标题');
    expect(s.title).toBe('新用户标题');
    expect(s.titleOrigin).toBe('user');
  });

  it('setByUser 全程不触碰 TitleGenerator 与历史投影', async () => {
    seed({ id: 's1' });
    await service.setByUser('s1', 'X');
    expect(titleGen.calls).toBe(0);
    expect(history.promptViewCalls).toBe(0);
  });

  it('setByUser 不写降级日志', async () => {
    seed({ id: 's1' });
    await service.setByUser('s1', 'X');
    expect(runtimeLog.entries).toHaveLength(0);
  });

  it('仅改 title/titleOrigin，其余字段恒等', async () => {
    seed({ id: 's1', title: '原标题', titleOrigin: 'default' });
    const before = sessions.store.get('s1')!;
    const after = await service.setByUser('s1', '新标题');
    expect({ ...after, title: '', titleOrigin: 'default' as TitleOrigin }).toEqual({
      ...before,
      title: '',
      titleOrigin: 'default' as TitleOrigin,
    });
  });

  it('会话不存在时抛错（返回类型非可选，不伪造本体）', async () => {
    await expect(service.setByUser('missing', 'X')).rejects.toThrow();
    expect(sessions.setTitleCalls).toHaveLength(0);
  });
});

describe('SetSessionTitleService.generateByAi', () => {
  let sessions: FakeSessionRepository;
  let history: FakeGetSessionHistory;
  let titleGen: FakeTitleGenerator;
  let runtimeLog: FakeRuntimeLog;

  // 预置一条会话，可覆盖 title/titleOrigin 以验证不同起始态。
  function seed(over: Partial<ChatSession> & Pick<ChatSession, 'id'>): void {
    const full: ChatSession = {
      title: '原标题',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '',
      projectName: '',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    };
    sessions.store.set(full.id, full);
  }

  // 组装注入指定 TitleGenerator / 历史的 service。
  function build(
    gen: FakeTitleGenerator,
    hist: FakeGetSessionHistory = new FakeGetSessionHistory(),
  ): SetSessionTitleService {
    sessions = sessions ?? new FakeSessionRepository();
    history = hist;
    titleGen = gen;
    return new SetSessionTitleService(
      sessions,
      history,
      titleGen,
      new FrozenClock(1),
      runtimeLog,
    );
  }

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    history = new FakeGetSessionHistory();
    titleGen = new FakeTitleGenerator();
    runtimeLog = new FakeRuntimeLog();
  });

  it('default 态会话 generateByAi 后 title 更新、origin=ai', async () => {
    seed({ id: 's1', title: '原标题', titleOrigin: 'default' });
    const service = build(new FakeTitleGenerator({ kind: 'ok', title: 'AI 生成标题' }));
    const s = await service.generateByAi('s1');
    expect(s.title).toBe('AI 生成标题');
    expect(s.titleOrigin).toBe('ai');
    // 落库亦为 ai 态。
    const stored = sessions.store.get('s1')!;
    expect(stored.title).toBe('AI 生成标题');
    expect(stored.titleOrigin).toBe('ai');
    // 经 setTitle 以 origin=ai 写入。
    expect(sessions.setTitleCalls).toEqual([
      { id: 's1', title: 'AI 生成标题', origin: 'ai' },
    ]);
  });

  it('ai 态会话 generateByAi 后 title 更新、origin 仍 ai（ai 覆盖 ai）', async () => {
    seed({ id: 's1', title: '旧 AI 标题', titleOrigin: 'ai' });
    const service = build(new FakeTitleGenerator({ kind: 'ok', title: '新 AI 标题' }));
    const s = await service.generateByAi('s1');
    expect(s.title).toBe('新 AI 标题');
    expect(s.titleOrigin).toBe('ai');
    const stored = sessions.store.get('s1')!;
    expect(stored.title).toBe('新 AI 标题');
    expect(stored.titleOrigin).toBe('ai');
  });

  it('user 态会话 generateByAi 保持原标题、origin 仍 user，且 TitleGenerator 未被调用', async () => {
    seed({ id: 's1', title: '用户手改标题', titleOrigin: 'user' });
    const gen = new FakeTitleGenerator({ kind: 'ok', title: '不该出现的标题' });
    const service = build(gen);
    const s = await service.generateByAi('s1');
    expect(s.title).toBe('用户手改标题');
    expect(s.titleOrigin).toBe('user');
    // user 态早退：连历史投影与 TitleGenerator 都不触碰，也不写库。
    expect(gen.calls).toBe(0);
    expect(history.promptViewCalls).toBe(0);
    expect(sessions.setTitleCalls).toHaveLength(0);
    // 落库仍为原 user 态。
    const stored = sessions.store.get('s1')!;
    expect(stored.title).toBe('用户手改标题');
    expect(stored.titleOrigin).toBe('user');
  });

  it('生成成功前经 getPromptView 投影出 recentMessages 纯文本喂端口', async () => {
    seed({ id: 's1', titleOrigin: 'default' });
    const hist = new FakeGetSessionHistory([
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: textContent('帮我写个排序'),
        createdAt: 1,
        streamStatus: 'completed',
        isHeartbeatAck: false,
      },
    ]);
    let received: TitleGenerationInput | undefined;
    const gen = new FakeTitleGenerator({ kind: 'ok', title: 'T' });
    const spyGen: TitleGeneratorPort = {
      async generateTitle(input: TitleGenerationInput): Promise<string> {
        received = input;
        return gen.generateTitle(input);
      },
    };
    const service = new SetSessionTitleService(
      sessions,
      hist,
      spyGen,
      new FrozenClock(1),
      runtimeLog,
    );
    await service.generateByAi('s1');
    expect(hist.promptViewCalls).toBe(1);
    expect(received).toEqual({
      sessionId: 's1',
      recentMessages: [{ role: 'user', text: '帮我写个排序' }],
    });
  });

  it('会话不存在时抛错，且不触碰 TitleGenerator', async () => {
    const gen = new FakeTitleGenerator({ kind: 'ok', title: 'X' });
    const service = build(gen);
    await expect(service.generateByAi('missing')).rejects.toThrow();
    expect(gen.calls).toBe(0);
    expect(sessions.setTitleCalls).toHaveLength(0);
  });

  it('TitleGenerator 抛错时降级：不外抛、返回原会话、title/origin 不变', async () => {
    seed({ id: 's1', title: '原标题', titleOrigin: 'default' });
    const gen = new FakeTitleGenerator({
      kind: 'throw',
      error: new Error('模拟生成超时/网络失败'),
    });
    const service = build(gen);
    // 不外抛。
    const s = await service.generateByAi('s1');
    // 返回原会话：title/origin 不变。
    expect(s.title).toBe('原标题');
    expect(s.titleOrigin).toBe('default');
    // 端口确被调用（走到生成后失败），但绝不写库（反假数据：不写脏标题）。
    expect(gen.calls).toBe(1);
    expect(sessions.setTitleCalls).toHaveLength(0);
    // 落库仍为原态，无空/错误标题串。
    const stored = sessions.store.get('s1')!;
    expect(stored.title).toBe('原标题');
    expect(stored.titleOrigin).toBe('default');
  });

  it('降级时 RuntimeLog 收到一条 warn（source=c1.title）', async () => {
    seed({ id: 's1', title: '原标题', titleOrigin: 'ai' });
    const gen = new FakeTitleGenerator({
      kind: 'throw',
      error: new Error('boom'),
    });
    const service = build(gen);
    await service.generateByAi('s1');
    expect(runtimeLog.entries).toHaveLength(1);
    const entry = runtimeLog.entries[0]!;
    expect(entry.level).toBe('warn');
    expect(entry.source).toBe('c1.title');
    expect(typeof entry.message).toBe('string');
    // 原标题（ai 态）保持不变，不被写脏。
    const stored = sessions.store.get('s1')!;
    expect(stored.title).toBe('原标题');
    expect(stored.titleOrigin).toBe('ai');
    expect(sessions.setTitleCalls).toHaveLength(0);
  });

  it.each([
    { name: '空串', title: '' },
    { name: '纯空白', title: '   ' },
  ])('TitleGenerator 返回$name标题时守卫降级：不写脏空标题、保留原标题、记 warn', async ({ title }) => {
    seed({ id: 's1', title: '原标题', titleOrigin: 'default' });
    const gen = new FakeTitleGenerator({ kind: 'ok', title });
    const service = build(gen);
    const s = await service.generateByAi('s1');
    // 反假数据：即便端口「成功」返回空标题，也不得写入。
    expect(s.title).toBe('原标题');
    expect(s.titleOrigin).toBe('default');
    expect(sessions.setTitleCalls).toHaveLength(0);
    const stored = sessions.store.get('s1')!;
    expect(stored.title).toBe('原标题');
    expect(runtimeLog.entries.some((e) => e.level === 'warn' && e.source === 'c1.title')).toBe(true);
  });
});

// —— c1-4-4：边界纪律守门测试（反例断言）——
//
// 目的：证明 C1 绝不自己拼 AI 标题提示词，只把 getPromptView 投影出的 recentMessages
// 纯文本片段交给 TitleGeneratorPort。这是「生成能力锁在 C2」的守门测试：
//   - 正向：传给 generateTitle 的 input 就是投影结构（sessionId + recentMessages 纯文本），
//     与端口契约 TitleGenerationInput 逐字段一致；
//   - 反例：input 里不出现任何 C2 概念——提示词模板串 / system prompt / 模型名 / 采样参数
//     （temperature/maxTokens 等），也不把消息拼成单一 prompt 字符串；
//   - 源码纪律：SetSessionTitleService 源文件不 import 任何 C2 实现，也不 import
//     @anthropic-ai/*（门禁守卫 c1-1-7 在构建层保证 0 命中，此处补一条运行时断言复述该纪律）。
describe('SetSessionTitleService.generateByAi —— C1 不拼 prompt（边界纪律）', () => {
  let sessions: FakeSessionRepository;
  let runtimeLog: FakeRuntimeLog;

  function seed(over: Partial<ChatSession> & Pick<ChatSession, 'id'>): void {
    const full: ChatSession = {
      title: '原标题',
      titleOrigin: 'default' as TitleOrigin,
      status: SessionStatus.ACTIVE,
      mode: SessionMode.CODE,
      source: SessionSource.USER,
      workingDirectory: '',
      projectName: '',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    };
    sessions.store.set(full.id, full);
  }

  beforeEach(() => {
    sessions = new FakeSessionRepository();
    runtimeLog = new FakeRuntimeLog();
  });

  // 记录入参的 TitleGenerator：捕获 C1 传入的 input 全貌供反例断言。
  function buildWithCapture(hist: FakeGetSessionHistory): {
    service: SetSessionTitleService;
    captured: () => TitleGenerationInput | undefined;
  } {
    let received: TitleGenerationInput | undefined;
    const capturingGen: TitleGeneratorPort = {
      async generateTitle(input: TitleGenerationInput): Promise<string> {
        received = input;
        return 'T';
      },
    };
    const service = new SetSessionTitleService(
      sessions,
      hist,
      capturingGen,
      new FrozenClock(1),
      runtimeLog,
    );
    return { service, captured: () => received };
  }

  it('传给 TitleGeneratorPort.generateTitle 的入参就是投影结构，而非拼好的 prompt', async () => {
    seed({ id: 's1', titleOrigin: 'default' });
    const hist = new FakeGetSessionHistory([
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: textContent('帮我写个快排'),
        createdAt: 1,
        streamStatus: 'completed',
        isHeartbeatAck: false,
      },
      {
        id: 'm2',
        sessionId: 's1',
        role: 'assistant',
        content: textContent('好的，这是快排实现'),
        createdAt: 2,
        streamStatus: 'completed',
        isHeartbeatAck: false,
      },
    ]);
    const { service, captured } = buildWithCapture(hist);
    await service.generateByAi('s1');

    const input = captured();
    expect(input).toBeDefined();

    // 1) 结构正向：input 逐字段 === 端口契约 TitleGenerationInput（sessionId + recentMessages）。
    expect(input).toEqual({
      sessionId: 's1',
      recentMessages: [
        { role: 'user', text: '帮我写个快排' },
        { role: 'assistant', text: '好的，这是快排实现' },
      ],
    });

    // 2) input 不是字符串（C1 若拼 prompt 才会传单一字符串）。
    expect(typeof input).toBe('object');
    expect(typeof input).not.toBe('string');

    // 3) 键集合恰为 { sessionId, recentMessages }——无任何多余的 C2 概念键。
    expect(Object.keys(input as object).sort()).toEqual(
      ['recentMessages', 'sessionId'].sort(),
    );

    // 4) recentMessages 每条恰为 { role, text } 纯文本投影——不含富内容块、无模板装饰。
    for (const m of input!.recentMessages) {
      expect(Object.keys(m).sort()).toEqual(['role', 'text'].sort());
      expect(typeof m.text).toBe('string');
      expect(['user', 'assistant']).toContain(m.role);
    }
  });

  it('反例：input 不含任何 C2 概念（模板 / system prompt / 模型名 / 采样参数）', async () => {
    seed({ id: 's1', titleOrigin: 'default' });
    const hist = new FakeGetSessionHistory([
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: textContent('随便一句话'),
        createdAt: 1,
        streamStatus: 'completed',
        isHeartbeatAck: false,
      },
    ]);
    const { service, captured } = buildWithCapture(hist);
    await service.generateByAi('s1');

    const input = captured()!;
    // 把整个入参序列化，任何 C2 概念一旦被 C1 拼进去都会现形。
    const serialized = JSON.stringify(input);
    const c2Concepts = [
      'system',
      'prompt',
      'temperature',
      'maxTokens',
      'max_tokens',
      'model',
      'claude',
      'anthropic',
      'template',
      '请', // 常见提示词祈使前缀（如「请为以下对话生成标题」）
      '生成一个标题',
      '总结',
    ];
    for (const concept of c2Concepts) {
      expect(serialized.toLowerCase()).not.toContain(concept.toLowerCase());
    }

    // recentMessages[].text 只承载会话原文，不被 C1 包裹成指令句。
    expect(input.recentMessages[0]!.text).toBe('随便一句话');
  });

  it('源码纪律：SetSessionTitleService 不 import C2 实现或 @anthropic-ai（复述门禁 c1-1-7 守卫）', async () => {
    // 门禁守卫 c1-1-7 在构建层保证核心包对 @anthropic-ai/* 与 C2 实现 0 命中；
    // 此处读源文件补一条运行时断言，把该纪律固化进本用例的测试证据里。
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const src = await fs.readFile(
      url.fileURLToPath(new URL('./set-session-title.ts', import.meta.url)),
      'utf8',
    );
    // 剔除注释后再检查，避免文档里出现的示意词误伤（注释里本就写着「绝不 import @anthropic-ai」）。
    const codeOnly = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    // 不 import 任何 @anthropic-ai 包。
    expect(codeOnly).not.toMatch(/@anthropic-ai/);
    // 不 import C2（agent-runtime）的任何实现路径。
    expect(codeOnly).not.toMatch(/agent-runtime/);
    // 对 TitleGenerator 只经端口 import type 消费（值 import 会引入实现依赖）。
    expect(codeOnly).toMatch(
      /import type[\s\S]*TitleGeneratorPort[\s\S]*from '\.\.\/ports\/driven\/title-generator-port\.js'/,
    );
  });
});
