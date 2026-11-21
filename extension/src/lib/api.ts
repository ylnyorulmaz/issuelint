import { checkApiUrl } from "./api-url.ts";
import type { AnalyzeRequest } from "./types.ts";

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

/** POSTs the clipped page to the configured backend and returns the parsed JSON body. */
export async function analyzeRemote(
  body: AnalyzeRequest,
  opts: { apiUrl: string; apiKey: string; signal: AbortSignal },
): Promise<unknown> {
  const check = checkApiUrl(opts.apiUrl);
  const requestId = crypto.randomUUID();
  if (!check.ok) throw new ApiError(check.error, requestId);

  const timeout = AbortSignal.timeout(ANALYZE_TIMEOUT_MS);
  const signal = AbortSignal.any([opts.signal, timeout]);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Request-ID": requestId,
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let res: Response;
  try {
    res = await fetch(check.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch (err) {
    if (timeout.aborted) throw new ApiError("The analysis timed out after 3 minutes.", requestId);
    if (opts.signal.aborted) throw new ApiError("Analysis cancelled.", requestId);
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

  if (!res.ok) {
    const detail =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? `: ${(json as { error: string }).error.slice(0, 200)}`
        : "";
    const hint = res.status === 401 || res.status === 403 ? " Check the API key in Settings." : "";
    throw new ApiError(`The API returned HTTP ${res.status}${detail}.${hint}`, requestId, res.status);
  }
  if (json === undefined) throw new ApiError("The API did not return valid JSON.", requestId, res.status);
  return json;
}
