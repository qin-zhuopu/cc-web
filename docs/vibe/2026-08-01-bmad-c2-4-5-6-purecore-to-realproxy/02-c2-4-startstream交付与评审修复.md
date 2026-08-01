# 02 · c2-4 StartStream 交付与评审修复

## Epic 范围

C2-E4「发起回合 StartStream」——把纯核心零件串成一次回合的用例编排（FR-2 全部），全部纯逻辑、可用假端口测：
- CAP-1 StreamSessionRegistry 内存注册表 + StartStreamService 发起骨架
- CAP-2 Runtime 选择（ProviderReadPort 解析 → RuntimeKind 锁定）
- CAP-3 历史投影（只经 C1.getPromptView）
- CAP-4 单 active 约束（新回合前先 abort 旧回合，AC-11）
- CAP-5 事件消费与终态归因
- CAP-6 落 C1（终态非空非 autoTrigger 才经 AppendMessageUseCase.append）

## 执行链路

1. **拆解**：读 architecture §4.1/§6.1/§6.2、epics-stories S4.1~S4.6、既有端口签名 → 产出 `epic-c2-4/SPEC.md` + `stories.yaml`（6 故事）。
2. **写 workflow**：`wf-c2-4.mjs`。关键设计——c2-4-2~6 都改同一个 `start-stream.ts`，**必须串行**（不能并行冲突）；registry 独立文件先行。波次：Registry+Skeleton → RuntimeSelect → HistoryProjection → SingleActive → EventConsume → PersistC1 → Merge+Verify → Review。
3. **启动 workflow**（后台 `wif39vk00`），巡检 cron 兜底。
4. **完成**：8 agent 全绿，Merge 报 546 测试、守卫扫 89 文件 0 命中、exit 0。

## 对抗评审抓到的 2 个 AC-11 真缺陷（本 epic 招牌收获）

评审判「无阻断性缺陷」但抓到 2 个中/中低级真缺陷，都直击单 active 不变量 AC-11：

### 缺陷 1（TOCTOU，中）

`start()` 里「查旧 active（`getActiveBySession`）」是同步执行于方法开头，但新回合 `register` 排在 `await providers.resolve()` **之后**。两个并发的同 sessionId `start()` 会交错：
- A 查无 active → `await resolve` 让出
- B 查仍无 active（A 未 register）→ `await resolve` 让出
- A、B 先后 register → **同一 session 两个 active 回合**，破坏 AC-11。

**修法**：把 `resolve()` 提到单 active 检查之前，使「查旧 active → abort → delete → new → register」成为**无 await 的同步段**。副带好处：新请求 provider 非法时先抛错，不再误杀旧 active 回合。

### 缺陷 2（旧回合泄漏，中低）

abort 旧回合后不 `registry.delete`，防泄漏依赖被弃用 async generator 的 `finally`（`consumeRunStream` 的 `registry.delete`）——但被弃用的 generator 其 finally 不保证执行，terminal 旧回合永久滞留 Map 累积泄漏。

**修法**：abort 旧回合后**同步 `registry.delete(旧 streamId)`**，不依赖 generator finally。

## 修复动作

1. 改 `start-stream.ts`：resolve 提前 + abort 后同步 delete（两处一并修）。
2. 同步更新 3 个受影响测试（它们在第二次 start 后用 `registry.get(first.streamId)` 取旧回合——现旧回合已被 delete，改为「第二次 start 前先捕获引用」）+ 新增 1 个「摘除」断言。
3. 独立复跑门禁：**546 测试全绿**（其间遇一次偶发 teardown 超时 123s，复跑消失，与改动无关——查明是 vitest 偶发，非缺陷）。

## 提交

断点 `087af84`。精准暂存 usecases 源码 + epic-c2-4 产物 + wf 脚本 + index.ts + sprint-status，不混入用户的文档/配置改动（当时工作区有 CLAUDE.md 等一组用户改动）。
