// HermesMemoryProvider（spec-004 Hermes 集成接口 / phase-4-plan 4.2）
//
// G6.1 / D33：本类降为**进程内薄壳**——检索/写入逻辑统一在 `MemoryService`，
// 这里只做 Hermes 面的委托；对外方法签名与行为保持不变。
// `extractMemory` 仍留在此处（浅抽取 + LLM 深抽取接缝，不触碰存储）。

import type { Mebular } from '../mebular.js';
import { MemoryService } from '../memory/MemoryService.js';
import type { VectorIndex } from '../memory/VectorIndex.js';
import { ErrorCodes, MebularError } from '../errors.js';
import type { ExtractionResult, HermesSessionData, MemoryExtractor, MemoryInput } from './types.js';
import type {
  ConversationFilters,
  ConversationHistory,
  MemoryQuery,
  RetrievalResult,
  SearchQuery,
  SearchResult,
  Skill,
  SkillFilter,
  StoredMemory,
  UserProfile,
} from './types.js';

export interface HermesMemoryProviderOptions {
  /** 用户实体名（preference/profile 的主体锚点，缺省 'user'） */
  userId?: string;
  /** 深抽取策略（LLM 在 Hermes 侧）；注入后与浅抽取结果合并 */
  extractor?: MemoryExtractor;
  /** 向量索引（可插拔；缺省回落到门面 semantic 索引） */
  vectorIndex?: VectorIndex;
}

export class HermesMemoryProvider {
  private readonly service: MemoryService;
  private readonly extractor: MemoryExtractor | null;

  constructor(mebular: Mebular, options: HermesMemoryProviderOptions = {}) {
    this.service = new MemoryService(mebular, {
      userId: options.userId,
      vectorIndex: options.vectorIndex,
    });
    this.extractor = options.extractor ?? null;
  }

  /** 底层 MemoryService（G6 单一实现；MCP/其他面复用） */
  getService(): MemoryService {
    return this.service;
  }

  // ---------- 抽取 ----------

  /** 浅抽取：会话 → Episode 原文；注入 extractor 时合并其结构化结果 */
  async extractMemory(sessionData: HermesSessionData): Promise<ExtractionResult> {
    const transcript = sessionData.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const result: ExtractionResult = {
      facts: [],
      episodes: transcript
        ? [{
            episodeType: 'conversation',
            title: `会话 ${sessionData.sessionId}`,
            content: transcript,
            startTime: sessionData.startTime,
            endTime: sessionData.endTime,
            context: sessionData.sessionId,
          }]
        : [],
      skills: [],
      preferences: [],
      observations: [],
    };

    if (this.extractor) {
      const deep = await this.extractor(sessionData);
      result.facts.push(...(deep.facts ?? []));
      result.episodes.push(...(deep.episodes ?? []));
      result.skills.push(...(deep.skills ?? []));
      result.preferences.push(...(deep.preferences ?? []));
      result.observations.push(...(deep.observations ?? []));
    }

    return result;
  }

  /** 把抽取结果落图（extractMemory 的配套写入路径） */
  async storeExtraction(result: ExtractionResult): Promise<StoredMemory[]> {
    return this.service.storeExtraction(result);
  }

  // ---------- 写入 ----------

  async storeMemory(input: MemoryInput): Promise<StoredMemory> {
    const [stored] = await this.service.write([input]);
    if (!stored) {
      throw new MebularError('记忆写入未返回结果', ErrorCodes.VALIDATION_INVALID_NODE);
    }
    return stored;
  }

  // ---------- 检索 ----------

  async retrieveMemory(query: MemoryQuery): Promise<RetrievalResult> {
    return this.service.query(query);
  }

  async searchMemory(query: SearchQuery): Promise<SearchResult> {
    return this.service.search(query);
  }

  // ---------- 画像 / 技能 / 历史 ----------

  async getUserProfile(): Promise<UserProfile> {
    return this.service.profile();
  }

  async getSkills(filter?: SkillFilter): Promise<Skill[]> {
    return this.service.skills(filter);
  }

  async getConversationHistory(filters: ConversationFilters): Promise<ConversationHistory> {
    return this.service.history(filters);
  }
}
