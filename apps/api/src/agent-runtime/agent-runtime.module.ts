// apps/api/src/agent-runtime/agent-runtime.module.ts
// AgentRuntimeModule：C2 AgentRuntime 领域边界的 NestJS DI 接线（epic-c2-7 / c2-7-4，对齐 architecture §8、SPEC CAP-3）。
//
// 【边界】本文件在 apps/api（框架层）。核心包零框架——用例 service 类从 @codepilot/core 值导入，
//   经此处 useFactory 手工注入其构造依赖（core 里没有 @Injectable，DI 全在此接线）。
//   构造参数顺序务必严格对齐 core 里各 service 的 constructor（顺序错了会 tsc 报错或运行时崩）。
//
// 【解 C1↔C2 环 · 最重要】C2.StartStreamService 需 C1 的 GetSessionHistoryUseCase / AppendMessageUseCase；
//   C1.SetSessionTitleService 需 C2 的 TitleGenerator（GenerateTitleService）。双向依赖经 NestJS
//   forwardRef 两侧成对声明才能解环：本 Module imports forwardRef(() => ConversationModule) 拿 C1 用例 token；
//   ConversationModule 侧 imports forwardRef(() => AgentRuntimeModule) 拿 TITLE_GENERATOR。
//
// 【本期范围】只注册 CLAUDE_SDK 适配器（Native/Codex deferred）；C7 ProviderReadPort 用最小 stub
//   （写死单个 anthropic provider），C7 ProviderManagementModule 落地后替换。
//
// 【安全提醒】ChatController/PermissionController/RuntimeController 均无鉴权，仅限本机单机运行，勿暴露公网。
import { Module, forwardRef, Inject } from '@nestjs/common';
import {
  StreamSessionRegistry,
  StartStreamService,
  AbortStreamService,
  GenerateTitleService,
  RuntimeKind,
} from '@codepilot/core';
import type {
  Clock,
  IdGenerator,
  ErrorClassifier,
  AgentRuntimePort,
  ProviderReadPort,
  ForceAbortScheduler,
  GetSessionHistoryUseCase,
  AppendMessageUseCase,
} from '@codepilot/core';
import { SessionSseHub } from './adapters/session-sse-hub.js';
import { FileEventLog } from './adapters/file-event-log.js';
import { SessionStreamController } from './controllers/session-stream.controller.js';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module.js';
import { CLOCK, ID_GENERATOR, ERROR_CLASSIFIER } from '../shared-kernel/sk-tokens.js';
import { ConversationModule } from '../conversation/conversation.module.js';
import {
  GET_SESSION_HISTORY_USECASE,
  APPEND_MESSAGE_USECASE,
} from '../conversation/conversation.tokens.js';
import { ClaudeSdkEventMapper } from './adapters/claude-sdk-event-mapper.js';
import {
  ClaudeSdkRuntimeAdapter,
  type RuntimeEnvConfig,
} from './adapters/claude-sdk-runtime-adapter.js';
import { RuntimeRouter, type RuntimeAdapterMap } from './runtime-router.js';
import { SetTimeoutForceAbortScheduler } from './adapters/set-timeout-force-abort-scheduler.js';
import { StubProviderRepository } from './adapters/stub-provider-repository.js';
import { PermissionController } from './controllers/permission.controller.js';
import { ChatController } from './controllers/chat.controller.js';
import { RuntimeController } from './controllers/runtime.controller.js';
import {
  AGENT_RUNTIME_PORT,
  PROVIDER_READ_PORT,
  FORCE_ABORT_SCHEDULER,
  STREAM_SESSION_REGISTRY,
  START_STREAM_USECASE,
  ABORT_STREAM_USECASE,
  TITLE_GENERATOR,
  SESSION_SSE_HUB,
  FILE_EVENT_LOG,
} from './agent-runtime.tokens.js';
import { MANAGE_SESSION_USECASE } from '../conversation/conversation.tokens.js';

/**
 * loadRuntimeEnv —— 从 process.env 归约出注入 SDK query() options.env 的运行时配置（对齐 .env 约定）。
 *
 * 只搬运本机 litellm 网关 + 模型 + token 相关键；密钥（ANTHROPIC_AUTH_TOKEN）经此注入但绝不回显/记日志。
 * 读 process.env 属框架层职责（核心包禁读），故落在本接线处。
 */
function loadRuntimeEnv(): RuntimeEnvConfig {
  const keys = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_WORKFLOWS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  ] as const;
  const env: Record<string, string | undefined> = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

@Module({
  imports: [
    SharedKernelModule,
    // 解 C1↔C2 环：经 forwardRef 拿 C1 用例 token（GetSessionHistory / AppendMessage）。
    forwardRef(() => ConversationModule),
  ],
  providers: [
    // —— 活跃回合内存注册表（c2-4，非持久层）：StartStream 登记 / AbortStream 定位，共享同一实例 ——
    { provide: STREAM_SESSION_REGISTRY, useFactory: () => new StreamSessionRegistry() },

    // —— force-abort 安全网延时调度（c2-7-3，setTimeout 生产实现）——
    { provide: FORCE_ABORT_SCHEDULER, useClass: SetTimeoutForceAbortScheduler },

    // —— 验收链路适配器（epic-accept）：按会话 SSE 广播中枢（accept-2）+ 文件事件日志（accept-3）——
    // 均为 apps/api 最外层内存/本机组件，非核心、非持久层；供 SessionStreamController 一式三份落点消费。
    // 中枢单例保证同会话多连接 fan-out 共享；文件日志单例保证同进程内 seq 单调计数缓存共享。
    { provide: SESSION_SSE_HUB, useFactory: () => new SessionSseHub() },
    { provide: FILE_EVENT_LOG, useFactory: () => new FileEventLog() },

    // —— C7 ProviderReadPort 最小 stub（accept-1 / SPEC CAP-1，写死单个 Claude provider；C7 落地后替换）——
    // hasCredentials 反映真实凭据存在性（.env 的 ANTHROPIC_AUTH_TOKEN 是否就位，反假数据）；
    // token 值只用于归约布尔存在性，绝不透传/回显（密钥纪律）。model 从 .env 的 ANTHROPIC_MODEL 透传。
    {
      provide: PROVIDER_READ_PORT,
      useFactory: () => {
        const token = process.env.ANTHROPIC_AUTH_TOKEN;
        const hasCredentials = token !== undefined && token.length > 0 && token !== 'sk-REPLACE_ME';
        return new StubProviderRepository(hasCredentials, process.env.ANTHROPIC_MODEL);
      },
    },

    // —— AGENT_RUNTIME_PORT：ClaudeSdkRuntimeAdapter → RuntimeRouter（本期只注册 CLAUDE_SDK）——
    // ClaudeSdkRuntimeAdapter(mapper, env, errorClassifier)（queryFn/permissionSink 用缺省）。
    {
      provide: AGENT_RUNTIME_PORT,
      useFactory: (errorClassifier: ErrorClassifier): AgentRuntimePort => {
        const claudeSdkAdapter = new ClaudeSdkRuntimeAdapter(
          new ClaudeSdkEventMapper(),
          loadRuntimeEnv(),
          errorClassifier,
        );
        const adapters: RuntimeAdapterMap = {
          [RuntimeKind.CLAUDE_SDK]: claudeSdkAdapter,
        };
        return new RuntimeRouter(adapters, errorClassifier);
      },
      inject: [ERROR_CLASSIFIER],
    },

    // —— 驱动用例（构造参数顺序严格对齐 core 里各 service 的 constructor）——
    // StartStreamService(registry, runtime, providers, history, messages, idGenerator, clock, errorClassifier)
    {
      provide: START_STREAM_USECASE,
      useFactory: (
        registry: StreamSessionRegistry,
        runtime: AgentRuntimePort,
        providers: ProviderReadPort,
        history: GetSessionHistoryUseCase,
        messages: AppendMessageUseCase,
        ids: IdGenerator,
        clock: Clock,
        errorClassifier: ErrorClassifier,
      ) =>
        new StartStreamService(
          registry,
          runtime,
          providers,
          history,
          messages,
          ids,
          clock,
          errorClassifier,
        ),
      inject: [
        STREAM_SESSION_REGISTRY,
        AGENT_RUNTIME_PORT,
        PROVIDER_READ_PORT,
        GET_SESSION_HISTORY_USECASE,
        APPEND_MESSAGE_USECASE,
        ID_GENERATOR,
        CLOCK,
        ERROR_CLASSIFIER,
      ],
    },
    // AbortStreamService(runtime, registry, scheduler, errorClassifier, clock)
    {
      provide: ABORT_STREAM_USECASE,
      useFactory: (
        runtime: AgentRuntimePort,
        registry: StreamSessionRegistry,
        scheduler: ForceAbortScheduler,
        errorClassifier: ErrorClassifier,
        clock: Clock,
      ) => new AbortStreamService(runtime, registry, scheduler, errorClassifier, clock),
      inject: [
        AGENT_RUNTIME_PORT,
        STREAM_SESSION_REGISTRY,
        FORCE_ABORT_SCHEDULER,
        ERROR_CLASSIFIER,
        CLOCK,
      ],
    },
    // GenerateTitleService(runtime, providers)
    {
      provide: TITLE_GENERATOR,
      useFactory: (runtime: AgentRuntimePort, providers: ProviderReadPort) =>
        new GenerateTitleService(runtime, providers),
      inject: [AGENT_RUNTIME_PORT, PROVIDER_READ_PORT],
    },
  ],
  // 三个驱动适配器控制器（c2-7-5 补齐 ChatController/RuntimeController；PermissionController 属 c2-7-2 已就位）。
  // 均为本机无鉴权端点（sprint-plan「无 UI 本机后端」定位），生产化前需补访问控制（详见各控制器文件顶注）。
  controllers: [ChatController, PermissionController, RuntimeController, SessionStreamController],
  // 导出：START_STREAM/ABORT_STREAM/AGENT_RUNTIME_PORT 供 C3；TITLE_GENERATOR 供 C1（forwardRef 另一侧）。
  exports: [
    START_STREAM_USECASE,
    ABORT_STREAM_USECASE,
    AGENT_RUNTIME_PORT,
    TITLE_GENERATOR,
  ],
})
export class AgentRuntimeModule {}
