/**
 * HTTP client for the IssueLint Worker.
 *
 * Contract (worker/index.ts, worker/schema.ts in this repo):
 *   POST <ISSUELINT_API_URL>/api/analyze-v2
 *   Authorization: Bearer <PREVIEW_TOKEN>   (server requires 24–256 chars, no whitespace)
 *   Content-Type: application/json
 *   X-Request-ID: [A-Za-z0-9_-]{8,64}       (echoed back for log correlation)
 *   Body: { title, description, type, domain, criteria?, context?, scope?, outcome?, references? }
 *   Errors: { error: CODE, message }
 */
import { randomUUID } from "node:crypto";
import { VERSION } from "./version.js";

export const DEFAULT_API_URL = "https://issuelint.com";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const ANALYZE_PATH = "/api/analyze-v2";
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface Config {
  apiUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export type ErrorCode =
  | "missing_api_key"
  | "invalid_api_key"
  | "invalid_config"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "not_enabled"
  | "invalid_request"
  | "payload_too_large"
  | "upstream_unavailable"
  | "timeout"
  | "network"
  | "invalid_response"
  | "http";

export class IssueLintError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  constructor(code: ErrorCode, message: string, opts: { status?: number; requestId?: string } = {}) {
    super(message);
    this.name = "IssueLintError";
    this.code = code;
    this.status = opts.status;
    this.requestId = opts.requestId;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Reads configuration from the environment. Never logs the key. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = (env.ISSUELINT_API_URL ?? "").trim() || DEFAULT_API_URL;
  let apiUrl = DEFAULT_API_URL;
  try {
    const url = new URL(rawUrl);
    const local = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new Error("insecure");
    }
    if (url.username || url.password) throw new Error("credentials");
    apiUrl = url.origin;
  } catch {
    throw new IssueLintError("invalid_config",
      `ISSUELINT_API_URL must be an https:// URL (http:// is allowed only for localhost) without credentials, e.g. ${DEFAULT_API_URL}.`);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = (env.ISSUELINT_TIMEOUT_MS ?? "").trim();
  if (rawTimeout) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TIMEOUT_MS) {
      throw new IssueLintError("invalid_config", `ISSUELINT_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }
    timeoutMs = n;
  }

  return { apiUrl, apiKey: (env.ISSUELINT_API_KEY ?? "").trim(), timeoutMs };
}

/** Mirrors the Worker's PREVIEW_TOKEN shape check so the agent gets a clear message before any request. */
export function checkApiKey(apiKey: string): void {
  if (!apiKey) {
    throw new IssueLintError("missing_api_key",
      "ISSUELINT_API_KEY is not set. Add your IssueLint preview access code to this MCP server's environment " +
      "(see the issuelint-mcp README), then restart the MCP server. No request was sent.");
  }
  if (/\s/.test(apiKey) || apiKey.length < 24 || apiKey.length > 256) {
    throw new IssueLintError("invalid_api_key",
      "ISSUELINT_API_KEY does not look like an IssueLint access code (24–256 characters, no spaces). No request was sent.");
  }
}

function serverError(body: unknown): { code: string; message: string } {
  if (!body || typeof body !== "object") return { code: "", message: "" };
  const { error, message } = body as { error?: unknown; message?: unknown };
  return {
    code: typeof error === "string" ? error.slice(0, 64) : "",
    message: typeof message === "string" ? message.slice(0, 300) : "",
  };
}

function httpError(status: number, body: unknown, requestId: string): IssueLintError {
  const { code, message } = serverError(body);
  const ref = { status, requestId };
  const detail = message ? ` Server said: "${message}"` : "";
  if (status === 401) {
    return new IssueLintError("unauthorized",
      `IssueLint rejected the API key (HTTP 401${code ? ` ${code}` : ""}). Check ISSUELINT_API_KEY and restart the MCP server.`, ref);
  }
  if (status === 403) {
    return new IssueLintError("forbidden",
      "IssueLint refused the request (HTTP 403). The key may lack access, or the request was blocked by the site's firewall." + detail, ref);
  }
  if (status === 429 || code === "DECISION_RATE_LIMIT") {
    return new IssueLintError("rate_limited",
      `IssueLint is rate limited (HTTP ${status}). Wait a few minutes before retrying; do not retry in a loop.` + detail, ref);
  }
  if (status === 413) {
    return new IssueLintError("payload_too_large", "The task is too large for IssueLint (max 8,000 characters in total)." + detail, ref);
  }
  if (status === 400 || status === 415 || status === 422) {
    return new IssueLintError("invalid_request", `IssueLint rejected the task (HTTP ${status}${code ? ` ${code}` : ""}).` + detail, ref);
  }
  if (status === 503) {
    return new IssueLintError("not_enabled",
      `Analysis is not available on this IssueLint server (HTTP 503${code ? ` ${code}` : ""}).` + detail, ref);
  }
  if (status >= 500) {
    return new IssueLintError("upstream_unavailable",
      `IssueLint could not complete the review (HTTP ${status}${code ? ` ${code}` : ""}). Try again later.` + detail, ref);
  }
  return new IssueLintError("http", `IssueLint returned HTTP ${status}${code ? ` ${code}` : ""}.` + detail, ref);
}

export interface AnalyzeResult {
  data: unknown;
  requestId: string;
  durationMs: number;
  endpoint: string;
}

export async function analyzeTask(
  task: Record<string, unknown>,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<AnalyzeResult> {
  checkApiKey(config.apiKey);
  const endpoint = new URL(ANALYZE_PATH, config.apiUrl).toString();
  const requestId = randomUUID();
  const started = Date.now();
  const timeout = AbortSignal.timeout(config.timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "X-Request-ID": requestId,
        "User-Agent": `issuelint-mcp/${VERSION}`,
      },
      body: JSON.stringify(task),
      signal: timeout,
      redirect: "error",
    });
  } catch {
    if (timeout.aborted) {
      throw new IssueLintError("timeout",
        `IssueLint did not respond within ${Math.round(config.timeoutMs / 1000)}s. The review can take about a minute; ` +
        "retry once, or raise ISSUELINT_TIMEOUT_MS.", { requestId });
    }
    throw new IssueLintError("network", `Could not reach IssueLint at ${config.apiUrl}. Check the network and ISSUELINT_API_URL.`, { requestId });
  }

  const serverId = res.headers.get("x-request-id");
  const id = serverId && /^[a-zA-Z0-9_-]{8,64}$/.test(serverId) ? serverId : requestId;
  let text: string;
  try {
    text = await res.text();
  } catch {
    if (timeout.aborted) {
      throw new IssueLintError("timeout", `IssueLint did not finish responding within ${Math.round(config.timeoutMs / 1000)}s.`, { requestId: id });
    }
    throw new IssueLintError("network", "The connection to IssueLint was interrupted.", { requestId: id });
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new IssueLintError("invalid_response", "IssueLint returned an unexpectedly large response.", { status: res.status, requestId: id });
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) throw httpError(res.status, body, id);
  if (body === undefined) {
    throw new IssueLintError("invalid_response", "IssueLint did not return valid JSON.", { status: res.status, requestId: id });
  }
  return { data: body, requestId: id, durationMs: Date.now() - started, endpoint };
}
