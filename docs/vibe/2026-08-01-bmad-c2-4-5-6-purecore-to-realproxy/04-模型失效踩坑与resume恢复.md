# 04 · 模型失效踩坑与 resume 恢复

## 现象

`wf-c2-5.mjs` 首次启动（后台 `wa8fek7xc`）跑到一半，8 个 agent 里：
- c2-5-1（scheduler 端口）、c2-5-2（幂等门+安全网先行）**成功产出文件**。
- c2-5-3 起的 **6 个 agent 全部失败**，且都是同一个错误：

```
API Error: 400 [kiro/claude-opus-4.8] [400]:
{"message":"Invalid model ID. Please select a different model to continue.","reason":"INVALID"} (reset after 15s)
```

## 根因诊断

不是卡死、不是代码问题、不是网络抖动——是**会话模型短时失效**：workflow 子代理继承会话模型 `kiro/claude-opus-4.8`，该模型 ID 在那个时间窗被网关判为无效。

这正是上一轮 vibe 文档警告过的「退休/失效模型」坑的**变体**——上一轮是 `run-dev-auto.sh` 的 `claude -p` 子进程继承环境 `ANTHROPIC_MODEL` 空转，这次落在**会话模型层**、影响 workflow 子代理。错误带「reset after 15s」提示是暂时性。

## 处置

1. **幂等自检**：`git log` 确认 HEAD 仍干净在 `087af84`（c2-4 断点）；Glob 确认 c2-5-1/c2-5-2 的 4 个文件已产出、未提交。
2. **判断可 resume**：错误是模型层快速失败（非挂起、非部分写坏），c2-5-1/c2-5-2 有缓存、resume 成本低——只有 c2-5-3+ 会真打 API。
3. **resume**：`Workflow({scriptPath, resumeFromRunId: 'wf_06dd76d7-6a4'})`（后台 `wb6rlyn77`）。
4. **探活确认恢复**：resume 后查 journal——从失败时的 7 行增长、末行是新 agent started 无错误、`grep -c "Invalid model ID"` 归 0，证明越过失败点在重跑。c2-5-1/c2-5-2 从缓存秒回未浪费。
5. **完成**：resume 后 8 agent 全绿。

## 教训沉淀

- **模型层错误 ≠ 卡死**：巡检时靠 journal 的 `Invalid model ID` 命中数、agent transcript mtime 区分「真卡死」vs「快速失败」。快速失败该 resume，不该 TaskStop 空转重试。
- **resume 是模型抖动的正确解**：`resumeFromRunId` 让已成功 agent 缓存秒回，只重跑失败点之后——比整轮重跑省 token、不重复劳动。
- **workflow 子代理继承会话模型**：这既是优点（绕开 .env 退休模型，上一轮选 workflow 的关键原因），也意味着会话模型本身失效会波及所有子代理。会话模型抖动时，resume 是兜底。
- **幂等自检先行**：动 resume 前先确认 HEAD 干净、已产出文件完好，避免在脏状态上恢复。

## 巡检 cron 在本次的表现

用户设的 20 分钟巡检 cron 多次触发，每次都：查 git HEAD + sprint-status + workflow journal 行数/类型统计。其中一次两连查发现 journal 停在同一行、同一 agent started 无 result 达约 20 分钟——用 agent transcript 的 mtime（距当前仅 2 秒）判定「仍在活跃写入、非卡死」，只是 c2-4-6 落 C1 这一环工具调用多、transcript 达 485KB 所以慢。没有误判打断。这验证了巡检机制「用 journal + transcript mtime 双信号辨卡死」的有效性。
