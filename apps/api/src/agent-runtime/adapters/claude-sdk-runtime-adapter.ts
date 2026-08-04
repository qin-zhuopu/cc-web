// apps/api/src/agent-runtime/adapters/claude-sdk-runtime-adapter.ts
// C2 · ClaudeSdkRuntimeAdapter —— 封装 @anthropic-ai/claude-agent-sdk 的 query()/Query 句柄，
//   实现核心 AgentRuntimePort（epic-c2-6 / c2-6-1b，对齐 architecture §7.1）。
//
// 【边界】本文件在 apps/api（框架/基础设施层），可 import @anthropic-ai/*。核心包 packages/core 零框架、
//   绝不出现 SDK/Query/AbortController 细节；本适配器把这些锁在此处，对外只吐已归一的 AgentStreamEvent。
//   只 import type 核心端口/类型 + 值 import 必要项，绝不反向让核心依赖框架。
//
// 【流式输入模式】Query.interrupt() 仅在「流式输入」（prompt 为 AsyncIterable<SDKUserMessage>）下可用。
//   故 run 以流式输入构造 prompt（yield 一条 user 消息后结束），这样 interrupt 才能真正中断在途回合。
//
// 【句柄注册 + late-unregister no-op（AC-6）】run 时以 streamId 为键注册 { query, abort } 到内存 Map。
//   interrupt/forceKillTurn/正常收尾都按 streamId 注销——但注销前校验归属：Map 里该 streamId 若已是
//   新 turn 的句柄（旧 turn 复用同 streamId 的场景不存在，streamId 唯一，但防御 late teardown），
//   或该 streamId 已不在，则 no-op，绝不 evict 别的 turn 句柄。
//
// 【.env 注入】query() 的 options.env 注入 apps/api/.env 的 litellm 配置（ANTHROPIC_BASE_URL/
//   ANTHROPIC_AUTH_TOKEN/各 *_MODEL=claude-sonnet-4-5/CLAUDE_CODE_*）。token 绝不写日志/回显。

import { query, type Query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRuntimePort,
  RuntimeRunRequest,
  TurnRef,
  AgentStreamEvent,
  RuntimeAvailability,
  ErrorClassifier,
  PermissionDecision,
} from '@codepilot/core';
import { ClaudeSdkEventMapper } from './claude-sdk-event-mapper.js';

/**
 * RuntimeEnvConfig —— 注入 query() options.env 的运行时配置（来自 apps/api/.env）。
 * 由构造注入（读 .env 的机制在 apps/api：process.env / @nestjs/config，属 c2-7 接线）；
 * 适配器只消费一个已解析好的键值表，不自行读 process.env（便于单测注入假配置）。
 */
export type RuntimeEnvConfig = Readonly<Record<string, string | undefined>>;

/**
 * ClaudeSdkQueryFn —— query() 的最小函数签名别名（便于单测注入 mock query，不打真网络）。
 * 生产传入 SDK 的真实 query；测试传入返回可控假 message 序列的替身。
 */
export type ClaudeSdkQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

/** 内部句柄条目：一次在途回合的 Query 句柄 + 其 application-owned AbortController。 */
interface TurnHandle {
  readonly query: Query;
  readonly abort: AbortController;
}

/**
 * PermissionDecisionSink —— 决议投递到真实 SDK 的最小函数契约（c2-7 扩展占位）。
 *
 * 【为何是占位】真实 Claude Agent SDK 的权限决议投递语义（对齐 canUseTool 回调 / 后续 setPermissionResult）
 *   属适配器后续完善（本 epic Non-goals 明确不接 resume/权限 SDK 细节）。本 epic 只接通**中转契约**：
 *   构造未注入 sink 时，决议**缓存保留**（见 pendingDecisions），绝不静默丢弃（对齐 SPEC CAP-2「不吞决议」）。
 *   注入 sink 时按 streamId + 决议投递给真实 SDK。
 */
export type PermissionDecisionSink = (
  streamId: string,
  decision: PermissionDecision,
) => void | Promise<void>;

/**
 * ClaudeSdkRuntimeAdapter —— 实现 AgentRuntimePort，封装 Claude Agent SDK。
 */
export class ClaudeSdkRuntimeAdapter implements AgentRuntimePort {
  private readonly mapper: ClaudeSdkEventMapper;
  private readonly env: RuntimeEnvConfig;
  private readonly errorClassifier: ErrorClassifier;
  private readonly queryFn: ClaudeSdkQueryFn;
  private readonly permissionSink?: PermissionDecisionSink;

  /** streamId → 在途回合句柄。终态/中断后注销（校验归属，late-unregister no-op）。 */
  private readonly handles = new Map<string, TurnHandle>();

  /**
   * 【c2-7 · CAP-2】未注入 permissionSink 时，缓存待投递的决议（按 streamId 追加），
   * 使中转契约「不吞决议」——真实 SDK 决议投递语义完善后可读取缓存补投。绝不静默丢弃。
   */
  private readonly pendingDecisions = new Map<string, PermissionDecision[]>();

  /**
   * @param mapper          SDKMessage → AgentStreamEvent 归一器。
   * @param env             注入 query() options.env 的 .env 配置（token 绝不回显）。
   * @param errorClassifier SK.ErrorClassifier（SDK 抛错归一成 ClassifiedError）。
   * @param queryFn         query 实现，缺省用 SDK 真实 query；单测注入 mock。
   * @param permissionSink  【c2-7 扩展】决议投递到真实 SDK 的 sink（占位，缺省缓存决议不丢弃）。
   */
  constructor(
    mapper: ClaudeSdkEventMapper,
    env: RuntimeEnvConfig,
    errorClassifier: ErrorClassifier,
    queryFn: ClaudeSdkQueryFn = query,
    permissionSink?: PermissionDecisionSink,
  ) {
    this.mapper = mapper;
    this.env = env;
    this.errorClassifier = errorClassifier;
    this.queryFn = queryFn;
    this.permissionSink = permissionSink;
  }

  /**
   * 发起一次原生调用，产出**已归一**的 AgentStreamEvent 流（对齐 §7.1）。
   *
   * - 以流式输入（AsyncIterable<SDKUserMessage>）构造 prompt，使 Query.interrupt() 可用。
   * - options.env 注入 .env 配置；options.abortController 用 application-owned signal（供 interrupt/forceKill）。
   * - 以 streamId 注册句柄；async generator 把 SDK message 过 mapper.mapMessage → 逐个 yield 归一事件。
   * - SDK 迭代抛错 → 经 ErrorClassifier 归一成 error 事件 yield（不静默、不停在 active，配合 c2-5 兜底），再结束。
   * - finally：注销该 streamId 句柄（校验归属）。
   */
  run(request: RuntimeRunRequest): AsyncIterable<AgentStreamEvent> {
    const streamId = request.streamId;
    const abort = new AbortController();

    // 把核心的 AbortSignalLike 接到 application-owned AbortController：核心侧触发 abort → 传导给 SDK。
    const onCoreAbort = (): void => abort.abort();
    request.abortSignal.addEventListener('abort', onCoreAbort);
    if (request.abortSignal.aborted) {
      abort.abort();
    }

    const options: Options = {
      // .env 注入运行时环境（litellm 网关 + 模型 + token）。SDK 子进程据此路由。
      env: { ...this.env },
      abortController: abort,
    };

    const q = this.queryFn({
      prompt: this.buildPrompt(request),
      options,
    });

    // 注册句柄（streamId 唯一，来自核心 IdGenerator）。
    this.handles.set(streamId, { query: q, abort });

    const mapper = this.mapper;
    const errorClassifier = this.errorClassifier;
    const self = this;

    async function* normalized(): AsyncIterableIterator<AgentStreamEvent> {
      try {
        for await (const message of q) {
          for (const event of mapper.mapMessage(message)) {
            yield event;
          }
        }
      } catch (err) {
        // SDK 迭代抛错：归一成 error 事件对外发（不静默吞、不伪造成功）。
        const classified = errorClassifier.classify(err);
        yield { type: 'error', error: classified };
      } finally {
        request.abortSignal.removeEventListener('abort', onCoreAbort);
        // 注销句柄（校验归属，late-unregister no-op）。
        self.unregister(streamId, q);
      }
    }

    return normalized();
  }

  /**
   * 优雅中断（对齐 §7.1 / FR-3.5）：先 abort application-owned signal，再 Query.interrupt()，
   * 返回 Runtime 权威状态（供核心 reconcilePhase）。关闭并注销该 streamId 句柄。
   *
   * @returns 权威状态字符串（interrupted），SDK 无明确状态时返回 null（交核心 force-abort 兜底）。
   */
  async interrupt(turnRef: TurnRef): Promise<string | null> {
    const handle = this.handles.get(turnRef.streamId);
    if (handle === undefined) {
      // 句柄已不在（回合已收尾/已中断）：幂等 no-op。
      return null;
    }
    // 先 abort application-owned signal（对齐现有 abortConversation：先 abort 再优雅 interrupt）。
    handle.abort.abort();
    try {
      await handle.query.interrupt();
      // SDK interrupt 成功：回合已被中断，返回权威状态供 reconcilePhase 收敛。
      return 'interrupted';
    } catch {
      // interrupt 失败/挂起后被拒：不抛，返回 null 交核心 force-abort 安全网兜底（#578 精神）。
      return null;
    } finally {
      this.unregister(turnRef.streamId, handle.query);
    }
  }

  /**
   * 强制关闭 turn（force-abort 安全网兜底调用，FR-3.5）。同步、不抛。
   * abort application-owned signal + 注销句柄；不等待 SDK 优雅收尾。
   */
  forceKillTurn(turnRef: TurnRef): void {
    const handle = this.handles.get(turnRef.streamId);
    if (handle === undefined) {
      return;
    }
    try {
      handle.abort.abort();
    } catch {
      // 强制兜底：即便 abort 抛错也不外泄，确保句柄被摘除。
    }
    this.unregister(turnRef.streamId, handle.query);
  }

  /**
   * 【c2-7 · CAP-2】权限决议投递（FR-7.2/7.3）：把上层忠实转发来的决议投递给真实 SDK。
   * C2 只中转、不裁决——原样透传 permissionRequestId/status/updatedInput/denyMessage，不篡改、不加经纪逻辑。
   *
   * 【真实投递属适配器后续完善】注入 permissionSink 时按 streamId + 决议投递给 SDK；
   * 未注入 sink（本期占位）→ 缓存决议到 pendingDecisions，绝不静默丢弃（对齐 SPEC「不吞决议」）。
   */
  async resolvePermission(turnRef: TurnRef, decision: PermissionDecision): Promise<void> {
    const streamId = turnRef.streamId;
    if (this.permissionSink !== undefined) {
      await this.permissionSink(streamId, decision);
      return;
    }
    // 无 sink：缓存保留决议（不丢弃），待真实 SDK 决议投递语义完善后补投。
    const bucket = this.pendingDecisions.get(streamId);
    if (bucket === undefined) {
      this.pendingDecisions.set(streamId, [decision]);
    } else {
      bucket.push(decision);
    }
  }

  /** 【c2-7 · 测试/后续可见】读取某 streamId 尚未投递的缓存决议（无 sink 时的中转不丢弃佐证）。 */
  pendingDecisionsFor(streamId: string): ReadonlyArray<PermissionDecision> {
    return this.pendingDecisions.get(streamId) ?? [];
  }

  /**
   * 非 spawn 可用性探测（不发起真实回合）：本适配器只要配置了 base URL + token 即视为 ready。
   * 反假数据：缺配置标 unavailable + reason，绝不显假 ready。
   */
  async availability(): Promise<RuntimeAvailability> {
    const baseUrl = this.env.ANTHROPIC_BASE_URL;
    const token = this.env.ANTHROPIC_AUTH_TOKEN;
    if (
      typeof baseUrl === 'string' &&
      baseUrl.length > 0 &&
      typeof token === 'string' &&
      token.length > 0
    ) {
      return { kind: 'ready' };
    }
    // 不回显 token 值，只报缺哪项配置。
    const missing: string[] = [];
    if (!baseUrl) missing.push('ANTHROPIC_BASE_URL');
    if (!token) missing.push('ANTHROPIC_AUTH_TOKEN');
    return { kind: 'unavailable', reason: `缺少运行时配置：${missing.join(', ')}` };
  }

  /**
   * 注销句柄（late-unregister no-op，AC-6）：仅当 Map 里该 streamId 对应的正是**同一个** Query 句柄时才删除。
   * 旧 turn 的迟到 teardown 传入过期 streamId、而 Map 已被新 turn 覆盖时，句柄不匹配 → no-op，
   * 绝不 evict 新 turn 的句柄。
   */
  private unregister(streamId: string, q: Query): void {
    const current = this.handles.get(streamId);
    if (current !== undefined && current.query === q) {
      this.handles.delete(streamId);
    }
    // 不匹配（已被新句柄覆盖 / 已删除）→ no-op。
  }

  /**
   * 构造流式输入 prompt（单条 user 消息后结束流）。用流式输入使 Query.interrupt() 可用。
   * promptView（C1 历史投影）本期不逐条回放进 SDK——SDK 有自身会话续接；本条只发当前回合 content。
   * （历史续接的完整接线属后续，随 EPIC-ACCEPT / resume 细化，此处不臆造 SDK 会话恢复语义。）
   */
  private async *buildPrompt(request: RuntimeRunRequest): AsyncIterable<SDKUserMessage> {
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: request.content },
      parent_tool_use_id: null,
    };
    yield userMessage;
  }
}
