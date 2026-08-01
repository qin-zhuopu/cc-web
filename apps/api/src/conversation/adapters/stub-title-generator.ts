// apps/api/src/conversation/adapters/stub-title-generator.ts
// TitleGeneratorPort 的占位实现（epic-c1-6）。
//
// 【为何是 stub】TitleGeneratorPort 的权威实现归 C2（GenerateTitleService），本期尚未落地
//   （C2 的标题服务排在 c2-7）。apps/api 里也还没有 AgentRuntimeModule。为让 ConversationModule
//   的 SetSessionTitleService 能完整装配、DI 图不悬空，本 epic 先绑此 stub。
//
// 【行为】generateTitle 一律抛错——SetSessionTitleService.generateByAi 会 catch 该错、记一条 warn、
//   保留原标题返回（降级路径，见 set-session-title.ts §降级）。即：接了 stub 时「AI 生成标题」是安全 no-op，
//   绝不写入脏标题。C2 落地后，把 ConversationModule 里 TITLE_GENERATOR 的绑定换成经 forwardRef
//   注入的真实现即可，SetSessionTitleService 无需改动。
import type { TitleGeneratorPort, TitleGenerationInput } from '@codepilot/core';

/** 占位 TitleGenerator：抛错以触发 C1 用例的降级路径。C2 落地后替换。 */
export class StubTitleGenerator implements TitleGeneratorPort {
  async generateTitle(_input: TitleGenerationInput): Promise<string> {
    throw new Error(
      'StubTitleGenerator：AI 标题生成尚未接入（C2 GenerateTitleService 待落地，epic-c2-7）。',
    );
  }
}
