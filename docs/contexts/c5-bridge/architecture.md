---
title: 架构 — C5 Bridge IM 桥接
context: C5 · Bridge
status: draft
created: 2026-07-30
updated: 2026-07-30
---

# 架构：C5 · Bridge（IM 桥接）

> 产品简报见 [product-brief.md](./product-brief.md)，需求见 [prd.md](./prd.md)，史诗与故事见 [epics-stories.md](./epics-stories.md)。
> 边界契约见 [../../architecture/context-boundaries.md](../../architecture/context-boundaries.md)。
> 本文档由 API 中断后主编排层直接补写，端口签名对齐 C6/C1/C2 已完成架构。

## 1. 定位与依赖组合

C5 是**编排层（orchestration layer）**，本身不拥有渠道协议、会话逻辑、AI 流式相位，而是把三个下游上下文编排成一条闭环：

```
IM 平台 ──入站──> [C6 渠道插件] ──> [C5 路由] ──> [C1 会话] ──> [C2 运行时]
                                                                   │
IM 平台 <──投递── [C6 渲染/卡片] <── [C5 投递/卡片时序编排] <── AgentStreamEvent 流
```

- **消费 C6**：`ChannelPluginPort`（收发/能力/准入）、`RenderMessageUseCase`（Markdown→渠道 payload）、`ProbeChannelUseCase`（预检）、`CardStreamController`（流式卡片接口，C5 编排时序、C6 实现 API 调用）。
- **消费 C1**：`ManageSessionUseCase`（未绑定时建会话）、`AppendMessageUseCase`（消息落库）、`GetSessionHistoryUseCase`。
- **消费 C2**：`StartStreamUseCase` / `AbortStreamUseCase`，消费 `AgentStreamEvent` 流（不重造 `StreamPhase`）。
- **横切 SK**：`ErrorClassifier` / `Redactor` / `Clock` / `IdGenerator` / `RuntimeLog` / `TranslationPort`。
- **对外提供给 C3**：`PermissionBrokerPort`（子 agent 权限请求转 IM 按钮，引用图 `C5.PermissionBrokerPort ← C3`）。

## 2. 目录结构

```
packages/core/bridge/                 # 零框架 / 零 SDK / 零 DB / 零 node:*
├── domain/
│   ├── channel-binding.ts            #   ChannelBinding 实体 + 绑定不变量
│   ├── inbound-message.ts            #   InboundMessage 值对象（渠道地址+文本+附件+callbackData）
│   ├── outbound-message.ts           #   OutboundMessage 值对象（文本/按钮/卡片指令）
│   ├── delivery.ts                   #   DeliveryResult / DeliveryPlan 值对象
│   ├── permission-link.ts            #   PermissionLink 实体（requestId↔IM message 映射 + status 状态机）
│   ├── offset.ts                     #   OffsetCursor 值对象（fetch vs committed 分离）
│   ├── bridge-status.ts              #   BridgeStatus / AdapterStatus 值对象（实测状态，反假数据）
│   └── card-stream-plan.ts           #   卡片时序编排的领域态（节流窗口/degraded 标记，不含 API 调用）
├── ports/
│   ├── driving/                      #   入站用例接口
│   │   ├── route-inbound-message.usecase.ts
│   │   ├── delivery.port.ts          #   DeliveryPort（对外提供）
│   │   ├── permission-broker.port.ts #   PermissionBrokerPort（对外提供，供 C3）
│   │   ├── manage-bridge.usecase.ts
│   │   └── manage-binding.usecase.ts
│   └── driven/                       #   出站接口（依赖倒置）
│       ├── binding.repository.ts
│       ├── offset.repository.ts
│       ├── permission-link.repository.ts
│       ├── delivery-log.repository.ts   # dedup + outbound ref + 审计
│       └── rate-limiter.port.ts
└── usecases/                         #   编排实现（纯逻辑，注入端口）
    ├── route-inbound-message.service.ts
    ├── delivery.service.ts
    ├── card-stream-orchestrator.ts
    ├── permission-broker.service.ts
    ├── manage-bridge.service.ts      #   含 runAdapterLoop 编排
    └── manage-binding.service.ts

apps/api/src/modules/bridge/          # NestJS 驱动 + 被驱动适配器
├── bridge.controller.ts              #   HTTP：start/stop/status/绑定 CRUD
├── bridge.gateway.ts                 #   IM 回调入口（callback query）→ RouteInboundMessageUseCase
├── bridge.module.ts                  #   DI 装配：注入 C6/C1/C2 用例 + C5 出站适配器
└── adapters/
    ├── sqlite-binding.repository.ts
    ├── sqlite-offset.repository.ts
    ├── sqlite-permission-link.repository.ts
    ├── sqlite-delivery-log.repository.ts
    └── token-bucket-rate-limiter.ts
```

**依赖方向铁律**：`packages/core/bridge/` 对 `@larksuiteoapi/*`、Telegram/Discord SDK、`ws`、`@anthropic-ai/*`、`better-sqlite3`、`@nestjs/*`、`node:*` 静态扫描 0 命中（AC-15）。跨上下文类型（`InboundMessage` 之外的 `AgentStreamEvent`/`ChannelCapabilities`/C1 实体）仅 `import type`。

## 3. 领域模型（关键值对象/实体）

### 3.1 ChannelBinding（实体）
```ts
interface ChannelBinding {
  id: string;
  channelType: string;          // 'telegram' | 'feishu' | ...（不按名字分支能力）
  chatId: string;
  codepilotSessionId: string;   // 指向真实 C1 会话（反假数据：不指向不存在会话）
  providerId: string;
  model: string;
  mode: string;
  workingDirectory?: string;
  createdAt: number;
  updatedAt: number;
}
// 不变量：codepilotSessionId 必须由 C1.ManageSessionUseCase 产出；解绑前会话必须存在。
```

### 3.2 OffsetCursor（值对象，at-least-once 核心）
```ts
interface OffsetCursor {
  channelType: string;
  chatId: string;
  fetchOffset: string;       // 拉取用水位（可领先）
  committedOffset: string;   // 已处理完成水位（仅 handleMessage 成功后推进）
}
// 不变量：committedOffset <= fetchOffset；崩溃恢复从 committedOffset 重放（宁重复不丢）。
```

### 3.3 PermissionLink（实体 + 状态机）
```ts
type PermissionStatus = 'pending' | 'allow' | 'deny';
interface PermissionLink {
  permissionRequestId: string;   // 唯一，定向决议
  channelType: string; chatId: string; imMessageId: string;
  sessionId: string;             // 归属会话（可为子 agent run 的会话，C5 不区分调用方）
  status: PermissionStatus;      // pending 不冒充已决议
  createdAt: number; resolvedAt?: number;
}
// 状态机：pending → allow/deny（单向，幂等）；会话中断时批量 pending→deny(auto)。
```

### 3.4 BridgeStatus / AdapterStatus（实测状态，反假数据）
```ts
interface AdapterStatus {
  channelType: string;
  running: boolean;
  connectedAt: number | null;    // 实测连上时刻，未连=null
  lastMessageAt: number | null;  // 实测最后入站时刻，从未收=null
  error: ClassifiedError | null; // 实测失败（脱敏），无错=null
}
interface BridgeStatus { running: boolean; adapters: AdapterStatus[]; }
```

## 4. 驱动端口（对外用例接口，函数签名级）

### 4.1 RouteInboundMessageUseCase
```ts
interface RouteInboundMessageUseCase {
  // FR-1：解析/建绑定 → 准入 → callback 分流 → 起回合 → 落库
  route(msg: InboundMessage): Promise<RouteOutcome>;
}
type RouteOutcome =
  | { kind: 'routed'; sessionId: string; turnId: string }
  | { kind: 'permission_callback'; permissionRequestId: string }  // FR-1.3 分流
  | { kind: 'dropped'; reason: 'unauthorized' | 'busy' };          // FR-1.2 / FR-1.5
```

### 4.2 DeliveryPort（对外提供）
```ts
interface DeliveryPort {
  // FR-2：取 C6 渲染 payloads → 顺序/限速/重试/降级/dedup 投递
  deliverMarkdown(target: ChannelTarget, markdown: string, opts?: DeliverOpts): Promise<DeliveryResult[]>;
  deliverRaw(target: ChannelTarget, payloads: RenderedPayload[]): Promise<DeliveryResult[]>;
}
interface DeliveryResult { ok: boolean; messageId?: string; error?: ClassifiedError; } // ok 不冒充
```

### 4.3 PermissionBrokerPort（对外提供，供 C3 复用）
```ts
interface PermissionBrokerPort {
  // FR-4：流阻塞期间把权限请求转 IM 按钮，回调定向决议
  forwardRequest(req: PermissionRequest, target: ChannelTarget): Promise<void>;   // FR-4.1
  resolveFromCallback(callbackData: string): Promise<PermissionDecision | null>;  // FR-4.3
  autoApprovePendingForSession(sessionId: string): Promise<number>;               // FR-4.5
}
// 供 C3：C3 子 agent 权限请求经此端口转交/消费决议，C5 不感知调用方是主会话还是子 agent（FR-4.6 / AC-18）。
```

### 4.4 ManageBridgeUseCase / ManageBindingUseCase
```ts
interface ManageBridgeUseCase {
  start(): Promise<BridgeStatus>;   // 对每个启用渠道起 runAdapterLoop（预检失败不起）
  stop(): Promise<void>;            // 优雅关闭全部 adapter
  restart(): Promise<BridgeStatus>;
  status(): BridgeStatus;
}
interface ManageBindingUseCase {
  list(filter?: BindingFilter): Promise<ChannelBinding[]>;
  create(input: CreateBindingInput): Promise<ChannelBinding>;
  update(id: string, patch: BindingPatch): Promise<ChannelBinding>;
  remove(id: string): Promise<void>;
}
```

## 5. 出站端口（依赖倒置，函数签名级）

```ts
interface BindingRepository {
  findByChannel(channelType: string, chatId: string): Promise<ChannelBinding | null>;
  save(b: ChannelBinding): Promise<void>;
  list(filter?: BindingFilter): Promise<ChannelBinding[]>;
  remove(id: string): Promise<void>;
}
interface OffsetRepository {
  read(channelType: string, chatId: string): Promise<OffsetCursor | null>;
  commit(cursor: OffsetCursor): Promise<void>;   // 仅处理完成后调用
}
interface PermissionLinkRepository {
  save(link: PermissionLink): Promise<void>;
  findByRequestId(id: string): Promise<PermissionLink | null>;
  listPendingBySession(sessionId: string): Promise<PermissionLink[]>;
  updateStatus(id: string, status: PermissionStatus, resolvedAt: number): Promise<void>;
}
interface DeliveryLogRepository {
  checkDedup(key: string): Promise<boolean>;
  insertDedup(key: string): Promise<void>;
  insertOutboundRef(ref: OutboundRef): Promise<void>;
  insertAuditLog(entry: AuditEntry): Promise<void>;   // 只存 summary，不存全文
}
interface RateLimiterPort {
  acquire(chatId: string): Promise<void>;   // 令牌桶，超限排队
}
```

## 6. 核心编排流程

### 6.1 入站闭环（route）
```
1. binding = BindingRepository.findByChannel(type, chatId)
   └─ 无 → C1.ManageSessionUseCase.create() → BindingRepository.save(newBinding)
2. C6.ChannelPlugin.isAuthorized(userId, chatId) 为 false → dropped(unauthorized) + 审计
3. msg.callbackData 是权限决议 → PermissionBrokerPort.resolveFromCallback → permission_callback（不起回合）
4. C1.AppendMessageUseCase 落用户消息
5. C2.StartStreamUseCase.start({sessionId, provider, model, mode, cwd}) → AgentStreamEvent 流
6. 按 C6 能力：streaming=true → CardStreamOrchestrator；否则 DeliveryPort.deliverMarkdown
7. 终态 → C1.AppendMessageUseCase 落 AI 回复
```

### 6.2 runAdapterLoop（at-least-once）
```ts
while (running) {
  const msg = await plugin.consumeOne(fetchOffset);   // 拉取推进 fetchOffset
  if (msg) {
    try { await route(msg); await OffsetRepository.commit({...committedOffset=msg.offset}); }
    catch (e) { classify(e); /* 不推进 committed，下次重放 */ }
  }
}
// 崩溃恢复：从 committedOffset 重放，dedup 兜底重复（NFR-3 / AC-6）。
```

### 6.3 流式卡片时序（CardStreamOrchestrator，节流在 C5、API 在 C6）
```
首个 text → controller.create(chatId, initialText, replyTo) → cardMessageId
  ├─ cardMessageId === '' → 降级 DeliveryPort 普通分片（AC-14）
增量 text → 节流窗口内合并 → controller.update(cardMessageId, fullText)
  └─ 一次 update 失败 → degraded=true，跳过后续 preview，终态仍 finalize
thinking → controller.setThinking?（可选）
tool_use/tool_result → controller.updateToolCalls?（可选）
终态 → controller.finalize(cardMessageId, finalText, status)  // completed/interrupted/error 映射自 C2 终态
```

## 7. NestJS Module DI 装配

```ts
@Module({
  imports: [
    ChannelModule,       // 提供 ChannelPluginPort / RenderMessageUseCase / ProbeChannelUseCase / CardStreamController(C6)
    ConversationModule,  // 提供 ManageSessionUseCase / AppendMessageUseCase(C1)
    AgentRuntimeModule,  // 提供 StartStreamUseCase / AbortStreamUseCase(C2)
    SharedKernelModule,  // 横切
  ],
  controllers: [BridgeController, BridgeGateway],
  providers: [
    // 用例（注入下游用例 + 本地出站端口）
    { provide: ROUTE_INBOUND, useClass: RouteInboundMessageService },
    { provide: DELIVERY_PORT, useClass: DeliveryService },
    { provide: PERMISSION_BROKER_PORT, useClass: PermissionBrokerService },  // 导出供 C3
    { provide: MANAGE_BRIDGE, useClass: ManageBridgeService },
    { provide: MANAGE_BINDING, useClass: ManageBindingService },
    // 出站适配器
    { provide: BINDING_REPO, useClass: SqliteBindingRepository },
    { provide: OFFSET_REPO, useClass: SqliteOffsetRepository },
    { provide: PERMISSION_LINK_REPO, useClass: SqlitePermissionLinkRepository },
    { provide: DELIVERY_LOG_REPO, useClass: SqliteDeliveryLogRepository },
    { provide: RATE_LIMITER, useClass: TokenBucketRateLimiter },
  ],
  exports: [PERMISSION_BROKER_PORT],   // C3 SubagentModule 依赖
})
export class BridgeModule {}
```

- **单向依赖无环**：C5 → {C6, C1, C2, SK}，无一反向依赖 C5；`PermissionBrokerPort` 被 C3 导入（C3 → C5 单向），C5 不 import C3。
- **生命周期**：`ManageBridgeService` 实现 `OnModuleInit`/`OnModuleDestroy` 起停 adapter loop；dev HMR 用 `globalThis.bridgeModeActive` 防重复起。

## 8. 跨上下文契约核对

| C5 依赖/提供 | 对端 | 用途 | 引用方式 |
|---|---|---|---|
| `ChannelPluginPort` | C6 | 收发/能力/准入 | import type + DI |
| `RenderMessageUseCase` | C6 | Markdown→payload | DI |
| `ProbeChannelUseCase` | C6 | 启动预检 | DI |
| `CardStreamController` | C6 | 流式卡片 API（时序归 C5） | import type + DI |
| `ManageSessionUseCase`/`AppendMessageUseCase` | C1 | 会话/消息 | DI |
| `StartStreamUseCase`/`AbortStreamUseCase` + `AgentStreamEvent` | C2 | AI 运行时 | import type + DI |
| `PermissionBrokerPort` | **C3（消费方）** | 子 agent 权限 | export |
| `ErrorClassifier`/`Redactor`/`Clock`/`IdGenerator`/`RuntimeLog`/`TranslationPort` | SK | 横切 | DI |

## 9. 测试策略

- **单元**：全部用例注入内存假端口（假 `ChannelPluginPort`+假插件、假 C1/C2 用例、假 Repository、假 RateLimiter）运行，无真实 SDK/AI/网络/DB（AC-16）。
- **反例 smoke**：
  - AC-6：模拟 route 中崩溃 → 断言 committedOffset 未推进、重启重放。
  - AC-12：假 `permission_request` 在流阻塞期间 → 断言按钮在流**返回前**发出（不转发则死锁）。
  - AC-13：假插件谎报 `streaming=true` 但拿不到 controller → 断言走降级、不按 channelType 名字猜。
  - AC-14：`create` 返回空串 → 断言降级普通分片。
  - AC-17：一个渠道 loop 抛错 → 断言其它 loop 继续、不整体 crash。
- **边界断言（AC-19）**：接口层证明 C5 无渠道渲染方法、无会话/消息实体、无 `StreamPhase`/`StreamSession`、无 Provider 配置。
- **静态检查（AC-15）**：核心包禁用 import 扫描 0 命中。
