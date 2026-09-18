// OpenChamber 适配器（M4）：**中立 HTTP 客户端 seam**。
//
// 本文件对 provider **毫不知情**：只接受「一个 HTTPS/HTTP 端点 + 一个 bearer-ish token（内联或从文件读）
// + 超时 + 可选 agent/model」，POST 一个 JSON 请求并读取 `{ ok, result:{ text, sessionId? }, error? }`。
// 当前 provider #1 是 oc-hermes-bridge daemon 的 `POST /agent/run-once`（由调用方/脚本提供 endpoint 与
// token 路径）；将来换成独立 provider 或 OpenChamber 官方 API，**不改本文件、也不改 fleet 代码**。
//
// 安全：只发本机端点、token 不硬编码、不打印、不落盘、不出现在错误信息里；超时/连接失败 → 归一错误。

import { readFileSync } from 'node:fs';
import http from 'node:http';

import type { OpenChamberPromptInput, OpenChamberSessionSeam } from './openchamber.js';

export interface HttpOpenChamberSeamOptions {
  /** 完整端点 URL（provider 决定路径）；缺省读 env `MEBULAR_FLEET_OPENCHAMBER_ENDPOINT` */
  endpoint?: string;
  /** 内联 token；缺省 `MEBULAR_FLEET_OPENCHAMBER_TOKEN` */
  token?: string;
  /** 从文件读 token；缺省 `MEBULAR_FLEET_OPENCHAMBER_TOKEN_FILE` */
  tokenFile?: string;
  /** 文件为 JSON 时取该点分路径；缺省 `MEBULAR_FLEET_OPENCHAMBER_TOKEN_JSON_PATH` 或 `token` */
  tokenJsonPath?: string;
  /** 鉴权头名（provider 决定，默认 `X-Bridge-Token`）；缺省 `MEBULAR_FLEET_OPENCHAMBER_AUTH_HEADER` */
  authHeader?: string;
  /** 等待上限（默认 600000ms，且不超过 600s） */
  timeoutMs?: number;
}

interface BridgeReply {
  ok: boolean;
  result?: { text?: string; sessionId?: string; ms?: number };
  error?: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** 读取 token：文件是 JSON 则按 `jsonPath` 取值，否则取整文件文本。 */
function readTokenFromFile(file: string, jsonPath: string): string | null {
  try {
    const raw = readFileSync(file, 'utf-8').trim();
    if (raw.startsWith('{')) {
      let node: unknown = JSON.parse(raw);
      for (const key of jsonPath.split('.')) {
        if (typeof node !== 'object' || node === null) return null;
        node = (node as Record<string, unknown>)[key];
      }
      return typeof node === 'string' && node.length > 0 ? node : null;
    }
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** 本机 HTTP POST JSON；连接失败/超时/非 JSON → null 或 `{ok:false}`；错误不夹带 token。 */
function postJson(endpoint: string, token: string, authHeader: string, body: string, timeoutMs: number): Promise<BridgeReply | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      resolve(null);
      return;
    }
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          [authHeader]: token,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as BridgeReply);
          } catch {
            resolve({ ok: false, error: `provider returned non-JSON (status ${res.statusCode ?? '?'})` });
          }
        });
      },
    );
    req.on('error', () => resolve(null)); // 不回传底层细节（避免泄露端点/凭据）
    req.setTimeout(Math.max(1, timeoutMs), () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/** 中立 HTTP seam（provider 只决定 endpoint/token/字段）。 */
export class HttpOpenChamberSeam implements OpenChamberSessionSeam {
  constructor(private readonly options: HttpOpenChamberSeamOptions = {}) {}

  private resolveToken(): string | null {
    const inline = this.options.token ?? env('MEBULAR_FLEET_OPENCHAMBER_TOKEN');
    if (inline !== undefined) return inline;
    const file = this.options.tokenFile ?? env('MEBULAR_FLEET_OPENCHAMBER_TOKEN_FILE');
    if (file === undefined) return null;
    const jsonPath = this.options.tokenJsonPath ?? env('MEBULAR_FLEET_OPENCHAMBER_TOKEN_JSON_PATH') ?? 'token';
    return readTokenFromFile(file, jsonPath);
  }

  async prompt(input: OpenChamberPromptInput): Promise<{ text: string; sessionId?: string; error?: string }> {
    const endpoint = this.options.endpoint ?? env('MEBULAR_FLEET_OPENCHAMBER_ENDPOINT');
    if (endpoint === undefined) return { text: '', error: 'openchamber endpoint not configured' };
    const token = this.resolveToken();
    if (token === null) return { text: '', error: 'openchamber token unavailable' };

    const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? this.options.timeoutMs ?? 600_000, 600_000));
    const payload: Record<string, unknown> = { prompt: input.prompt, timeoutSec: Math.ceil(timeoutMs / 1000) };
    if (input.agent !== undefined) payload.agent = input.agent;
    if (input.model !== undefined) payload.model = input.model;

    const authHeader = this.options.authHeader ?? env('MEBULAR_FLEET_OPENCHAMBER_AUTH_HEADER') ?? 'X-Bridge-Token';
    const reply = await postJson(endpoint, token, authHeader, JSON.stringify(payload), timeoutMs);
    if (reply === null) return { text: '', error: 'openchamber provider unavailable or timed out' };
    if (reply.ok !== true) return { text: '', error: reply.error ?? 'openchamber provider error' };
    const result = reply.result ?? {};
    return {
      text: typeof result.text === 'string' ? result.text : '',
      ...(typeof result.sessionId === 'string' ? { sessionId: result.sessionId } : {}),
    };
  }
}
