// conversation/usecases/set-session-title.ts
// C1 应用用例：会话标题设置状态机（SetSessionTitleUseCase 实现）。
// 对齐 architecture §6 / §7。零框架 import，纯编排逻辑；依赖全经构造注入端口。
//
// 【编排纪律】
// - setByUser：用户手改恒生效（canOverrideTitle 对 user 恒 true），直写 origin='user'。
// - generateByAi：user 态不被 ai 覆盖（连 TitleGenerator 都不调）；否则投影 recentMessages
//   喂 TitleGeneratorPort，canOverrideTitle 放行才写 origin='ai'；失败降级保留原标题。
// - C1 绝不自己拼 AI 标题提示词：只把 getPromptView 投影出的 recentMessages 纯文本传给端口，
//   绝不构造提示词/模型参数/模板，绝不 import C2 实现或任何 @anthropic-ai。

import type { ChatSession, SessionId } from '../domain/session/chat-session.js';
import type { SetSessionTitleUseCase } from '../ports/driving/set-session-title-usecase.js';
import type { GetSessionHistoryUseCase } from '../ports/driving/get-session-history-usecase.js';
import type { SessionRepository } from '../ports/driven/session-repository.js';
import type {
  TitleGeneratorPort,
  TitleGenerationInput,
} from '../ports/driven/title-generator-port.js';
import { canOverrideTitle } from '../domain/session/title-origin.js';
import type { Clock } from '../../ports/clock.js';
import type { RuntimeLog } from '../../ports/runtime-log.js';

/**
 * SetSessionTitleService —— 会话标题设置状态机用例。
 *
 * 构造注入五依赖（architecture §7）：SessionRepository、GetSessionHistoryUseCase、
 * TitleGeneratorPort、Clock、RuntimeLog。核心不 new、时间与 ID 一律经端口取得。
 */
export class SetSessionTitleService implements SetSessionTitleUseCase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly history: GetSessionHistoryUseCase,
    private readonly titleGenerator: TitleGeneratorPort,
    private readonly clock: Clock,
    private readonly runtimeLog: RuntimeLog,
  ) {}

  /**
   * 用户手改：写入并标 titleOrigin='user'。
   * 用户手改恒生效——canOverrideTitle(current, 'user') 对任意 current 恒为 true，
   * 故无需拦截，直接写库。
   *
   * 缺失 id：本用例返回类型为非可选 ChatSession（接口语义不容 undefined），
   * 故会话不存在时抛错，而非返回一个虚构本体（不做 as-cast 伪造）。
   */
  async setByUser(id: SessionId, title: string): Promise<ChatSession> {
    const current = await this.sessions.getById(id);
    if (current === undefined) {
      throw new Error(`SetSessionTitleService.setByUser：会话不存在（id=${id}）。`);
    }
    await this.sessions.setTitle(id, title, 'user');
    return { ...current, title, titleOrigin: 'user' };
  }

  /**
   * AI 生成标题：调 C2.TitleGenerator 拿标题，仅当当前 origin ∈ {default, ai} 时写入并标 'ai'。
   *
   * 编排（architecture §6）：
   * 1. 取当前会话；不存在则抛错（返回类型非可选，不伪造本体，与 setByUser 一致）。
   * 2. 若 titleOrigin==='user'：user 态不被 ai 覆盖，直接返回原会话——连 TitleGenerator 都不调
   *    （canOverrideTitle('user','ai') 恒 false，早退避免无谓的历史投影与模型调用）。
   * 3. 否则经 GetSessionHistoryUseCase.getPromptView 投影出 recentMessages 纯文本片段，
   *    喂 TitleGeneratorPort.generateTitle；C1 只传投影文本，绝不拼提示词/模型参数/模板。
   * 4. 生成成功且 canOverrideTitle(current, 'ai') 放行 → setTitle(生成标题, 'ai') 并返回更新后会话。
   *
   * 降级（FR-2.4）：TitleGenerator 抛错/超时 → catch → RuntimeLog.append(warn) → 返回原会话，
   * 保持原标题、原 origin 不变，不写库、不外抛、绝不把标题写成空/错误串。
   */
  async generateByAi(id: SessionId): Promise<ChatSession> {
    const current = await this.sessions.getById(id);
    if (current === undefined) {
      throw new Error(`SetSessionTitleService.generateByAi：会话不存在（id=${id}）。`);
    }

    // user 态不被 ai 覆盖：早退，连 TitleGenerator 都不调。
    if (current.titleOrigin === 'user') {
      return current;
    }

    try {
      // 从 prompt 视图投影出 recentMessages 纯文本片段（C1 只喂投影文本，不拼提示词）。
      const promptView = await this.history.getPromptView({ sessionId: id });
      const input: TitleGenerationInput = {
        sessionId: id,
        recentMessages: promptView.map((message) => ({
          role: message.role,
          text: message.content.toPlainText(),
        })),
      };

      const title = await this.titleGenerator.generateTitle(input);

      // 空/纯空白标题守卫（反假数据）：TitleGenerator 即便「成功」返回空串/空白，
      // 也不得写入脏空标题——视同生成失败走降级，保留原标题、记 warn。
      // 端口未承诺非空返回，故由 C1 侧兜底。
      if (title.trim() === '') {
        this.runtimeLog.append({
          level: 'warn',
          source: 'c1.title',
          message: `AI 标题生成返回空标题，保留原标题（sessionId=${id}）。`,
        });
        return current;
      }

      // canOverrideTitle 放行才写（current ∈ {default, ai} 时对 'ai' 恒放行）。
      if (!canOverrideTitle(current.titleOrigin, 'ai')) {
        return current;
      }
      await this.sessions.setTitle(id, title, 'ai');
      return { ...current, title, titleOrigin: 'ai' };
    } catch (error) {
      // 降级（FR-2.4）：生成失败/超时不外抛、不写库、保持原标题与原 origin，仅记一条 warn。
      const reason = error instanceof Error ? error.message : String(error);
      this.runtimeLog.append({
        level: 'warn',
        source: 'c1.title',
        message: `AI 标题生成失败，保留原标题（sessionId=${id}）：${reason}`,
      });
      return current;
    }
  }
}
