import { callSaygmVerifier, verifierMode, SaygmError } from "./saygm.ts";
import { runAnalysis, InferenceError, type AiRunner } from "./inference.ts";
import { parseTask, ValidationError } from "./schema.ts";
import { callGeminiDecisions, DecisionError } from "./decision.ts";
import { runSelectiveAudit } from "./decision-audit.ts";
import { parseFeedbackEvent } from "./feedback.ts";
import { adminConfigured, adminSession, adminPage, loginPage, unconfiguredPage, checkPassword, issueAdminSession, clearAdminSession, sameOriginPost, ADMIN_RESPONSE_HEADERS, type AdminEnv } from "./admin-auth.ts";
import chatgptFixture from "../test/fixtures/task-review-control-v1.json" with { type: "json" };
import geminiFixture from "../test/fixtures/task-review-gemini-v1.json" with { type: "json" };
import pasteFixture from "../test/fixtures/task-review-paste-only-v1.json" with { type: "json" };

/** For Iteration 2, AI is disabled unless explicitly enabled and protected. */
interface WorkerEnv extends AdminEnv {
  AI?: AiRunner;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ANALYZE_ENABLED?: string;
  PREVIEW_TOKEN?: string;
  AI_MODEL?: string;
  SAYGM_API_KEY?: string;
  GEMINI_API_KEY?: string;
  FEEDBACK_VERIFIER_MODE?: string;
  FEEDBACK_RATE_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
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

async function readBody(request: Request, maxBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
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
      if (size > maxBytes) {
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

function previewTokenConfigured(secret: string | undefined): boolean {
  // Bearer credentials cannot contain whitespace. Ignore accidental outer
  // spaces/newlines from secret setup, but reject too-short or unusable config.
  const normalized = secret?.trim() ?? "";
  return normalized.length >= 24 && normalized.length <= 256 && !/\s/.test(normalized);
}

async function verifiedToken(request: Request, secret: string): Promise<boolean> {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match || match[1].length > 256) return false;

  // Compare SHA-256 digests in fixed time (not user-controlled string comparisons).
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(match[1])),
    crypto.subtle.digest("SHA-256", enc.encode(secret.trim())),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

const SAFE_ID = /^[a-zA-Z0-9_-]{8,64}$/;
function requestIdFrom(request: Request): string {
  const incoming = request.headers.get("X-Request-ID") ?? "";
  return SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
}
function logApi(level: "info" | "warn" | "error", event: string, fields: Record<string, string | number | boolean>): void {
  // All call sites use fixed labels and primitive allowlisted values.
  console[level](event, fields);
}
const CLIENT_EVENTS = new Set(["health_failed","review_failed","ui_error","unhandled_rejection","copy_failed"]);
const CLIENT_CATEGORIES = new Set(["http","network","timeout","invalid_response","auth","client","unknown"]);

async function handleApi(request: Request, env: WorkerEnv, requestId: string): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/admin/login") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!adminConfigured(env)) return error("ADMIN_UNAVAILABLE", "Admin sign-in is not configured.", 503);
      if (!sameOriginPost(request)) return error("ADMIN_ORIGIN_REQUIRED", "Same-origin request required.", 403);
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? ""))
        return error("UNSUPPORTED_MEDIA_TYPE", "Send application/json.", 415);
      // Cloudflare's approximate rate limit is defense-in-depth, not a distributed lock.
      // Global + IP counters; no username, credential or task is logged.
      try {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const [globalResult, ipResult] = await Promise.all([
          env.ADMIN_LOGIN_RATE_LIMIT!.limit({ key: "admin:global" }),
          env.ADMIN_LOGIN_RATE_LIMIT!.limit({ key: "admin:ip:" + ip }),
        ]);
        if (!globalResult.success || !ipResult.success)
          return json({error:"LOGIN_RATE_LIMITED",message:"Too many sign-in attempts."},429,{"Retry-After":"60"});
      } catch {
        return error("ADMIN_UNAVAILABLE","Admin sign-in is temporarily unavailable.",503);
      }
      let input:unknown;
      try { input = await readBody(request, 2048); }
      catch { return error("INVALID_LOGIN", "Invalid username or password.", 401); }
      if (!input || typeof input !== "object" || Array.isArray(input))
        return error("INVALID_LOGIN", "Invalid username or password.", 401);
      const data=input as Record<string,unknown>;
      if (Object.keys(data).some(k=>k!=="username"&&k!=="password") ||
          typeof data.username!=="string" || typeof data.password!=="string")
        return error("INVALID_LOGIN","Invalid username or password.",401);
      const valid=await checkPassword(data.username,data.password,env);
      logApi(valid?"info":"warn","issuelint.admin_login",{requestId,ok:valid});
      if(!valid)return error("INVALID_LOGIN","Invalid username or password.",401);
      const cookie=await issueAdminSession(env);
      return json({ok:true},200,{"Set-Cookie":cookie});
    }

    if (pathname === "/api/admin/session") {
      if (request.method!=="GET") return methodNotAllowed("GET");
      if (!adminConfigured(env)) return error("ADMIN_UNAVAILABLE","Admin is not configured.",503);
      if (!(await adminSession(request,env)))return error("ADMIN_AUTH_REQUIRED","Admin sign-in required.",401);
      return json({authenticated:true},200);
    }

    if (pathname === "/api/admin/logout") {
      if (request.method!=="POST") return methodNotAllowed("POST");
      if (!sameOriginPost(request)) return error("ADMIN_ORIGIN_REQUIRED","Same-origin request required.",403);
      return json({ok:true},200,{"Set-Cookie":clearAdminSession});
    }

    if (pathname === "/api/health") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return json({
        status: "ok",
        service: "issuelint",
        iteration: 5,
        reviewEngineVersion: "2.5",
        aiBindingConfigured: env.AI != null,
        aiEnabled: env.ANALYZE_ENABLED === "true",
        previewAuthConfigured: previewTokenConfigured(env.PREVIEW_TOKEN),
        feedbackVerifierMode: env.SAYGM_API_KEY ? verifierMode(env.FEEDBACK_VERIFIER_MODE) : "off",
        feedbackVerifierConfigured: !!env.SAYGM_API_KEY,
        decisionConfigured: !!env.GEMINI_API_KEY?.trim(),
      });
    }

    if (pathname === "/api/feedback") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      // Origin check and a global limiter, without collecting, storing or hashing IPs.
      if (!sameOriginPost(request))
        return error("FEEDBACK_ORIGIN_REQUIRED", "Same-origin request required.", 403);
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? ""))
        return error("UNSUPPORTED_MEDIA_TYPE", "Send application/json.", 415);
      if (!env.FEEDBACK_RATE_LIMIT)
        return error("FEEDBACK_UNAVAILABLE", "Feedback is temporarily unavailable.", 503);
      try {
        const limit = await env.FEEDBACK_RATE_LIMIT.limit({ key: "feedback-global" });
        if (!limit.success)
          return json({ error: "FEEDBACK_RATE_LIMITED", message: "Try again later." },
            429, { "Retry-After": "60" });
      } catch {
        return error("FEEDBACK_UNAVAILABLE", "Feedback is temporarily unavailable.", 503);
      }
      let raw: unknown;
      try { raw = await readBody(request, 1024); }
      catch { return error("INVALID_FEEDBACK", "Invalid feedback.", 422); }
      const item = parseFeedbackEvent(raw);
      if (!item) return error("INVALID_FEEDBACK", "Invalid feedback.", 422);
      // Only these exact four optional/required fields appear in application logs.
      // No ticket text, request IP, browser identifiers, preview code or request headers.
      console.info("issuelint.user_feedback", {
        rating: item.rating,
        ...(item.note ? { note: item.note } : {}),
        sessionLintCount: item.sessionLintCount,
        timestamp: item.timestamp,
      });
      return json({ ok: true }, 202);
    }

    if (pathname === "/api/client-events") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? ""))
        return error("UNSUPPORTED_MEDIA_TYPE", "Send application/json.", 415);
      if (!previewTokenConfigured(env.PREVIEW_TOKEN))
        return error("PREVIEW_AUTH_MISCONFIGURED", "Private preview authentication is not configured correctly.", 503);
      if (!(await verifiedToken(request, env.PREVIEW_TOKEN!)) &&
          !(sameOriginPost(request) && await adminSession(request, env)))
        return error("PREVIEW_AUTH_REQUIRED", "A valid preview code or admin session is required.", 401);
      let payload: unknown;
      try { payload = await readBody(request, 1024); }
      catch { return error("INVALID_CLIENT_EVENT", "Invalid diagnostic event.", 422); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return error("INVALID_CLIENT_EVENT", "Invalid diagnostic event.", 422);
      const entry = payload as Record<string, unknown>;
      if (Object.keys(entry).some(k => !["event","category","durationMs","status"].includes(k)) ||
          typeof entry.event !== "string" || !CLIENT_EVENTS.has(entry.event) ||
          typeof entry.category !== "string" || !CLIENT_CATEGORIES.has(entry.category) ||
          !Number.isInteger(entry.status) || (entry.status as number) < 0 || (entry.status as number) > 599 ||
          !Number.isInteger(entry.durationMs) || (entry.durationMs as number) < 0 || (entry.durationMs as number) > 300000)
        return error("INVALID_CLIENT_EVENT", "Invalid diagnostic event.", 422);
      logApi("warn", "issuelint.client_event", {
        requestId, event: entry.event, category: entry.category,
        status: entry.status as number, durationMs: entry.durationMs as number,
      });
      return json({ ok: true });
    }

    if (pathname === "/api/admin/test-cases") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      if (env.ANALYZE_ENABLED !== "true")
        return error("ADMIN_DISABLED", "Private test station is not enabled.", 503);
      if (!adminConfigured(env)) return error("ADMIN_UNAVAILABLE","Admin sign-in is not configured.",503);
      if (!(await adminSession(request,env)))
        return error("ADMIN_AUTH_REQUIRED","Admin sign-in required.",401);
      const source = new URL(request.url).searchParams.get("source");
      if (source !== "chatgpt" && source !== "gemini" && source !== "paste")
        return error("INVALID_SOURCE", "Choose chatgpt, gemini or paste.", 400);
      const fixture = source === "chatgpt" ? chatgptFixture : source === "gemini" ? geminiFixture : pasteFixture;
      logApi("info", "issuelint.admin_fixture_loaded", { requestId, source, count: fixture.cases.length });
      return json({
        source, dataset_id: fixture.dataset_id, schema_version: fixture.schema_version,
        status: fixture.status, cases: fixture.cases,
      });
    }

    if (pathname === "/api/analyze-v2" || pathname === "/api/quick-scan") {
      const quickScan = pathname === "/api/quick-scan";
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? ""))
        return error("UNSUPPORTED_MEDIA_TYPE", "Send application/json.", 415);
      if (env.ANALYZE_ENABLED !== "true")
        return error("AI_DISABLED", "Live analysis is not enabled in this environment.", 503);
      if (!previewTokenConfigured(env.PREVIEW_TOKEN))
        return error("PREVIEW_AUTH_MISCONFIGURED", "Private preview authentication is not configured correctly.", 503);
      if (!(await verifiedToken(request, env.PREVIEW_TOKEN!)) &&
          !(sameOriginPost(request) && await adminSession(request, env)))
        return error("PREVIEW_AUTH_REQUIRED", "A valid preview code or admin session is required.", 401);
      if (!env.GEMINI_API_KEY?.trim())
        return error("DECISION_NOT_CONFIGURED", "Gemini Decision 1 is not configured. Add GEMINI_API_KEY to Worker secrets.", 503);
      let task;
      try { task = parseTask(await readBody(request)); }
      catch (cause) {
        if (cause instanceof ValidationError)
          return error(cause.field === "size" ? "PAYLOAD_TOO_LARGE" :
            cause.field === "json" ? "INVALID_JSON" : "INVALID_TASK",
            cause.message, cause.field === "size" ? 413 : cause.field === "json" ? 400 : 422);
        return error("INVALID_JSON", "Unable to parse request body.", 400);
      }
      const started = Date.now();
      logApi("info", "issuelint.decision_started", { requestId, model: "gemini-decision-1", checked: 11 });
      try {
        const result = await callGeminiDecisions(task, env.GEMINI_API_KEY);
        for (const gate of result.gates)
          logApi("info", "issuelint.decision_gate", {
            requestId, dimension: gate.dimension, assessment: gate.assessment,
            confidence: Math.round(gate.confidence * 1000) / 1000,
          });
        logApi("info", "issuelint.decision_result", {
          requestId, ok: true, durationMs: Date.now() - started,
          checked: result.checked,
          clear: result.gates.filter(g => g.assessment === "clear").length,
          gap: result.gates.filter(g => g.assessment === "gap").length,
          notApplicable: result.gates.filter(g => g.assessment === "not_applicable").length,
        });
        if (quickScan) {
          // Gemini-only screen. Keep GPT-OSS, SayGM and rewrite pipelines untouched.
          logApi("info", "issuelint.quick_scan_result", {
            requestId, checked: result.checked, durationMs: Date.now() - started,
            issues: result.gates.filter(g => g.assessment === "gap").length,
          });
          return json({
            mode: "quick_scan", analyzed: true,
            scan: {
              model: result.model,
              checked: result.checked,
              durationMs: result.durationMs,
              gates: result.gates.map(g => ({dimension:g.dimension,assessment:g.assessment})),
            },
          });
        }
        const audit = await runSelectiveAudit(task, result, env.AI, env.AI_MODEL,
          (stage, fields) => logApi(stage === "failed" ? "warn" : "info", "issuelint.decision_audit", {requestId, stage, ...fields}));
        return json({ mode: "decision", analyzed: true, decision: {...result, audit} });
      } catch (cause) {
        const code = cause instanceof DecisionError ? cause.code : "unknown";
        const httpStatus = cause instanceof DecisionError ? cause.providerStatus : 0;
        logApi("warn", "issuelint.decision_result", {
          requestId, ok: false, category: code, providerStatus: httpStatus,
          durationMs: Date.now() - started,
        });
        return error(code === "provider_http" && httpStatus === 429 ?
          "DECISION_RATE_LIMIT" : "DECISION_UNAVAILABLE",
          code === "provider_http" && httpStatus === 429 ?
          "Gemini Decision 1 rate limit reached. Try again later." :
          "Gemini Decision 1 could not complete the review. Try again later.", 502);
      }
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
      if (!previewTokenConfigured(env.PREVIEW_TOKEN)) {
        // Report server misconfiguration separately from invalid visitor input.
        // Never reveal the configured value, its length or any digest.
        return error("PREVIEW_AUTH_MISCONFIGURED", "Private preview authentication is not configured correctly.", 503);
      }
      if (!(await verifiedToken(request, env.PREVIEW_TOKEN!))) {
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
        const mode = env.SAYGM_API_KEY ? verifierMode(env.FEEDBACK_VERIFIER_MODE) : "off";
        const observer = mode === "off" ? undefined : async (checks: readonly import("./review-v2.ts").ReviewCheck[]) => {
          const verifierStarted = Date.now();
          logApi("info", "issuelint.verifier_started", {requestId, mode, checked: checks.length});
          try {
            const result = await callSaygmVerifier({ apiKey: env.SAYGM_API_KEY, task, checks });
            // Never log task text, findings, questions, patch details or raw response.
            console.info("issuelint.verifier_result", {
              requestId, ok: true, verdictCount: result.verdict.verdicts.length,
              latencyMs: result.latencyMs,
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
            });
            return mode === "on" ? result.verdict : undefined;
          } catch (cause) {
            console.warn("issuelint.verifier_result", {
              requestId, ok: false,
              category: cause instanceof SaygmError ? cause.category : "unknown",
              validationCode: cause instanceof SaygmError ? (cause.validationCode ?? "none") : "none",
              httpStatus: cause instanceof SaygmError ? (cause.httpStatus ?? 0) : 0,
              latencyMs: Date.now() - verifierStarted,
            });
          }
        };
        const analysis = await runAnalysis(task, env.AI, env.AI_MODEL, observer, mode === "on",
          stage => logApi("info", "issuelint.inference_stage", {requestId, stage}));
        logApi("info", "issuelint.analysis_result", {
          requestId, status: analysis.status, findings: analysis.findings.length,
          modelCalls: analysis.modelUsage.calls, durationMs: analysis.modelUsage.latencyMs,
          rewriteStatus: analysis.rewriteStatus,
        });
        return json({ mode: "ai", analyzed: true, analysis });
      } catch (cause) {
        const kind = cause instanceof InferenceError ? cause.kind : "upstream";
        // Never log prompts, task content, authorization or raw provider errors.
        console.warn("issuelint.inference_failed", {
          requestId, category: kind,
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

    return error("NOT_FOUND", "Unknown API endpoint.", 404);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    const isAdminPage = pathname === "/admin" || pathname === "/admin/" || pathname.startsWith("/admin/");
    if (!pathname.startsWith("/api/") && !isAdminPage) return env.ASSETS.fetch(request);
    if (isAdminPage) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed.",{status:405,headers:ADMIN_RESPONSE_HEADERS});
      if (!adminConfigured(env)) return adminPage(unconfiguredPage,503);
      if (!(await adminSession(request,env))) return adminPage(loginPage);
      // The public SPA bundle includes the AdminStation code, but is only served as
      // /admin HTML after a validated session. Browser JS is never the auth boundary.
      const indexUrl=new URL("/index.html",request.url);
      const asset=await env.ASSETS.fetch(new Request(indexUrl,request));
      if (!asset.ok) return adminPage(unconfiguredPage,503);
      const html=(await asset.text())
        .replace('<meta name="robots" content="index,follow,max-image-preview:large"/>',
          '<meta name="robots" content="noindex,nofollow,noarchive"/>')
        .replace('<link rel="canonical" href="https://issuelint.com/"/>','');
      const headers=new Headers(asset.headers);
      for(const [name,value] of Object.entries(ADMIN_RESPONSE_HEADERS)) headers.set(name,value);
      headers.set("Content-Type","text/html; charset=utf-8");
      return new Response(request.method==="HEAD"?null:html,{status:200,headers});
    }
    const requestId = requestIdFrom(request);
    const started = Date.now();
    if (pathname === "/api/analyze" || pathname === "/api/analyze-v2")
      logApi("info", "issuelint.request_started",
        {requestId, endpoint: pathname === "/api/analyze" ? "analyze" : "analyze-v2"});
    try {
      const response = await handleApi(request, env, requestId);
      response.headers.set("X-Request-ID", requestId);
      if (pathname.startsWith("/api/admin/"))
        for(const [name,value] of Object.entries(ADMIN_RESPONSE_HEADERS))response.headers.set(name,value);
      if (pathname === "/api/analyze" || pathname === "/api/analyze-v2" ||
          (pathname !== "/api/health" && response.status >= 400))
        logApi(response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
          "issuelint.request_finished", {
            requestId, endpoint: pathname === "/api/analyze" ? "analyze" :
              pathname === "/api/analyze-v2" ? "analyze-v2" : "client_or_other",
            status: response.status, durationMs: Date.now()-started
          });
      return response;
    } catch {
      // Last-resort boundary: do not leak exception messages, stacks or source data.
      logApi("error", "issuelint.unhandled_request_error", {requestId, endpoint:"api", durationMs:Date.now()-started});
      return json({error:"INTERNAL_ERROR",message:"The service encountered an error."},500,{"X-Request-ID":requestId});
    }
  }
};
