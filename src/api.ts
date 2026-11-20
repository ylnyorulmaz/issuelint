import type { Task } from './analyzer';

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
};
export type LiveResponse = { mode: 'ai'; analyzed: true; analysis: ApiAnalysis };
export type Health = { status: string; aiEnabled: boolean; aiBindingConfigured: boolean };

export class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
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

export async function analyzeLive(task: Task, token: string, signal: AbortSignal): Promise<ApiAnalysis> {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(task),
    signal,
    cache: 'no-store',
  });
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ApiError('INVALID_RESPONSE', 'The server returned an unreadable response.'); }
  if (!response.ok) {
    const body = object(data) ? data : {};
    const code = typeof body.error === 'string' ? body.error : 'REQUEST_FAILED';
    let message = typeof body.message === 'string' ? body.message : 'Analysis could not be completed.';
    if (response.status === 401) message = 'The private preview access code is missing or incorrect.';
    else if (response.status === 429) message = 'Too many requests. Try again later.';
    else if (response.status === 503) message = 'AI analysis is currently disabled. Demo review is still available.';
    else if (response.status >= 500) message = 'The AI service could not complete the analysis. Please retry.';
    throw new ApiError(code, message);
  }
  if (!object(data) || data.mode !== 'ai' || data.analyzed !== true || !object(data.analysis)) {
    throw new ApiError('INVALID_RESPONSE', 'The server returned an unexpected analysis.');
  }
  const a = data.analysis;
  if (!['ready','needs_clarification','blocked'].includes(String(a.status)) ||
      typeof a.summary !== 'string' || typeof a.suggestedRewrite !== 'string' || !Array.isArray(a.findings)) {
    throw new ApiError('INVALID_RESPONSE', 'The analysis did not match the expected format.');
  }
  const findings: ApiFinding[] = [];
  for (const raw of a.findings) {
    if (!object(raw) || !['missing','ambiguity','contradiction','suggestion'].includes(String(raw.kind)) ||
        !['critical','important','suggestion'].includes(String(raw.severity)) ||
        typeof raw.title !== 'string' || typeof raw.detail !== 'string' ||
        typeof raw.question !== 'string' || !Array.isArray(raw.evidence) ||
        raw.evidence.some((e: unknown) => typeof e !== 'string')) {
      throw new ApiError('INVALID_RESPONSE', 'The findings were malformed.');
    }
    findings.push(raw as ApiFinding);
  }
  return { status: a.status as ApiAnalysis['status'], summary: a.summary, findings, suggestedRewrite: a.suggestedRewrite };
}
