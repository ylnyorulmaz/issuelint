export const ANALYZE_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ApiError extends Error {
  readonly requestId: string;
  readonly status?: number;
  constructor(message: string, requestId: string, status?: number) {
    super(message);
    this.requestId = requestId;
    this.status = status;
  }
}

function serverMessage(json: unknown): { code: string; message: string } {
  if (!json || typeof json !== "object") return { code: "", message: "" };
  const { error, message } = json as { error?: unknown; message?: unknown };
  return {
    code: typeof error === "string" ? error.slice(0, 80) : "",
    message: typeof message === "string" ? message.slice(0, 300) : "",
  };
}

function httpErrorMessage(status: number, json: unknown): string {
  const { code, message } = serverMessage(json);
  const detail = message || code;
  if (status === 401) {
    return "The access code was rejected (HTTP 401). Check the preview access code / API key in Settings.";
  }
  if (status === 403 && !detail) {
    return "The server refused the request (HTTP 403). It may be blocked by the site's firewall or require a different key.";
  }
  const base = `The API returned HTTP ${status}${detail ? `: ${detail}` : "."}`;
  if (status === 413) return `${base} Trim the text and try again.`;
  if (status === 429 || code === "DECISION_RATE_LIMIT") return `${base} Wait a bit before retrying.`;
  return base;
}

/** POSTs JSON to the resolved endpoint and returns the parsed JSON body. */
export async function postAnalysis(opts: {
  url: string;
  body: unknown;
  apiKey: string;
  signal: AbortSignal;
}): Promise<unknown> {
  // A UUID satisfies the IssueLint Worker's X-Request-ID allowlist, so logs correlate.
  const requestId = crypto.randomUUID();
  const timeout = AbortSignal.timeout(ANALYZE_TIMEOUT_MS);
  const signal = AbortSignal.any([opts.signal, timeout]);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Request-ID": requestId,
  };
  if (opts.apiKey.trim()) headers.Authorization = `Bearer ${opts.apiKey.trim()}`;

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    if (opts.signal.aborted) throw new ApiError("Analysis cancelled.", requestId);
    if (timeout.aborted) throw new ApiError("The analysis timed out after 3 minutes.", requestId);
    throw new ApiError("Could not reach the API. Check the URL, your connection, and that access was granted.", requestId);
  }

  const raw = await res.text();
  if (raw.length > MAX_RESPONSE_BYTES) throw new ApiError("The API response is too large.", requestId, res.status);
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : undefined;
  } catch {
    json = undefined;
  }
  const responseId = res.headers.get("X-Request-ID");
  const id = responseId && /^[a-zA-Z0-9_-]{8,64}$/.test(responseId) ? responseId : requestId;

  if (!res.ok) throw new ApiError(httpErrorMessage(res.status, json), id, res.status);
  if (json === undefined) throw new ApiError("The API did not return valid JSON.", id, res.status);
  return json;
}
