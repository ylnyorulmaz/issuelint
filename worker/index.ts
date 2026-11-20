import { runAnalysis, InferenceError, type AiRunner } from "./inference.ts";
import { parseTask, ValidationError } from "./schema.ts";

/** For Iteration 2, AI is disabled unless explicitly enabled and protected. */
interface WorkerEnv {
  AI?: AiRunner;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ANALYZE_ENABLED?: string;
  PREVIEW_TOKEN?: string;
  AI_MODEL?: string;
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function error(code: string, message: string, status: number): Response {
  return json({ error: code, message }, status);
}

function methodNotAllowed(allowed: string): Response {
  return json({ error: "METHOD_NOT_ALLOWED", message: `Use ${allowed} for this endpoint.` }, 405, { Allow: allowed });
}

const MAX_REQUEST_BYTES = 32_768;

async function readBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ValidationError("size", "Request body exceeds the limit.");
  }
  if (!request.body) throw new ValidationError("json", "A JSON request body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ValidationError("size", "Request body exceeds the limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); }
    catch { throw new ValidationError("json", "Malformed JSON request."); }
  } finally {
    reader.releaseLock();
  }
}

async function verifiedToken(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 24) return false;
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match || match[1].length > 256) return false;

  // Compare SHA-256 digests in fixed time (not user-controlled string comparisons).
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(match[1])),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return json({
        status: "ok",
        service: "issuelint",
        iteration: 2,
        reviewEngineVersion: "2.4",
        aiBindingConfigured: env.AI != null,
        aiEnabled: env.ANALYZE_ENABLED === "true",
      });
    }

    if (pathname === "/api/analyze") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const contentType = request.headers.get("content-type") ?? "";
      if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
        return error("UNSUPPORTED_MEDIA_TYPE", "Send application/json.", 415);
      }
      if (env.ANALYZE_ENABLED !== "true") {
        return error("AI_DISABLED", "Live analysis is not enabled in this environment.", 503);
      }
      if (!(await verifiedToken(request, env.PREVIEW_TOKEN))) {
        return error("PREVIEW_AUTH_REQUIRED", "A valid preview token is required.", 401);
      }
      if (!env.AI) {
        return error("AI_UNAVAILABLE", "Workers AI is not configured.", 503);
      }

      let task;
      try {
        task = parseTask(await readBody(request));
      } catch (cause) {
        if (cause instanceof ValidationError) {
          return error(cause.field === "size" ? "PAYLOAD_TOO_LARGE" : cause.field === "json" ? "INVALID_JSON" : "INVALID_TASK",
            cause.message, cause.field === "size" ? 413 : cause.field === "json" ? 400 : 422);
        }
        return error("INVALID_JSON", "Unable to parse request body.", 400);
      }

      try {
        const analysis = await runAnalysis(task, env.AI, env.AI_MODEL);
        return json({ mode: "ai", analyzed: true, analysis });
      } catch (cause) {
        const kind = cause instanceof InferenceError ? cause.kind : "upstream";
        // Never log prompts, task content, authorization or raw provider errors.
        console.warn("issuelint.inference_failed", {
          category: kind,
          model: env.AI_MODEL === "@cf/openai/gpt-oss-120b" ? "gpt-oss-120b" : "configured-model",
        });
        if (kind === "truncated") {
          return error("AI_TRUNCATED", "The model ran out of output tokens. Please retry.", 502);
        }
        if (kind === "invalid_response") {
          return error("AI_INVALID_RESPONSE", "The model returned an invalid analysis. Please retry.", 502);
        }
        return error("AI_UNAVAILABLE", "The AI model is temporarily unavailable. Please retry later.", 502);
      }
    }

    if (pathname.startsWith("/api/")) {
      return error("NOT_FOUND", "Unknown API endpoint.", 404);
    }

    return env.ASSETS.fetch(request);
  },
};
