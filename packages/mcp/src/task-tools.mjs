// 任务面工具（R1/F-UNI）：把 `@mebular/fleet` 的 `TASK_TOOLS`（16 个，含 handler 与 JSON Schema）
// 适配为统一 MCP 工具面的规格——**不复制任何业务逻辑**：handler 直接用 fleet 的那一份，
// 守护本机 home 即工具上下文（fleet.config.json 或 config.json，见 fleet 的 loadToolConfig）。
//
// scope（R1.3）：读取类 task.read / 写入类 task.write。

import { TASK_TOOLS } from '@mebular/fleet';
import { homeDir } from './config.mjs';
import { json, fail, codeFor, jsonSchemaAdapter } from './tool-envelope.mjs';

/** 任务工具的 OAuth scope（R1.3 + 评审 H1）：由 fleet surface **逐工具显式声明**，不按名字推断。 */
export const TASK_TOOL_SCOPES = Object.fromEntries(
  TASK_TOOLS.map((tool) => [tool.name, tool.scope]),
);

/** 任务工具规格：与记忆面同形（name/title/description/inputSchema/handler(service,args)）。 */
export const TASK_TOOL_SPECS = TASK_TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.name,
  description: tool.description,
  inputSchema: jsonSchemaAdapter(tool.inputSchema),
  surface: 'task',
  handler: async (_service, args) => {
    try {
      const result = await tool.handler(args ?? {}, { dir: homeDir(), agent: 'board' });
      return json(result);
    } catch (error) {
      const message = String(error?.message ?? error);
      return fail(message, codeFor(message));
    }
  },
}));
