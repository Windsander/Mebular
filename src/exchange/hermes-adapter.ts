// Hermes 目录适配器（phase-5-plan 5.4）
//
// 把 Hermes 目录约定（MEMORY.md / USER.md / skills/ / sessions/）投影为
// CMF 文档，映射语义与 Phase 4 HermesImporter 保持一致：
// - MEMORY.md / USER.md → Entity（文档主体）+ Fact（条目，谓词取小节标题）
// - skills/<dir>/SKILL.md 或散置 .md → Skill
// - sessions/*.json → Episode(conversation)
// - 出处链：条目/技能/会话与文档实体之间接 source_of 边
//
// 与 HermesImporter 的分工：Importer 面向本地 Hermes 目录直写（Phase 4
// 行为不变）；本适配器面向跨端互通——产出 CMF 投影，幂等由适配器框架的
// 跨端去重键统一承载（import:<sha256> 标签，含适配器名与来源端标识）。

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseMarkdown } from '../hermes/import/markdown.js';
import type { HermesSessionData } from '../hermes/types.js';
import { EdgeTypes } from '../memory/types.js';
import { MebularError } from '../errors.js';
import type { AdapterSource, MemoryAdapter } from './adapter.js';
import type { CmfDocument, CmfEdge, CmfNode } from './cmf.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export class HermesAdapter implements MemoryAdapter {
  readonly name = 'hermes';

  detect(source: AdapterSource): number {
    if (source.kind === 'hermes' || source.kind === 'hermes-dir') return 1;
    if (source.kind === undefined && typeof source.data === 'string') {
      // 目录形态识别：存在 MEMORY.md 即视为 Hermes 目录
      if (existsSync(join(source.data, 'MEMORY.md'))) return 0.8;
    }
    return 0;
  }

  async import(source: AdapterSource, _ctx?: import("./adapter.js").AdapterContext): Promise<CmfDocument> {
    if (typeof source.data !== 'string') {
      throw new TypeError('hermes 适配器只接受目录路径字符串');
    }
    const root = source.data;
    const nodes: CmfNode[] = [];
    const edges: CmfEdge[] = [];

    for (const docName of ['MEMORY.md', 'USER.md']) {
      const filePath = join(root, docName);
      if (existsSync(filePath)) {
        await this.projectMarkdown(filePath, nodes, edges);
      }
    }
    const skillsDir = join(root, 'skills');
    if (existsSync(skillsDir)) {
      await this.projectSkills(skillsDir, nodes);
    }
    const sessionsDir = join(root, 'sessions');
    if (existsSync(sessionsDir)) {
      await this.projectSessions(sessionsDir, nodes);
    }

    return { format: 'cmf', version: 1, exportedAt: Date.now(), nodes, edges };
  }

  // ---------- 映射（语义对齐 HermesImporter） ----------

  private async projectMarkdown(
    filePath: string,
    nodes: CmfNode[],
    edges: CmfEdge[],
  ): Promise<void> {
    const text = await readFile(filePath, 'utf-8');
    const parsed = parseMarkdown(text);
    const stem = basename(filePath).replace(/\.md$/i, '');
    const isUserDoc = stem.toLowerCase() === 'user';
    const entityName = isUserDoc ? 'user' : (parsed.title ?? stem);

    const entityId = `doc:${stem}`;
    nodes.push({
      id: entityId,
      type: 'entity',
      content: {
        entityType: isUserDoc ? 'user' : 'other',
        name: entityName,
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        properties: { source: filePath, format: 'markdown' },
      },
      tags: ['hermes-import'],
    });

    let index = 0;
    for (const section of parsed.sections) {
      const predicate = section.heading ?? 'note';
      for (const itemText of section.items) {
        const factId = `${entityId}:item-${index}`;
        nodes.push({
          id: factId,
          type: 'fact',
          content: { subject: entityName, predicate, object: itemText, source: filePath },
          tags: ['hermes-import'],
        });
        edges.push({ source: entityId, target: factId, relation: EdgeTypes.SOURCE_OF });
        index += 1;
      }
    }
  }

  private async projectSkills(dirPath: string, nodes: CmfNode[]): Promise<void> {
    for (const entry of await readdir(dirPath, { withFileTypes: true })) {
      let skillFile: string | null = null;
      let fallbackName: string;
      if (entry.isDirectory()) {
        const candidate = join(dirPath, entry.name, 'SKILL.md');
        if (!existsSync(candidate)) continue;
        skillFile = candidate;
        fallbackName = entry.name;
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        skillFile = join(dirPath, entry.name);
        fallbackName = entry.name.replace(/\.md$/i, '');
      } else {
        continue;
      }

      const parsed = parseMarkdown(await readFile(skillFile, 'utf-8'));
      const steps = parsed.sections.flatMap((s) => s.items);
      const commands = parsed.codeBlocks.map((block) => block.trim()).filter((c) => c !== '');
      const name = parsed.title ?? fallbackName;
      nodes.push({
        id: `skill:${entry.name}`,
        type: 'skill',
        content: {
          name,
          description: parsed.description ?? name,
          category: 'imported',
          ...(steps.length ? { steps } : {}),
          ...(commands.length ? { commands } : {}),
        },
        tags: ['hermes-import'],
      });
    }
  }

  private async projectSessions(dirPath: string, nodes: CmfNode[]): Promise<void> {
    for (const entry of await readdir(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
      const filePath = join(dirPath, entry.name);
      let session: HermesSessionData;
      try {
        session = JSON.parse(await readFile(filePath, 'utf-8')) as HermesSessionData;
      } catch (error) {
        throw new MebularError(`会话文件解析失败：${filePath}`, 'CMF_FORMAT_INVALID', error as Error);
      }
      if (typeof session.sessionId !== 'string' || !Array.isArray(session.messages)) {
        throw new MebularError(`会话文件缺少 sessionId/messages：${filePath}`, 'CMF_FORMAT_INVALID');
      }
      const transcript = session.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
      nodes.push({
        id: `session:${session.sessionId}`,
        type: 'episode',
        content: {
          episodeType: 'conversation',
          title: `会话 ${session.sessionId}`,
          content: transcript,
          contentHash: sha256(transcript),
          startTime: session.startTime,
          ...(session.endTime !== undefined ? { endTime: session.endTime } : {}),
          context: session.sessionId,
        },
        tags: ['hermes-import'],
      });
    }
  }
}
