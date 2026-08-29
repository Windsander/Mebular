# Obsidian vault 端（obsidian-vault）

Mebular 跨端互通的笔记生态参考：一个标准 Obsidian vault（根目录带
`.obsidian/`），不依赖 Mebular 运行时，只约定目录形态与 markdown 语法。

## 数据形态

```
vault/
  .obsidian/            # 形态识别标记（内容不重要）
  Projects/Mebular.md   # 含 wiki-link 的笔记
  Concepts/GraphStore.md
  Daily/2026-08-28.md   # 含 YAML frontmatter 的日记
```

## 映射规则

| Obsidian 结构 | Mebular 节点/边 |
| --- | --- |
| 每篇笔记 | Entity：entityType=`other`，name=首个 H1 或文件名；`properties.path` 记库内相对路径 |
| 笔记内列表条目 | Fact：谓词取小节标题（无小节则 `note`），经 `source_of` 边挂到笔记实体 |
| `[[目标]]` / `[[目标\|别名]]` | 笔记实体间的 `related_to` 边 |
| YAML frontmatter | 不做 YAML 解析，原文整块存 `properties.frontmatter` |

## wiki-link 解析与降级规则

1. 先按库内相对路径（去扩展名，如 `[[Daily/2026-08-28]]`）精确匹配；
2. 再按文件名匹配（如 `[[GraphStore]]` → `Concepts/GraphStore.md`），
   **仅当全库唯一**时成立——Obsidian 本身取最短匹配，本投影保守起见
   遇歧义不猜；
3. 匹配失败（含歧义）→ 降级为该笔记上的 `Fact(predicate='mentions')`，
   不产生悬空边；同一笔记内同一目标只记一条；
4. 围栏代码块内的 `[[...]]` 不视为链接（代码示例不是关系）；
5. 自链接直接忽略（自环边无语义增量）。

## 导出（CMF → markdown 投影）

`ObsidianVaultAdapter.export()` 把图中本端导入的节点（`obsidian-import`
标签）投影为 CMF；`renderMarkdown(doc)` 进一步渲染回 vault 文件形态
（路径 → markdown 文本）：条目按谓词分小节、`related_to` 边渲染为
`## 链接` 小节的 wiki-link、frontmatter 原文回填。`mentions` 降级标记
不回写正文。

互通链路：`ObsidianVaultAdapter` → CMF（`src/exchange/cmf.ts`）→ 适配器
框架幂等落图（`src/exchange/adapter.ts`）→ 图同步收敛到其他端。

`vault/` 是样例库；集成测试见 `tests/exchange/`。
