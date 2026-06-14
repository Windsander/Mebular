// 规则化 Markdown 解析（零依赖，phase-4-plan 4.4）
//
// 面向 Hermes 既有记忆文件（MEMORY.md / USER.md / SKILL.md）的保守解析：
// 只提取标题层级、列表条目、段落与围栏代码块，不追求完整 CommonMark。

export interface MarkdownSection {
  /** 最近一级标题文本（条目归属；无标题条目挂在 undefined 节） */
  heading?: string;
  /** 列表条目（- / * / + / 有序）原文 */
  items: string[];
}

export interface ParsedMarkdown {
  /** 首个 H1 标题（缺省 undefined，由调用方退回文件名） */
  title?: string;
  /** 首个非标题、非列表、非代码块的段落（作为描述） */
  description?: string;
  /** 列表条目按小节归组（标题路径只取最近一级，保持扁平） */
  sections: MarkdownSection[];
  /** 围栏代码块的全部内容行（技能 commands 来源） */
  codeBlocks: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const CODE_FENCE_RE = /^\s*```/;

export function parseMarkdown(text: string): ParsedMarkdown {
  const result: ParsedMarkdown = { sections: [], codeBlocks: [] };
  let current: MarkdownSection | undefined;
  let inCode = false;
  let codeLines: string[] = [];

  const currentSection = (): MarkdownSection => {
    if (!current) {
      current = { items: [] };
      result.sections.push(current);
    }
    return current;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    if (CODE_FENCE_RE.test(line)) {
      if (inCode) {
        result.codeBlocks.push(codeLines.join('\n'));
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const headingText = (heading[2] ?? '').trim();
      if (line.startsWith('# ') && result.title === undefined) {
        result.title = headingText;
      }
      current = { heading: headingText, items: [] };
      result.sections.push(current);
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      const text = (item[1] ?? '').trim();
      if (text) {
        currentSection().items.push(text);
      }
      continue;
    }

    if (result.description === undefined && line.trim() !== '') {
      result.description = line.trim();
    }
  }

  if (inCode && codeLines.length) {
    // 未闭合围栏：宽容处理，仍计入（导入场景宁多勿丢）
    result.codeBlocks.push(codeLines.join('\n'));
  }

  // 去掉既无条目也无标题占位意义的空节（例如文档开头标题前的隐式节）
  result.sections = result.sections.filter(
    (s) => s.items.length > 0 || s.heading !== undefined,
  );
  return result;
}
