// Test-only DSH probe plugin.
//
// Two jobs, both through DSH's own registry (never a direct /mcp call):
//   1. read ctx.tools.schemas() and prove the Mebular MCP tools were registered;
//   2. invoke one read-only Mebular tool through ctx.tools.execute() and prove
//      the answer contains the token seeded into the temporary Mebular home.
//
// The result is written as JSON to PROBE_OUT. The file is updated while the
// harness waits, so a crash still leaves the last observed state on disk.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const name = '@mebular/dsh-e2e-probe';
export const inject = ['tools'];

const REQUIRED_TOOLS = [
  'mcp__mebular__memory_write',
  'mcp__mebular__memory_query',
];
const READ_ONLY_PREFERENCE = [
  'mcp__mebular__memory_query',
  'mcp__mebular__memory_status',
];
const TERMINAL_LIMIT_MS = 120000;

function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

export function apply(ctx, config = {}) {
  const out = typeof process.env.PROBE_OUT === 'string' && process.env.PROBE_OUT.length > 0
    ? process.env.PROBE_OUT
    : null;
  if (out === null) {
    try { ctx.logger?.warn?.('@mebular/dsh-e2e-probe: PROBE_OUT is not set'); } catch { /* ignore */ }
    return;
  }

  const timeoutMs = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0
    ? Math.min(config.timeoutMs, TERMINAL_LIMIT_MS)
    : TERMINAL_LIMIT_MS;
  const query = typeof process.env.PROBE_QUERY === 'string' && process.env.PROBE_QUERY.length > 0
    ? process.env.PROBE_QUERY
    : 'DSH E2E';

  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  let timer = null;
  let done = false;
  let invocationStarted = false;
  const state = {
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    done: false,
    timedOut: false,
    schemaCount: 0,
    schemas: [],
    required: Object.fromEntries(REQUIRED_TOOLS.map((tool) => [tool, false])),
    missingRequired: [...REQUIRED_TOOLS],
    invocation: null,
    error: null,
  };

  function persist() {
    state.updatedAt = new Date().toISOString();
    state.done = done;
    try {
      writeJson(out, state);
    } catch (error) {
      try { ctx.logger?.warn?.(`@mebular/dsh-e2e-probe: write failed (${error?.code ?? 'error'})`); } catch { /* ignore */ }
    }
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function invokeReadTool(available) {
    const tool = READ_ONLY_PREFERENCE.find((candidate) => available.has(candidate));
    if (tool === undefined) return;
    invocationStarted = true;
    const argumentsValue = tool === 'mcp__mebular__memory_query'
      ? { query, limit: 10 }
      : {};
    const invocation = {
      tool,
      arguments: argumentsValue,
      startedAt: new Date().toISOString(),
      ok: false,
      isError: null,
      text: '',
      error: null,
    };
    state.invocation = invocation;
    try {
      const result = await ctx.tools.execute({
        callId: `dsh-e2e-probe-${Date.now()}`,
        name: tool,
        arguments: argumentsValue,
        signal: AbortSignal.timeout(30000),
      });
      invocation.isError = result?.isError === true;
      invocation.text = resultText(result);
      invocation.structuredContent = result?.structuredContent ?? null;
      invocation.ok = invocation.isError === false;
      if (!invocation.ok) {
        invocation.error = result?.error?.message
          ?? result?.error?.info?.name
          ?? 'tool returned isError';
      }
    } catch (error) {
      invocation.error = String(error?.message ?? error);
    } finally {
      invocation.finishedAt = new Date().toISOString();
      state.error = invocation.ok ? null : invocation.error;
      done = true;
      persist();
      stop();
    }
  }

  async function tick() {
    if (done) return;
    try {
      const schemas = ctx.tools.schemas();
      const list = Array.isArray(schemas) ? schemas : [];
      const available = new Set(list.map((schema) => schema?.name).filter((value) => typeof value === 'string'));
      state.schemaCount = available.size;
      state.schemas = list
        .map((schema) => ({
          name: schema?.name ?? null,
          description: typeof schema?.description === 'string' ? schema.description.slice(0, 240) : null,
        }))
        .filter((schema) => typeof schema.name === 'string');
      for (const tool of REQUIRED_TOOLS) state.required[tool] = available.has(tool);
      state.missingRequired = REQUIRED_TOOLS.filter((tool) => !available.has(tool));
      persist();

      if (state.missingRequired.length === 0 && !invocationStarted) {
        await invokeReadTool(available);
        return;
      }
      if (Date.now() >= deadline) {
        done = true;
        state.timedOut = true;
        state.error = invocationStarted ? state.error : 'required_tools_not_registered';
        persist();
        stop();
      }
    } catch (error) {
      done = true;
      state.error = String(error?.message ?? error);
      persist();
      stop();
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => stop(), '@mebular/dsh-e2e-probe: timer');
  }

  persist();
  timer = setInterval(() => { void tick(); }, 1000);
  timer.unref?.();
  void tick();
}
