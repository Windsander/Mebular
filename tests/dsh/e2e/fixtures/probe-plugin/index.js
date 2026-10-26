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
// The probe also reads the live `mebular:status` system-prompt section through
// DSH's own `systemPrompt.assemble()` (never the DOM) and records its text plus
// a compact history. A section that is absent or empty means the prompt gains
// no Mebular tokens; non-empty text is the Agent-visible recovery hint.
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
const DEFAULT_AGENT_WAIT_MS = 15000;
const HISTORY_LIMIT = 100;
const PREFIX = 'mcp__mebular__';
const AGENT_SECTION = 'mebular:status';

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
  const configuredAgentWait = Number(process.env.PROBE_AGENT_WAIT_MS);
  const agentWaitMs = Number.isFinite(configuredAgentWait) && configuredAgentWait > 0
    ? configuredAgentWait
    : DEFAULT_AGENT_WAIT_MS;
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
  let lastAgentKey = null;
  let agentWaitStartedAt = null;
  let promptService = null;
  let promptError = null;

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
    agent: {
      supported: null,
      error: null,
      sectionPresent: false,
      sectionCount: 0,
      text: '',
      textLength: 0,
      at: null,
    },
    agentHistory: [],
    agentTimedOut: false,
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

  function capturePromptService(candidate) {
    const usable = candidate !== null
      && (typeof candidate === 'object' || typeof candidate === 'function')
      && typeof candidate.assemble === 'function';
    if (!usable) {
      promptError = 'system_prompt_service_unavailable';
      return false;
    }
    promptService = candidate;
    promptError = null;
    return true;
  }

  /**
   * Read the live Mebular system-prompt section through DSH's registry. The
   * text is the actual assembly input, not a DOM guess or a copy of the
   * plugin's internal expectation.
   */
  async function refreshAgentStatus() {
    const at = new Date().toISOString();
    if (promptService === null) {
      state.agent = {
        supported: promptError === null ? null : false,
        error: promptError,
        sectionPresent: false,
        sectionCount: 0,
        text: '',
        textLength: 0,
        at,
      };
      recordAgentHistory();
      return;
    }
    try {
      const assembly = await promptService.assemble();
      const sections = Array.isArray(assembly?.sections) ? assembly.sections : [];
      const section = sections.find((entry) => entry?.name === AGENT_SECTION);
      const text = typeof section?.text === 'string' ? section.text : '';
      state.agent = {
        supported: true,
        error: null,
        sectionPresent: section !== undefined,
        sectionCount: sections.length,
        text,
        textLength: text.trim().length,
        at,
      };
    } catch (error) {
      state.agent = {
        supported: true,
        error: `system_prompt_assemble_failed: ${String(error?.message ?? error).slice(0, 240)}`,
        sectionPresent: false,
        sectionCount: 0,
        text: '',
        textLength: 0,
        at,
      };
    }
    recordAgentHistory();
  }

  function recordAgentHistory() {
    const agent = state.agent ?? {};
    const key = [
      state.mebularToolCount,
      agent.supported,
      agent.error ?? '',
      agent.sectionPresent === true ? 1 : 0,
      agent.text ?? '',
    ].join('|');
    if (key === lastAgentKey) return;
    lastAgentKey = key;
    state.agentHistory.push({
      at: new Date().toISOString(),
      phase,
      mebularToolCount: state.mebularToolCount,
      supported: agent.supported ?? null,
      error: agent.error ?? null,
      sectionPresent: agent.sectionPresent === true,
      text: typeof agent.text === 'string' ? agent.text : '',
    });
    if (state.agentHistory.length > HISTORY_LIMIT) state.agentHistory.shift();
  }

  function startAgentWait() {
    if (agentWaitStartedAt === null) agentWaitStartedAt = Date.now();
  }

  function resetAgentWait() {
    agentWaitStartedAt = null;
  }

  function agentWaitExpired() {
    return agentWaitStartedAt !== null && Date.now() - agentWaitStartedAt >= agentWaitMs;
  }

  /**
   * Whether the prompt section currently satisfies an expectation. `empty` is
   * the healthy state (no prompt tokens). An unsupported or failed read is
   * treated as settled so the probe stays finite and the harness can fail on
   * the recorded evidence instead of hanging.
   */
  function agentSettled(expectation) {
    const agent = state.agent ?? {};
    if (agent.supported === false) return true;
    if (agent.supported !== true) return false;
    if (typeof agent.error === 'string' && agent.error.length > 0) return true;
    const text = typeof agent.text === 'string' ? agent.text.trim() : '';
    return expectation === 'nonempty' ? text.length > 0 : text.length === 0;
  }

  function markAgentTimedOut(expectation) {
    if (!agentSettled(expectation)) state.agentTimedOut = true;
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

      await refreshAgentStatus();

      if (expect === 'down') {
        if (pollCount >= 3) {
          startAgentWait();
          if (agentSettled('nonempty') || agentWaitExpired()) {
            markAgentTimedOut('nonempty');
            state.observedDown = state.mebularToolCount === 0;
            finishWith(state.observedDown ? null : 'mebular_tools_present_while_down');
            return;
          }
        }
      } else if (expect === 'up') {
        if (consecutiveUp >= 2) {
          startAgentWait();
          if (agentSettled('empty') || agentWaitExpired()) {
            markAgentTimedOut('empty');
            phase = 'up-observed';
            state.phase = phase;
            recordHistory(`up:${state.mebularToolCount}`);
            persist();
            await invokeReadTool(available);
            return;
          }
        }
      } else if (phase === 'awaiting-tools') {
        if (consecutiveUp >= 2) {
          startAgentWait();
          if (agentSettled('empty') || agentWaitExpired()) {
            markAgentTimedOut('empty');
            resetAgentWait();
            phase = 'awaiting-down';
            state.phase = phase;
            state.firstUpAt = new Date().toISOString();
          }
        }
      } else if (phase === 'awaiting-down') {
        if (consecutiveDown >= 2) {
          startAgentWait();
          if (agentSettled('nonempty') || agentWaitExpired()) {
            markAgentTimedOut('nonempty');
            resetAgentWait();
            phase = 'awaiting-recovery';
            state.phase = phase;
            state.downAt = new Date().toISOString();
          }
        }
      } else if (phase === 'awaiting-recovery') {
        if (consecutiveUp >= 2) {
          startAgentWait();
          if (agentSettled('empty') || agentWaitExpired()) {
            markAgentTimedOut('empty');
            resetAgentWait();
            phase = 'recovered';
            state.phase = phase;
            state.recoveredAt = new Date().toISOString();
            recordHistory(`recovered:${state.mebularToolCount}`);
            persist();
            await invokeReadTool(available);
            return;
          }
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

  // Optional service: a DSH build without systemPrompt keeps the probe alive
  // and records `supported: null/false`, which the harness reports as a gap
  // rather than a silent pass.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], (promptCtx) => {
        try {
          capturePromptService(promptCtx?.systemPrompt);
        } catch (error) {
          promptError = `system_prompt_access_failed: ${String(error?.message ?? error).slice(0, 200)}`;
        }
      });
    } else {
      capturePromptService(ctx.systemPrompt);
    }
  } catch (error) {
    promptError = `system_prompt_inject_failed: ${String(error?.message ?? error).slice(0, 200)}`;
  }

  persist();
  timer = setInterval(() => { void tick(); }, 1000);
  timer.unref?.();
  void tick();
}
