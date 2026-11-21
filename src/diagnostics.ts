/**
 * Privacy-constrained browser diagnostics. Never pass task text, prompts,
 * token values, exception messages, URLs, stacks, or form fields to the logger.
 * Cloudflare receives only fixed event/category labels and numeric metadata.
 */
export type ClientEvent =
  "health_failed" | "review_failed" | "ui_error" | "unhandled_rejection" | "copy_failed";
export type ClientCategory =
  "http" | "network" | "timeout" | "invalid_response" | "auth" | "client" | "unknown";

let reports = 0;
const MAX_REPORTS_PER_PAGE = 8;
const SAFE_ID = /^[a-zA-Z0-9_-]{8,64}$/;
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Correlation only, not an authentication token.
  return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,10);
}
export function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}
export function logClient(
  level: "info" | "warn" | "error",
  event: string,
  meta: {requestId: string; status?: number; durationMs?: number; category?: ClientCategory},
): void {
  console[level]("issuelint.client", {
    event, requestId: safeRequestId(meta.requestId) ?? "invalid_id",
    ...(meta.category ? {category:meta.category} : {}),
    ...(meta.status !== undefined ? {status:meta.status} : {}),
    ...(meta.durationMs !== undefined ? {durationMs:Math.max(0,Math.round(meta.durationMs))} : {}),
  });
}
export function reportClientFailure(
  event: ClientEvent, category: ClientCategory,
  token: string, requestId: string, status = 0, durationMs = 0,
): void {
  const id = safeRequestId(requestId) ?? newRequestId();
  const safeStatus = Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0;
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0,Math.min(300000,Math.round(durationMs))) : 0;
  logClient("warn", event, {requestId:id,category,status:safeStatus,durationMs:safeDuration});
  if (!token || reports >= MAX_REPORTS_PER_PAGE || typeof fetch !== "function") return;
  reports++;
  // Protected by the same Bearer gate as /api/analyze. No raw error data.
  try {
    void fetch("/api/client-events", {
      method:"POST", cache:"no-store", keepalive:true,
      headers:{"Content-Type":"application/json","Authorization":"Bearer " + token,"X-Request-ID":id},
      body:JSON.stringify({event,category,status:safeStatus,durationMs:safeDuration}),
    }).catch(() => { /* reporting must never break the UI */ });
  } catch { /* reporting must never break the UI */ }
}
