// conversation/ports/driving/manage-session-usecase.ts
// C1 驱动端口：会话生命周期用例入口（用例入口契约，仅签名骨架）。
// 对齐 architecture §4.1。零框架 import，纯类型接口；实现属 c1-3。

import type {
  ChatSession,
  SessionId,
  SessionMode,
  SessionSource,
  SessionStatus,
} from '../../domain/session/chat-session.js';

/**
 * 创建会话入参。全部字段可选，缺省语义由用例填充：
 * - title 缺省 → 默认标题（key: c1.session.defaultTitle），titleOrigin=default。
 * - mode 缺省 → code；source 缺省 → user。
 * 【反假数据】可选字段无值时保持 undefined，用例自行落默认，绝不预填假空串。
 */
export interface CreateSessionInput {
  /** 标题文案。缺省用默认标题 key，origin=default。 */
  readonly title?: string;
  /** 会话模式。缺省 code。 */
  readonly mode?: SessionMode;
  /** 会话来源。缺省 user。 */
  readonly source?: SessionSource;
  /** 归属工作目录。 */
  readonly workingDirectory?: string;
  /** 工作目录对应项目名。 */
  readonly projectName?: string;
}

/**
 * 会话列表查询条件。
 * 默认过滤 source='task'（FR-1.6），常用只看 active。
 */
export interface ListSessionsQuery {
  /** 允许的来源集合。缺省 [user]（过滤 task）。 */
  readonly sources?: ReadonlyArray<SessionSource>;
  /** 状态过滤。缺省不限；常用 active。 */
  readonly status?: SessionStatus;
  /** 返回条数上限。 */
  readonly limit?: number;
}

/**
 * ManageSessionUseCase：会话生命周期驱动端口（对外提供）。
 *
 * 仅签名骨架，无实现体——用例逻辑落地属 c1-3。
 * 时间戳（createdAt/updatedAt）为 epoch 毫秒，来自 SK.Clock，与 ChatSession 对齐。
 */
export interface ManageSessionUseCase {
  /** 创建会话：id←IdGenerator、now←Clock，缺省标题走默认 key。 */
  create(input: CreateSessionInput): Promise<ChatSession>;
  /** 按 id 取会话；不存在返回 undefined（不抛）。 */
  getById(id: SessionId): Promise<ChatSession | undefined>;
  /** 列表：按 updatedAt 倒序；默认过滤 source='task'（FR-1.6）。 */
  list(query?: ListSessionsQuery): Promise<ReadonlyArray<ChatSession>>;
  /** 重命名：走 SetSessionTitleUseCase(user)，标 titleOrigin='user'。 */
  rename(id: SessionId, title: string): Promise<ChatSession>;
  /** 归档：status→archived。 */
  archive(id: SessionId): Promise<void>;
  /** 取消归档：status→active。 */
  unarchive(id: SessionId): Promise<void>;
  /** 仅更新 updatedAt（追加消息后把会话顶前）。 */
  touch(id: SessionId): Promise<void>;
  /** 删除会话：级联删除其消息（对齐 ON DELETE CASCADE）。 */
  delete(id: SessionId): Promise<void>;
}
