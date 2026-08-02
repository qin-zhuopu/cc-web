---
title: '接受并发 turn 的集成测试（CAP-8）'
type: 'feature'
created: '2026-08-02'
status: 'done'
review_loop_iteration: 1
baseline_commit: '1eca06c39f2d8bd1161d3a52539b3c60bf36f8b5'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**问题：** C2 会话流式 API 的「并发 turn」（同 sessionId 在旧流未结束时发起新流）是核心 UX 场景（Claude Code 桌面版一致行为），但 HTTP 层缺乏该路径的集成测试。核心层 `start-stream.test.ts` 已覆盖单 active 约束（C2-4-4），HTTP 层现有 `accept-6` 只测了串行 POST /turn，未覆盖「输出中再发」的并发竞态。

**做法：** 在 `apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts` 中补充集成测试，用**手动控制的 deferred stub events** 模拟「第一个回合故意只产出部分事件就挂起」的场景，连续发两次 `POST /:id/turn`，断言：两次均返回 202 受理、`startSpy` 被调两次、挂载连接收到全部事件（含 seq 不递减）、文件日志无重复残骸。

## Boundaries & Constraints

**Always：**
- 集成测试只验证**控制器层**可见行为（HTTP 响应、广播、日志），不试图在 mock 中复刻核心层 `abort` 语义——那是「单 active 约束」单测的职责。
- 必须复用已有 `makeFakeSseRes`、`eventsOf`、`waitForFrames`、`waitForLog`、`settleTicks`、`tmpDir` 夹具，不另造架子。
- 新断言必须诚实：能验什么写什么，不能「假装验证了核心层 abort」。

**Ask First：**
- 如需超出 1 个挂载连接来验证 fan-out，需额外断言（默认只挂 1 个）。
- 若需要引入任何新依赖（非 vitest 已有之外），HALT 问用户。

**Never：**
- 不在 mock 的 `StartStream.start` 中复刻 `abort` 语义（单测已覆盖，集成测试 mock 不支持异步迭代器被外部 abort）。
- 不修改 `session-stream.controller.ts` 本身——本目标只追加测试代码。
- 不涉及真实 litellm 调用（用 stub events；litellm 集成属 C2-9 范围）。
- 不写「验证旧回合被 abort / 旧回归翻 terminal」的断言——集成测试 layer 看不到聚合根状态。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 并发 turn —— 旧流挂起时新 turn | `POST /sess/turn` 发两句，第二句在 consumeInBackground 未消费完第一句的 events 时就发起 | 两次均返回 `202 { accepted: true }`；`startSpy.mock.calls.length === 2`；挂载连接最终收到两句全部事件；文件日志无重复 | `eventsOf` 流的调度器异常 → 让出 tick 后重试；test fail 即真失败 |
| 并发 turn —— 事件不崩溃 | 同上，但引入 `yield` 时序：第一句先 yield text 事件，让出 tick，再 yield 第二句的事件 | 挂载连接收到的 seq 在整段历史中严格递增（`1 < 2 < 3 < ...`），无 seq 重复或跳号 | 第一流的 residual yield 若仍挂后台 → `consumeInBackground` 仍会消费并 publish；这是已知且合法的（因为 mock 不支持 abort，但事件仍会被 hub.publish，被「新流」的正常 seq flow 接在幂等去重之后） |

</frozen-after-approval>

## Code Map

- `apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts` —— 接受测试文件（第 420–700 行区域已有 accept-6 + F1 测试块，需在其后追加 CAP-8 块）。这是**唯一需修改的文件**。
- `apps/api/src/agent-runtime/controllers/session-stream.controller.ts` —— 接受控制器（POST /:id/turn → sendMessage + consumeInBackground），只读作为测试参照。
- `apps/api/src/agent-runtime/adapters/session-sse-hub.ts` —— 中枢 publish/subscribe，上一轮测试已直接使用。
- `apps/api/src/agent-runtime/adapters/file-event-log.ts` —— `append`/`readAfter`，上一轮测试已直接使用。
- `packages/core/src/agent-runtime/usecases/start-stream.test.ts:433–472` —— 核心层「单 active 约束」单测（只读，作背景知识）。

## Tasks & Acceptance

**执行：**
- [x] `apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts` —— 追加 `describe('SessionStreamController —— 并发 turn（CAP-8）', ...)` 块，含两条 it：
  1. **`旧流挂起时新 POST /turn → 两次均受理`**: 用 `DeferredEvents` 工厂生产第一个故意慢的 events 流；先发第一 turn（返回 202）；不等消费完就发第二 turn（返回 202）；断言 `startSpy.mock.calls.length === 2`。
  2. **`并发 turn 后挂载连接收到全部事件且不重复`**: 同场景下预挂 GET stream 连接 → 给第一句的事件逐帧 yield → 给第二句 yield → 断言挂载连接最终收到 `N+M` 条事件、seq 为 `1..(N+M)` 严格递增、Set 无重复。

**验收标准：**
- Given `sendMessage` 被同 sessionId 连续调用两次（第二次不在第一次 `consumeInBackground` 跑完前到来），when 两次调用均 resolve，then 均返回 `{ accepted: true }` 且 `startSpy` 被调两次。
- Given 挂载了一个 GET stream 连接 + 上述并发 turn 场景，when 两流事件全部 yield 完，then 挂载连接最终收到全部事件，且 seq 序列严格递增 `1..K`（K 为两流事件总数）、无重复。
- 测试通过 `vitest run`（命令：`cd /home/dev/repo/github.com/qin-zhuopu/cc-web && npx vitest run apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts`）。

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. -->

- **触发：** adversarial + edge-case review（ review_loop_iteration=1 ）。
  **修改：** (1) DeferredEvents 加 end() 后 push() guard + iterable() 消费标记防二次遍历；(2) startSpy 用 `mock.calls.length` 替代闭包 `callCount`；(3) 测试2 ack2 提前到 waitForFrames 之前并发更激进；(4) 补文件日志断言（rows.length + seq 严格递增）。
  **避免的坏状态：** end() 后再 push 静默丢事件；iterable() 被二次消费致事件撕裂；闭包 callCount 在额外调用时返回错误 deferred。
  **KEEP：** DeferredEvents 的 resolveQueue + flush 模式继续保留（比特级时序控制可靠）。
  **defer：** error()/throw() 异常路径（通用夹具可扩展项）；空流 / 三流以上并发边界。

## Design Notes

**DeferredEvents 工厂（必须嵌入测试文件）：**
```ts
class DeferredEvents {
  private queue: Array<() => Promise<IteratorResult<AgentStreamEvent>>> = [];
  private resolveQueue: Array<(fn: () => Promise<IteratorResult<AgentStreamEvent>>) => void> = [];
  private done = false;

  push(event: AgentStreamEvent) { this.queue.push(() => Promise.resolve({ done: false, value: event })); }
  end() { this.done = true; this.flush(); }
  private flush() { while (this.resolveQueue.length && this.queue.length) this.resolveQueue.shift()!(this.queue.shift()!); }
  async next() {
    if (this.queue.length) return this.queue.shift()!();
    if (this.done) return { done: true as const, value: undefined };
    return new Promise<IteratorResult<AgentStreamEvent>>((r) => this.resolveQueue.push(r));
  }
  iterable(): AsyncIterable<AgentStreamEvent> {
    const self = this;
    return { async *[Symbol.asyncIterator]() { let v; while (!(v = await self.next()).done) yield v.value; } };
  }
}
```
这个工厂让测试能**比特级控制** yield 时序：先 `push(text1)`、`next()`（事件被 yield），等消费者开始 consume 后，在 yield 第二句的 text2 之前发起第二个 turn。

**为什么 mock 流不会被 abort 但仍然合法：**
集成测试的 mock `StartStream` 不知道核心层的 `abort` 协议。所以第一流的 deferred events 在第二 turn 开始后若继续 `push`，其 `consumeInBackground` 仍会继续消费并 `hub.publish`。这在 HTTP 层的语义等同于「旧回合的失速事件仍被消费直到自然结束，新的回合事件同时正常发布」——hub 的去重（seq 严格递增）和文件日志的 append 不会因为这些事件来自两个独立的 `consumeInBackground` 而出现重复/破坏。这是集成测试**能看到但无需修正**的行为，因为真正「旧回合被 abort 从而事件不增加」的行为已经在核心层单测中保证。

**测试不挂 GET stream 时也要跑通：**
上述两条 it 都应能独立通过（即不论是否先挂载 GET stream，两次 sendMessage 都返回 202）。

## Suggested Review Order

**并发 turn 集成测试（CAP-8）**

- DeferredEvents 工厂：手动控制事件 yield 时序的核心夹具
  [`session-stream.controller.spec.ts:1082`](../../apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts#L1082)

- 旧流挂起时第二 turn 仍返回 202：验证控制器层不阻塞
  [`session-stream.controller.spec.ts:710`](../../apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts#L710)

- 挂载连接事件 + seq 递增断言：并发两流事件不交织、seq 1..K 严格递增
  [`session-stream.controller.spec.ts:750`](../../apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts#L750)

- 测试块头注释：CAP-8 场景说明与预期行为
  [`session-stream.controller.spec.ts:684`](../../apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts#L684)

## Verification

**命令：**
- `cd /home/dev/repo/github.com/qin-zhuopu/cc-web && npx vitest run apps/api/src/agent-runtime/controllers/session-stream.controller.spec.ts --reporter=verbose` -- expected: `6 passed` 增加至 `8 passed`（新增 2 条 it）
- `cd /home/dev/repo/github.com/qin-zhuopu/cc-web && npm run typecheck` -- expected: `tsc --build` 无新增报错

**Manual checks:**
- 确认新测试块加在 accept-6 所有测试之后、加在 accept-7 之前（按验收编号组织）。
- 确认 `DeferredEvents` 类的 `AgentStreamEvent` import 不需要新增（文件顶部已 import）。
