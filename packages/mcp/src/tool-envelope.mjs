// 工具结果信封（R3.3）：成功 = content + structuredContent；失败 = isError + structuredContent.error{code,message}。
//
// 记忆面与任务面**共用**同一信封（`json` / `fail` / `codeFor`），并被 MCP 适配器、`mebular <tool>` CLI
// 与任务工具复用；错误码为机器可判定（E_INPUT / E_NOT_FOUND / E_CONFLICT / E_INTERNAL）。

/** 成功信封：content[0].text = JSON，structuredContent = 原对象（CLI 直接取 structuredContent）。 */
export function json(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/** 失败码 → 判据（从错误文本推断；显式 code 优先）。 */
export function codeFor(message) {
  const text = String(message ?? '');
  if (/不存在|未找到|not found|ENOENT|unknown|未知/.test(text)) return 'E_NOT_FOUND';
  if (/已存在|冲突|占用|锁定|locked|conflict|already|重复|过期|expired/.test(text)) return 'E_CONFLICT';
  if (/必须|必填|需要|缺少|非法|无效|invalid|requires|must|missing|格式|形状|超出/.test(text)) return 'E_INPUT';
  return 'E_INTERNAL';
}

/** 失败信封：`{ isError:true, content:[{type:'text',text}], structuredContent:{ ok:false, error:{ code, message } } }` */
export function fail(message, code) {
  const text = String(message ?? 'error');
  const resolved = typeof code === 'string' && code.length > 0 ? code : codeFor(text);
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: { ok: false, error: { code: resolved, message: text } },
  };
}

/**
 * Standard Schema 适配器：把 fleet 的 JSON Schema 直接交给 MCP SDK（tools/list 广告用），
 * 校验交给工具 handler 自身（其错误消息已可读）——避免为 16 个任务工具再抄一份 zod 形状。
 */
export function jsonSchemaAdapter(schema) {
  return {
    '~standard': {
      version: 1,
      vendor: 'mebular-json-schema',
      validate: (value) => ({ value }),
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  };
}
