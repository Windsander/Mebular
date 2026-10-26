// Test-only DSH probe plugin.
//
// Jobs, all through DSH's own registry (never a direct /mcp call):
//   1. read ctx.tools.schemas() and record the Mebular tools DSH registered;
//   2. invoke one read-only Mebular tool through ctx.tools.execute() and prove
//      the answer contains the token seeded into the temporary Mebular home;
//   3. for the recovery scenario, record the down -> up -> down -> up
//      transitions without restarting DSH.
//
// PROBE_EXPECT controls the state machine:
//   up      wait for required tools, invoke once, finish
//   down    observe three polls, record whether Mebular tools are absent
//   recover wait for tools, then absence, then re-registration, then invoke
//
// The result is written as JSON to PROBE_OUT on every change. The file is
// updated while the harness waits, so a crash still leaves the last observed
// state on disk.

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
const DEFAULT_TIMEOUT_MS = 180000;
const HISTORY_LIMIT = 100;
const PREFIX = 'mcp__mebular__';

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
    .join('\n');
}

function expectedMode() {
  const value = String(process.env.PROBE_EXPECT ?? 'up').trim().toLowerCase();
  return value === 'down' || value === 'recover' ? value : 'up';
}

export function apply(ctx, config = {}) {
  const out = typeof process.env.PROBE_OUT === 'string' && process.env.PROBE_OUT.length > 0
    ? process.env.PROBE_OUT
    : null;
  if (out === null) {
    try { ctx.logger?.warn?.('@mebular/dsh-e2e-probe: PROBE_OUT is not set'); } catch { /* ignore */ }
    return;
  }

  const configuredTimeout = Number(process.env.PROBE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : (Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS);
  const expect = expectedMode();
  const query = typeof process.env.PROBE_QUERY === 'string' && process.env.PROBE_QUERY.length > 0
    ? process.env.PROBE_QUERY
    : 'DSH E2E';

  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  let timer = null;
  let done = false;
  let invocationStarted = false;
  let phase = expect === 'recover' ? 'awaiting-tools' : expect === 'down' ? 'observing-down' : 'awaiting-tools';
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  let pollCount = 0;
  let lastShape = null;

  const state = {
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    expect,
    phase,
    done: false,
    timedOut: false,
    pollCount: 0,
    schemaCount: 0,
    mebularToolCount: 0,
    mebularTools: [],
    schemas: [],
    required: Object.fromEntries(REQUIRED_TOOLS.map((tool) => [tool, false])),
    missingRequired: [...REQUIRED_TOOLS],
    observedDown: null,
    firstUpAt: null,
    downAt: null,
    recoveredAt: null,
    history: [],
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

  function finishWith(error) {
    done = true;
    state.phase = 'done';
    state.error = error ?? null;
    persist();
    stop();
  }

  function recordHistory(shape) {
    if (shape === lastShape) return;
    lastShape = shape;
    state.history.push({
      at: new Date().toISOString(),
      phase,
      mebularToolCount: state.mebularToolCount,
      required: { ...state.required },
    });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
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
      finishWith(invocation.ok ? null : invocation.error);
    }
  }

  async function tick() {
    if (done || invocationStarted) return;
    pollCount += 1;
    state.pollCount = pollCount;
    try {
      const schemas = ctx.tools.schemas();
      const list = Array.isArray(schemas) ? schemas : [];
      const names = list
        .map((schema) => (typeof schema?.name === 'string' ? schema.name : null))
        .filter((value) => value !== null);
      const available = new Set(names);
      state.schemaCount = available.size;
      state.schemas = list
        .map((schema) => ({
          name: schema?.name ?? null,
          description: typeof schema?.description === 'string' ? schema.description.slice(0, 240) : null,
        }))
        .filter((schema) => typeof schema.name === 'string');
      state.mebularTools = names.filter((value) => value.startsWith(PREFIX));
      state.mebularToolCount = state.mebularTools.length;
      for (const tool of REQUIRED_TOOLS) state.required[tool] = available.has(tool);
      state.missingRequired = REQUIRED_TOOLS.filter((tool) => !available.has(tool));

      const hasRequired = state.missingRequired.length === 0;
      consecutiveUp = hasRequired ? consecutiveUp + 1 : 0;
      consecutiveDown = state.mebularToolCount === 0 ? consecutiveDown + 1 : 0;

      if (expect === 'down') {
        if (pollCount >= 3) {
          state.observedDown = state.mebularToolCount === 0;
          finishWith(state.observedDown ? null : 'mebular_tools_present_while_down');
          return;
        }
      } else if (expect === 'up') {
        if (consecutiveUp >= 2) {
          phase = 'up-observed';
          state.phase = phase;
          recordHistory(`up:${state.mebularToolCount}`);
          persist();
          await invokeReadTool(available);
          return;
        }
      } else if (phase === 'awaiting-tools') {
        if (consecutiveUp >= 2) {
          phase = 'awaiting-down';
          state.phase = phase;
          state.firstUpAt = new Date().toISOString();
        }
      } else if (phase === 'awaiting-down') {
        if (consecutiveDown >= 2) {
          phase = 'awaiting-recovery';
          state.phase = phase;
          state.downAt = new Date().toISOString();
        }
      } else if (phase === 'awaiting-recovery') {
        if (consecutiveUp >= 2) {
          phase = 'recovered';
          state.phase = phase;
          state.recoveredAt = new Date().toISOString();
          recordHistory(`recovered:${state.mebularToolCount}`);
          persist();
          await invokeReadTool(available);
          return;
        }
      }

      state.phase = phase;
      recordHistory(`${phase}:${state.mebularToolCount}:${hasRequired}`);
      persist();

      if (Date.now() >= deadline) {
        const error = expect === 'down'
          ? 'down_observation_incomplete'
          : (!invocationStarted ? 'required_tools_not_registered' : 'recovery_incomplete');
        done = true;
        state.timedOut = true;
        state.phase = 'timeout';
        state.error = error;
        persist();
        stop();
      }
    } catch (error) {
      finishWith(String(error?.message ?? error));
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
