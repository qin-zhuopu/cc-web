// conversation/usecases/manage-session.ts
// C1 会话生命周期用例服务：ManageSessionService implements ManageSessionUseCase。
// 对齐 architecture §6（编排规则）/§7（依赖注入）。核心零框架依赖、纯逻辑：
// 不 new 具体实现、不直读系统时钟、不自造 id，一律经注入端口获取。

import type {
  ChatSession,
  SessionId,
} from '../domain/session/chat-session.js';
// 三枚举以「值」使用（落默认 status/mode/source），故为正常 import 而非 import type。
import {
  SessionMode,
  SessionSource,
  SessionStatus,
} from '../domain/session/chat-session.js';
import type { TitleOrigin } from '../domain/session/title-origin.js';
// C1_MESSAGE_KEYS 为运行时常量（缺省标题 key），值 import。
import { C1_MESSAGE_KEYS } from '../domain/message-keys.js';
import type {
  CreateSessionInput,
  ListSessionsQuery,
  ManageSessionUseCase,
} from '../ports/driving/manage-session-usecase.js';
import type { SessionRepository } from '../ports/driven/session-repository.js';
import type { MessageRepository } from '../ports/driven/message-repository.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';

/**
 * ManageSessionService：会话生命周期用例实现（纯应用编排）。
 *
 * 依赖注入（architecture §7）：SessionRepository / MessageRepository / Clock / IdGenerator，
 * 全经构造函数注入，服务本身不感知任何具体适配器（SQLite / uuid / 系统时钟）。
 */
export class ManageSessionService implements ManageSessionUseCase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * 创建会话（architecture §6）：
   * - id ← IdGenerator.next()；now ← Clock.now()，createdAt = updatedAt = now。
   * - title 缺省 → 默认标题 key（C1_MESSAGE_KEYS.sessionDefaultTitle），titleOrigin='default'；
   *   显式给 title → 采用给定文案，titleOrigin='user'（用户意图，防被 ai 覆盖）。
   * - mode 缺省 code；source 缺省 user；status 恒 active。
   * - workingDirectory / projectName 由用例落默认（input 无值保持 undefined，此处兜底）。
   */
  async create(input: CreateSessionInput): Promise<ChatSession> {
    const id: SessionId = this.ids.next();
    const now: number = this.clock.now();

    const hasTitle = input.title !== undefined;
    const title = hasTitle ? input.title! : C1_MESSAGE_KEYS.sessionDefaultTitle;
    const titleOrigin: TitleOrigin = hasTitle ? 'user' : 'default';

    const session: ChatSession = {
      id,
      title,
      titleOrigin,
      status: SessionStatus.ACTIVE,
      mode: input.mode ?? SessionMode.CODE,
      source: input.source ?? SessionSource.USER,
      workingDirectory: input.workingDirectory ?? '',
      projectName: input.projectName ?? '',
      createdAt: now,
      updatedAt: now,
    };

    await this.sessions.save(session);
    return session;
  }

  /** 按 id 取会话；委托 SessionRepository，不存在返回 undefined（对齐接口签名）。 */
  async getById(id: SessionId): Promise<ChatSession | undefined> {
    return this.sessions.getById(id);
  }

  /**
   * 列表（architecture §6 / FR-1.6）：
   * - 【过滤/排序/limit 的唯一权威在用例层】——从仓储只取全量本体（listAll() 不传 query），
   *   由用例做来源过滤、状态过滤、updatedAt 倒序、limit 截取。避免与适配器双重过滤/排序
   *   导致的 top-N 丢数据（适配器不得自行 limit）。SessionRepository.listAll 契约据此声明。
   * - 来源过滤：query.sources 显式给定则仅保留其中来源；缺省 → 仅 user（过滤掉 source='task'）。
   * - 状态过滤：query.status 给定则仅保留该状态；缺省不限。
   * - 排序：按 updatedAt 倒序（最近更新的会话置顶）。
   * - 条数：query.limit 给定则截取前 limit 条（排序后）。
   */
  async list(query?: ListSessionsQuery): Promise<ReadonlyArray<ChatSession>> {
    const all = await this.sessions.listAll();

    // 来源白名单：显式给定用之，否则默认仅 user（FR-1.6 过滤 task 源）。
    const allowedSources: ReadonlyArray<SessionSource> =
      query?.sources ?? [SessionSource.USER];

    const filtered = all.filter((s) => {
      if (!allowedSources.includes(s.source)) return false;
      if (query?.status !== undefined && s.status !== query.status) return false;
      return true;
    });

    // 按 updatedAt 倒序（不原地改传入数组）。
    const sorted = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);

    return query?.limit !== undefined ? sorted.slice(0, query.limit) : sorted;
  }

  rename(_id: SessionId, _title: string): Promise<ChatSession> {
    throw new Error('ManageSessionService.rename 未实现（属后续故事）。');
  }

  /**
   * 归档（architecture §4.1/§6）：仅 status→archived。
   * 不 touch updatedAt——归档是状态变更、非「活动」，不应把会话顶到列表最前
   * （updatedAt 倒序语义只反映真实活动）。
   */
  async archive(id: SessionId): Promise<void> {
    await this.sessions.setStatus(id, SessionStatus.ARCHIVED);
  }

  /**
   * 取消归档（architecture §4.1/§6）：仅 status→active。同样不 touch updatedAt。
   */
  async unarchive(id: SessionId): Promise<void> {
    await this.sessions.setStatus(id, SessionStatus.ACTIVE);
  }

  /** 仅更新 updatedAt=Clock.now()（追加消息后把会话顶前）。 */
  async touch(id: SessionId): Promise<void> {
    await this.sessions.touch(id, this.clock.now());
  }

  /**
   * 删除会话（architecture §6 / NFR-7 一致性）：
   * - 先经 MessageRepository.deleteBySession 级联删该会话所有消息，再删会话本体，
   *   保证不留孤儿消息（对齐 ON DELETE CASCADE 语义）。
   * - 删不存在的会话为幂等无害操作：两侧仓储对缺失键均按无操作处理（不抛）。
   */
  async delete(id: SessionId): Promise<void> {
    await this.messages.deleteBySession(id);
    await this.sessions.delete(id);
  }
}
