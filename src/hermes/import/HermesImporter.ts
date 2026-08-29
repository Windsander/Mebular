// Hermes 既有记忆导入器（phase-4-plan 4.4）
//
// 把 Hermes 侧的既有记忆落进类型化记忆层：
// - MEMORY.md / USER.md  → Entity（文档主体）+ Fact（列表条目，谓词取小节标题）
// - skills/<dir>/SKILL.md → Skill（名称/描述/步骤/命令）
// - sessions/*.json（HermesSessionData）→ Episode(conversation)
//
// 幂等设计：每条导入产物带 `import:hermes:<sha256>` 标签作为去重键（Phase 6.1
// 层级规范），随图同步——重复导入、跨设备导入均不产生重复节点；读取侧兼容
// 既有图的旧格式 `import:<sha256>` 键（双读过渡）。文档/技能节点以「路径」为身份
// （内容变化不新建节点，导入器不做更新语义）；条目/会话以「内容」为身份
// （新增条目可增量导入，删除的条目按 append-only 记忆语义保留）。
// 文档实体与条目/技能/会话之间接 source_of 边，保留出处链路。

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MemoryStore } from '../../memory/MemoryStore.js';
import { EdgeTypes, type EntityType } from '../../memory/types.js';
import type { Node } from '../../types/index.js';
import { ValidationError } from '../../errors.js';
import { importLabel, toLegacyImportLabel } from '../../exchange/import-keys.js';
import type { HermesSessionData } from '../types.js';
import { parseMarkdown } from './markdown.js';

/** 单条导入结果：节点 ID + 是否本次新建（false 即幂等命中） */
export interface ImportItem {
  id: string;
  created: boolean;
}

export interface ImportReport {
  entities: ImportItem[];
  facts: ImportItem[];
  episodes: ImportItem[];
  skills: ImportItem[];
  /** 幂等命中（跳过创建）的条目数 */
  skipped: number;
}

export interface HermesImporterOptions {
  /** USER.md 实体名锚点（与 HermesMemoryProvider.getUserProfile 对齐，缺省 'user'） */
  userId?: string;
}

function emptyReport(): ImportReport {
  return { entities: [], facts: [], episodes: [], skills: [], skipped: 0 };
}

function mergeReport(target: ImportReport, part: ImportReport): ImportReport {
  target.entities.push(...part.entities);
  target.facts.push(...part.facts);
  target.episodes.push(...part.episodes);
  target.skills.push(...part.skills);
  target.skipped += part.skipped;
  return target;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class HermesImporter {
  private readonly memory: MemoryStore;
  private readonly userId: string;

  constructor(memory: MemoryStore, options: HermesImporterOptions = {}) {
    this.memory = memory;
    this.userId = options.userId ?? 'user';
  }

  // ---------- 单文件导入 ----------

  /** MEMORY.md / USER.md → 文档实体 + 条目事实 */
  async importMarkdownFile(filePath: string): Promise<ImportReport> {
    const report = emptyReport();
    const text = await readFile(filePath, 'utf-8');
    const parsed = parseMarkdown(text);
    const stem = basename(filePath).replace(/\.md$/i, '');
    const isUserDoc = stem.toLowerCase() === 'user';
    const entityType: EntityType = isUserDoc ? 'user' : 'other';
    const entityName = isUserDoc ? this.userId : (parsed.title ?? stem);

    // 文档实体：路径级身份（内容变化不新建节点）
    const entityLabel = this.importKey(filePath, entityName);
    let entity = await this.findByLabel(entityLabel);
    let entityCreated = false;
    if (!entity) {
      entity = await this.memory.addEntity({
        entityType,
        name: entityName,
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        properties: { source: filePath, format: 'markdown' },
        tags: ['hermes-import'],
        labels: [entityLabel],
      });
      entityCreated = true;
    }
    report.entities.push({ id: entity.id, created: entityCreated });
    if (!entityCreated) report.skipped += 1;

    // 条目事实：内容级身份（新增条目可增量导入）
    for (const section of parsed.sections) {
      const predicate = section.heading ?? 'note';
      for (const itemText of section.items) {
        const factLabel = this.importKey(filePath, itemText);
        let fact = await this.findByLabel(factLabel);
        let factCreated = false;
        if (!fact) {
          fact = await this.memory.addFact({
            subject: entityName,
            predicate,
            object: itemText,
            source: filePath,
            tags: ['hermes-import'],
            labels: [factLabel],
          });
          factCreated = true;
        }
        report.facts.push({ id: fact.id, created: factCreated });
        if (!factCreated) {
          report.skipped += 1;
        } else {
          // 出处边只在事实新建时补（既有事实的边在首次导入时已建）
          await this.memory.getGraph().createEdge(entity.id, fact.id, EdgeTypes.SOURCE_OF);
        }
      }
    }
    return report;
  }

  /** skills 目录 → 每个子目录的 SKILL.md（或散置的 .md）→ Skill 节点 */
  async importSkillsDirectory(dirPath: string): Promise<ImportReport> {
    const report = emptyReport();
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      let skillFile: string | null = null;
      let fallbackName: string;
      if (entry.isDirectory()) {
        const candidate = join(dirPath, entry.name, 'SKILL.md');
        if (await pathExists(candidate)) {
          skillFile = candidate;
        }
        fallbackName = entry.name;
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        skillFile = join(dirPath, entry.name);
        fallbackName = entry.name.replace(/\.md$/i, '');
      } else {
        continue;
      }
      if (!skillFile) {
        continue;
      }

      const text = await readFile(skillFile, 'utf-8');
      const parsed = parseMarkdown(text);
      // 技能节点：路径级身份
      const skillLabel = this.importKey(skillFile, fallbackName);
      const existing = await this.findByLabel(skillLabel);
      if (existing) {
        report.skills.push({ id: existing.id, created: false });
        report.skipped += 1;
        continue;
      }
      const steps = parsed.sections.flatMap((s) => s.items);
      const commands = parsed.codeBlocks.map((block) => block.trim()).filter((c) => c !== '');
      const skill = await this.memory.addSkill({
        name: parsed.title ?? fallbackName,
        description: parsed.description ?? (parsed.title ?? fallbackName),
        category: 'imported',
        ...(steps.length ? { steps } : {}),
        ...(commands.length ? { commands } : {}),
        tags: ['hermes-import'],
        labels: [skillLabel],
      });
      report.skills.push({ id: skill.id, created: true });
    }
    return report;
  }

  /** 单份会话数据 → Episode(conversation) */
  async importSession(session: HermesSessionData): Promise<ImportReport> {
    const report = emptyReport();
    const transcript = session.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    // 会话：会话 ID 级身份（同一会话重复导入不重复建情节）
    const episodeLabel = this.importKey('session', session.sessionId);
    const existing = await this.findByLabel(episodeLabel);
    if (existing) {
      report.episodes.push({ id: existing.id, created: false });
      report.skipped += 1;
      return report;
    }
    const episode = await this.memory.addEpisode({
      episodeType: 'conversation',
      title: `会话 ${session.sessionId}`,
      content: transcript,
      contentHash: sha256(transcript),
      startTime: session.startTime,
      ...(session.endTime !== undefined ? { endTime: session.endTime } : {}),
      context: session.sessionId,
      tags: ['hermes-import'],
      labels: [episodeLabel],
    });
    report.episodes.push({ id: episode.id, created: true });
    return report;
  }

  /** sessions 目录：逐个读入 HermesSessionData JSON 文件 */
  async importSessionsDirectory(dirPath: string): Promise<ImportReport> {
    const report = emptyReport();
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.json$/i.test(entry.name)) {
        continue;
      }
      const filePath = join(dirPath, entry.name);
      let session: HermesSessionData;
      try {
        session = JSON.parse(await readFile(filePath, 'utf-8')) as HermesSessionData;
      } catch (cause) {
        throw new ValidationError(`会话文件解析失败：${filePath}`, { filePath, cause });
      }
      if (typeof session.sessionId !== 'string' || !Array.isArray(session.messages)) {
        throw new ValidationError(`会话文件缺少 sessionId/messages：${filePath}`, { filePath });
      }
      mergeReport(report, await this.importSession(session));
    }
    return report;
  }

  // ---------- 整树导入 ----------

  /** Hermes 目录树约定：MEMORY.md / USER.md / skills/ / sessions/（缺失部分自动跳过） */
  async importHermesDirectory(root: string): Promise<ImportReport> {
    const report = emptyReport();
    for (const doc of ['MEMORY.md', 'USER.md']) {
      const filePath = join(root, doc);
      if (await pathExists(filePath)) {
        mergeReport(report, await this.importMarkdownFile(filePath));
      }
    }
    const skillsDir = join(root, 'skills');
    if (await pathExists(skillsDir)) {
      mergeReport(report, await this.importSkillsDirectory(skillsDir));
    }
    const sessionsDir = join(root, 'sessions');
    if (await pathExists(sessionsDir)) {
      mergeReport(report, await this.importSessionsDirectory(sessionsDir));
    }
    return report;
  }

  // ---------- 内部 ----------

  /** 去重键（新格式）：import:hermes:<sha256(source + 内容)>，作为节点 label 随图同步 */
  private importKey(source: string, content: string): string {
    return importLabel('hermes', sha256(`${source}\n${content}`));
  }

  /** 双读（Phase 6.1）：先查新格式键，miss 时回退既有图上的旧格式 import:<digest> */
  private async findByLabel(label: string): Promise<Node | null> {
    const direct = await this.memory.getGraph().listNodes({ labels: [label], limit: 1 });
    if (direct[0]) {
      return direct[0];
    }
    const legacy = toLegacyImportLabel(label);
    if (!legacy) {
      return null;
    }
    const hits = await this.memory.getGraph().listNodes({ labels: [legacy], limit: 1 });
    return hits[0] ?? null;
  }
}
