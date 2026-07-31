// conversation/domain/session/chat-session.ts
// C1 会话领域：ChatSession 会话本体实体 + 会话三枚举 + SessionId 值对象。
// 对齐 architecture §3.1 / §3.2。零框架 import，纯领域类型。

/**
 * 会话标识。品牌类型的轻量形态：本质是 string 别名，
 * 语义上标注「这是一枚会话 id」，由 SK.IdGenerator 生成，C1 不自造。
 */
export type SessionId = string;

/**
 * 会话状态。取值来源 architecture §3.2。
 * - active：活跃会话（默认）。
 * - archived：已归档，列表默认可过滤。
 */
export enum SessionStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

/**
 * 会话模式。取值来源 architecture §3.2。
 * - code：编码模式（默认）。
 * - plan：规划模式。
 * - ask：问答模式。
 */
export enum SessionMode {
  CODE = 'code',
  PLAN = 'plan',
  ASK = 'ask',
}

/**
 * 会话来源。取值来源 architecture §3.2。
 * - user：用户手动创建（默认，列表默认只展示这类）。
 * - task：任务派生（FR-1.6 列表默认过滤）。
 */
export enum SessionSource {
  USER = 'user',
  TASK = 'task',
}

// 标题来源为独立值对象，类型-only 引用（NodeNext 需 .js 扩展名）。
import type { TitleOrigin } from './title-origin.js';

/**
 * ChatSession —— 会话本体实体（不可变领域模型，字段全 readonly）。
 * 仅建模「会话是什么」的 10 个本体字段，对齐 architecture §3.1。
 *
 * 【字段归属铁律 · architecture §3.1】
 * 运行时 / Provider / Codex 字段一律不进本实体，包括但不限于：
 *   sdkSessionId、codexThreadId、codexThreadProviderId、runtimeStatus、
 *   runtimeUpdatedAt、providerId、providerName、permissionProfile、
 *   contextSummary*（C2 产出的摘要投影）。
 * 这些寄存字段属 C2 运行时 / C7 消费投影 / C5 权限，物理层迁移期可暂留同表，
 * 但读写归各自领域边界经其端口；C1 的 SessionRepository 只投影会话本体，
 * 不为运行时字段负责。切勿让「会话是什么」被运行时细节淹没。
 */
export interface ChatSession {
  /** 会话 id，由 SK.IdGenerator 生成。 */
  readonly id: SessionId;
  /** 标题文案。缺省时用默认标题（key: c1.session.defaultTitle）。 */
  readonly title: string;
  /** 标题来源，决定覆盖优先级（default < ai < user）。 */
  readonly titleOrigin: TitleOrigin;
  /** 会话状态：active | archived。 */
  readonly status: SessionStatus;
  /** 会话模式：code | plan | ask。 */
  readonly mode: SessionMode;
  /** 会话来源：user | task（默认 user）。 */
  readonly source: SessionSource;
  /** 会话归属的工作目录。 */
  readonly workingDirectory: string;
  /** 工作目录对应的项目名。 */
  readonly projectName: string;
  /** 创建时刻，epoch 毫秒，来自 SK.Clock.now()。 */
  readonly createdAt: number;
  /** 最后更新时刻，epoch 毫秒，来自 SK.Clock；touch 时更新。 */
  readonly updatedAt: number;
}
