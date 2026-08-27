# JSON 备忘录端（json-memo）

Mebular 跨端互通的最小异构端参考：一个只有 JSON 文件的备忘录应用，
不依赖 Mebular 运行时，只约定数据格式。

## 数据格式

```json
{
  "memos": [
    { "text": "纯文本备忘 → Fact(predicate=memo)", "createdAt": 1756339200000 },
    { "title": "带标题的备忘", "text": "标题+正文 → Episode(observation)" }
  ]
}
```

## 映射规则

| json-memo 条目 | Mebular 节点 |
| --- | --- |
| 只有 `text` | Fact：subject=来源端名，predicate=`memo`，object=text |
| 有 `title` | Episode：episodeType=`observation`，title/content/context 对齐 |

互通链路：`JsonMemoAdapter` → CMF（`src/exchange/cmf.ts`）→ 适配器框架
幂等落图（`src/exchange/adapter.ts`）→ 图同步收敛到其他端。

`data/memos.json` 是样例数据；集成测试见 `tests/exchange/`。
