import type { Task } from './analyzer';
import { newRequestId, safeRequestId, logClient } from './diagnostics.ts';

export type ApiFinding = {
  kind: 'missing' | 'ambiguity' | 'contradiction' | 'suggestion';
  severity: 'critical' | 'important' | 'suggestion';
  title: string;
  detail: string;
  evidence: string[];
  question: string;
};
export type ApiAnalysis = {
  status: 'ready' | 'needs_clarification' | 'blocked';
  summary: string;
  findings: ApiFinding[];
  suggestedRewrite: string;
  rewriteStatus: 'rewritten' | 'clarification_draft' | 'unavailable';
  reviewContext?: { domain: string; type: string; inferred: boolean };
  reviewCoverage?: { checked: number; gaps: number; reported: number };
};
export type LiveResponse = { mode: 'ai'; analyzed: true; analysis: ApiAnalysis };
export type Health = { status: string; aiEnabled: boolean; aiBindingConfigured: boolean };

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  constructor(code: string, message: string, status = 0, requestId = "unknown") {
    super(message);
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.name = 'ApiError';
  }
}
function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function getHealth(): Promise<Health> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Health endpoint unavailable');
    const json: unknown = await response.json();
    if (!object(json) || typeof json.aiEnabled !== 'boolean' || typeof json.aiBindingConfigured !== 'boolean') {
      throw new Error('Unexpected health response');
    }
    return { status: String(json.status ?? 'unknown'), aiEnabled: json.aiEnabled, aiBindingConfigured: json.aiBindingConfigured };
  } finally { clearTimeout(timeout); }
}

export async function analyzeLive(task: Task, token: string, signal: AbortSignal, suppliedId?: string): Promise<ApiAnalysis> {
  const id = safeRequestId(suppliedId) ?? newRequestId();
  const started = Date.now();
  logClient("info", "review_request", {requestId:id});
  let response: Response;
  try {
    response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Request-ID': id },
      body: JSON.stringify(task),
      signal,
      cache: 'no-store',
    });
  } catch {
    logClient("warn", signal.aborted ? "review_timeout" : "review_network_failed",
      {requestId:id, category: signal.aborted ? "timeout" : "network", durationMs:Date.now()-started});
    throw new ApiError(signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
      signal.aborted ? "Analysis timed out. Please retry." : "Network error. Check your connection and retry.",0,id);
  }
  const requestId = safeRequestId(response.headers.get('X-Request-ID')) ?? id;
  logClient(response.ok ? "info" : "warn", "review_http_response",
    {requestId,status:response.status,durationMs:Date.now()-started});
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ApiError('INVALID_RESPONSE', 'The server returned an unreadable response.', response.status, requestId); }
  if (!response.ok) {
    const body = object(data) ? data : {};
    const code = typeof body.error === 'string' ? body.error : 'REQUEST_FAILED';
    let message = typeof body.message === 'string' ? body.message : 'Analysis could not be completed.';
    if (code === 'PREVIEW_AUTH_MISCONFIGURED') message = 'The server preview code is not configured correctly. Set PREVIEW_TOKEN to at least 24 characters in Cloudflare and retry.';
    else if (response.status === 401) message = 'The private preview access code does not match the server code. Use Forget code, then enter the current PREVIEW_TOKEN value.';
    else if (response.status === 429) message = 'Too many requests. Try again later.';
    else if (response.status === 503) message = 'AI analysis is currently disabled. Demo review is still available.';
    else if (code === 'AI_TRUNCATED') message = 'The model did not finish its response. Please retry.';
    else if (code === 'AI_INVALID_RESPONSE') message = 'The model returned an incomplete review. Please retry.';
    else if (response.status >= 500) message = 'The AI service could not complete the analysis. Please retry.';
    throw new ApiError(code, message, response.status, requestId);
  }
  if (!object(data) || data.mode !== 'ai' || data.analyzed !== true || !object(data.analysis)) {
    throw new ApiError('INVALID_RESPONSE', 'The server returned an unexpected analysis.', response.status, requestId);
  }
  const a = data.analysis;
  if (!['ready','needs_clarification','blocked'].includes(String(a.status)) ||
      typeof a.summary !== 'string' || typeof a.suggestedRewrite !== 'string' ||
      !['rewritten', 'clarification_draft', 'unavailable'].includes(String(a.rewriteStatus)) || !Array.isArray(a.findings)) {
    throw new ApiError('INVALID_RESPONSE', 'The analysis did not match the expected format.', response.status, requestId);
  }
  const findings: ApiFinding[] = [];
  for (const raw of a.findings) {
    if (!object(raw) || !['missing','ambiguity','contradiction','suggestion'].includes(String(raw.kind)) ||
        !['critical','important','suggestion'].includes(String(raw.severity)) ||
        typeof raw.title !== 'string' || typeof raw.detail !== 'string' ||
        typeof raw.question !== 'string' || !Array.isArray(raw.evidence) ||
        raw.evidence.some((e: unknown) => typeof e !== 'string')) {
      throw new ApiError('INVALID_RESPONSE', 'The findings were malformed.', response.status, requestId);
    }
    findings.push(raw as ApiFinding);
  }
  const context = object(a.reviewContext) && typeof a.reviewContext.domain === 'string' &&
    typeof a.reviewContext.type === 'string' && typeof a.reviewContext.inferred === 'boolean'
    ? {domain:a.reviewContext.domain,type:a.reviewContext.type,inferred:a.reviewContext.inferred}
    : undefined;
  const coverage = object(a.reviewCoverage) &&
    [a.reviewCoverage.checked,a.reviewCoverage.gaps,a.reviewCoverage.reported].every(x=>typeof x==='number' && Number.isInteger(x) && x>=0)
    ? {checked:a.reviewCoverage.checked as number,gaps:a.reviewCoverage.gaps as number,reported:a.reviewCoverage.reported as number}
    : undefined;
  return { status: a.status as ApiAnalysis['status'], summary: a.summary, findings, suggestedRewrite: a.suggestedRewrite,
    rewriteStatus: a.rewriteStatus as ApiAnalysis['rewriteStatus'], reviewContext: context, reviewCoverage: coverage };
}
