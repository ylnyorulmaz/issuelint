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
export type DecisionAssessment = 'clear' | 'gap' | 'not_applicable';
export type DecisionDimension = 'contradictions' | 'actionability' | 'scope' | 'granularity' |
  'behavior' | 'completion' | 'outcome' | 'references' | 'dependencies' | 'clarity' | 'feasibility';
export type DecisionGate = {
  dimension: DecisionDimension;
  assessment: DecisionAssessment;
  confidence: number;
  probabilities: Record<DecisionAssessment, number>;
};
export type DecisionAuditCheck = {
  dimension: DecisionDimension;
  assessment: DecisionAssessment;
  reason: string;
  severity: ApiFinding['severity'];
  kind: ApiFinding['kind'];
  title: string;
  evidence: string[];
  question: string;
};
export type ApiDecisionAudit = {
  status: 'complete' | 'partial' | 'unavailable';
  unverified: DecisionDimension[];
  model: '@cf/openai/gpt-oss-120b';
  threshold: 0.85;
  selected: DecisionDimension[];
  checks: DecisionAuditCheck[];
  findings: ApiFinding[];
  durationMs: number;
  errorCategory?: 'upstream' | 'truncated' | 'invalid_response' | 'not_configured';
};
export type ApiDecisionResult = {
  model: 'gemini-decision-1';
  gates: DecisionGate[];
  checked: number;
  durationMs: number;
  audit: ApiDecisionAudit;
};
export type Health = { status: string; aiEnabled: boolean; aiBindingConfigured: boolean; decisionConfigured: boolean };

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
    return { status: String(json.status ?? 'unknown'), aiEnabled: json.aiEnabled, aiBindingConfigured: json.aiBindingConfigured,
      decisionConfigured: json.decisionConfigured === true };
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


const DECISION_DIMENSIONS: DecisionDimension[] = [
  'contradictions','actionability','scope','granularity','behavior','completion',
  'outcome','references','dependencies','clarity','feasibility',
];
const DECISION_ASSESSMENTS: DecisionAssessment[] = ['clear','gap','not_applicable'];
const isProbability = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Separate V2 transport; V1 analyzeLive and its output contract are unchanged. */
export async function analyzeDecisionLive(
  task: Task, token: string, signal: AbortSignal, suppliedId?: string,
): Promise<ApiDecisionResult> {
  const id = safeRequestId(suppliedId) ?? newRequestId();
  const started = Date.now();
  logClient('info', 'decision_request', {requestId:id});
  let response: Response;
  try {
    response = await fetch('/api/analyze-v2', {
      method:'POST', cache:'no-store', signal,
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Request-ID':id},
      body:JSON.stringify(task),
    });
  } catch {
    logClient('warn', signal.aborted ? 'decision_cancelled' : 'decision_network_failed',
      {requestId:id,category:signal.aborted?'timeout':'network',durationMs:Date.now()-started});
    throw new ApiError(signal.aborted ? 'CANCELLED' : 'NETWORK_ERROR',
      signal.aborted ? 'Decision review cancelled.' : 'Network error. Please retry.',0,id);
  }
  const requestId = safeRequestId(response.headers.get('X-Request-ID')) ?? id;
  logClient(response.ok?'info':'warn','decision_http_response',
    {requestId,status:response.status,durationMs:Date.now()-started});
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ApiError('INVALID_RESPONSE','Gemini returned an unreadable response.',response.status,requestId); }
  if (!response.ok) {
    const data = object(body) ? body : {};
    const code = typeof data.error==='string' ? data.error : 'DECISION_UNAVAILABLE';
    const msg = code==='DECISION_NOT_CONFIGURED' ?
      'Gemini Decision 1 is not configured. Add GEMINI_API_KEY to Cloudflare Worker secrets.' :
      response.status===401?'Private access code is missing or incorrect.' :
      response.status===429?'Too many requests. Try again later.' :
      code==='DECISION_RATE_LIMIT'?'Gemini rate limit reached. Try again later.' :
      response.status>=500?'Gemini Decision review is unavailable. Try again later.' :
      'Could not complete the Decision review.';
    throw new ApiError(code,msg,response.status,requestId);
  }
  if (!object(body) || body.mode!=='decision' || body.analyzed!==true || !object(body.decision))
    throw new ApiError('INVALID_RESPONSE','The server returned an invalid Decision review.',response.status,requestId);
  const d = body.decision;
  if (d.model!=='gemini-decision-1' || d.checked!==11 || !Array.isArray(d.gates) ||
      d.gates.length!==DECISION_DIMENSIONS.length || typeof d.durationMs!=='number' ||
      !Number.isFinite(d.durationMs) || d.durationMs<0)
    throw new ApiError('INVALID_RESPONSE','Incomplete Decision scorecard.',response.status,requestId);
  const gates: DecisionGate[] = [];
  const seen=new Set<string>();
  for (const entry of d.gates) {
    if (!object(entry) || typeof entry.dimension!=='string' ||
        !DECISION_DIMENSIONS.includes(entry.dimension as DecisionDimension) ||
        seen.has(entry.dimension) || !DECISION_ASSESSMENTS.includes(entry.assessment as DecisionAssessment) ||
        !isProbability(entry.confidence) || !object(entry.probabilities) ||
        Object.keys(entry.probabilities).length!==3 ||
        !DECISION_ASSESSMENTS.every(x=>isProbability((entry.probabilities as Record<string,unknown>)[x])))
      throw new ApiError('INVALID_RESPONSE','Malformed Decision gate.',response.status,requestId);
    seen.add(entry.dimension);
    const p=entry.probabilities;
    if (Math.abs((p.clear as number)+(p.gap as number)+(p.not_applicable as number)-1)>.02)
      throw new ApiError('INVALID_RESPONSE','Malformed Decision probabilities.',response.status,requestId);
    gates.push({
      dimension:entry.dimension as DecisionDimension,
      assessment:entry.assessment as DecisionAssessment,
      confidence:entry.confidence as number,
      probabilities:{
        clear:p.clear as number,gap:p.gap as number,not_applicable:p.not_applicable as number,
      },
    });
  }
  if (!object(d.audit)) throw new ApiError('INVALID_RESPONSE','Missing independent audit state.',response.status,requestId);
  const auditRaw=d.audit;
  // Runtime Array.isArray guards below validate these untrusted values before use.
  const auditChecks=auditRaw.checks as unknown[];
  const auditFindings=auditRaw.findings as unknown[];
  const expectedSelected=gates.filter(g=>g.probabilities.clear<0.85).map(g=>g.dimension);
  const fail=(): never => {throw new ApiError('INVALID_RESPONSE','Malformed independent audit.',response.status,requestId);};
  if (!['complete','partial','unavailable'].includes(String(auditRaw.status)) ||
      auditRaw.model!=='@cf/openai/gpt-oss-120b' || auditRaw.threshold!==0.85 ||
      !Array.isArray(auditRaw.selected) || auditRaw.selected.length!==expectedSelected.length ||
      auditRaw.selected.some((v,i)=>v!==expectedSelected[i]) ||
      !Array.isArray(auditRaw.unverified) ||
      !Array.isArray(auditChecks) || !Array.isArray(auditFindings) ||
      auditFindings.length>5 || typeof auditRaw.durationMs!=='number' ||
      !Number.isFinite(auditRaw.durationMs) || auditRaw.durationMs<0) fail();
  const status=auditRaw.status as ApiDecisionAudit['status'];
  const unverified=auditRaw.unverified as DecisionDimension[];
  if (new Set(unverified).size!==unverified.length ||
      unverified.some(v=>!expectedSelected.includes(v)) ||
      unverified.length+auditChecks.length!==expectedSelected.length ||
      (status==='complete' && unverified.length>0) ||
      (status==='partial' && (unverified.length===0 || auditChecks.length===0)) ||
      (status==='unavailable' && (auditChecks.length!==0 || auditFindings.length!==0 ||
        !['upstream','truncated','invalid_response','not_configured'].includes(String(auditRaw.errorCategory)))))
    fail();
  const verifiedDimensions=expectedSelected.filter(v=>!unverified.includes(v));
  const knownKinds=['missing','ambiguity','contradiction','suggestion'];
  const knownSeverities=['critical','important','suggestion'];
  const quoteValid=(value:unknown)=>Array.isArray(value) && value.length<=2 &&
    value.every(v=>typeof v==='string' && v.length<=260);
  const checkedAudits: DecisionAuditCheck[]=[];
  for (const [i,raw] of auditChecks.entries()) {
    const v=raw as Record<string,unknown>;
    if (!object(v) || v.dimension!==verifiedDimensions[i] ||
        !DECISION_ASSESSMENTS.includes(v.assessment as DecisionAssessment) ||
        typeof v.reason!=='string' || v.reason.trim().length<8 || v.reason.length>800 ||
        !knownKinds.includes(String(v.kind)) || !knownSeverities.includes(String(v.severity)) ||
        typeof v.title!=='string' || v.title.length>160 ||
        typeof v.question!=='string' || v.question.length>300 || !quoteValid(v.evidence)) fail();
    if (v.assessment==='gap' && ((v.title as string).trim().length<3 || (v.question as string).trim().length<8 ||
        (v.evidence as string[]).length===0 || (v.kind==='contradiction' && (v.evidence as string[]).length!==2))) fail();
    if (v.assessment!=='gap' && (v.title!=='' || v.question!=='' ||
        (v.evidence as string[]).length!==0)) fail();
    checkedAudits.push(v as DecisionAuditCheck);
  }
  const findings:ApiFinding[]=[];
  for (const raw of auditFindings) {
    const v=raw as Record<string,unknown>;
    if (!object(v) || !knownKinds.includes(String(v.kind)) ||
        !knownSeverities.includes(String(v.severity)) || typeof v.title!=='string' ||
        typeof v.detail!=='string' || typeof v.question!=='string' || !quoteValid(v.evidence)) fail();
    findings.push(v as ApiFinding);
  }
  const audit:ApiDecisionAudit={
    status,model:'@cf/openai/gpt-oss-120b',threshold:0.85,
    selected:expectedSelected,unverified,checks:checkedAudits,findings,durationMs:auditRaw.durationMs as number,
    ...(status==='unavailable'?{errorCategory:auditRaw.errorCategory as ApiDecisionAudit['errorCategory']}:{})
  };
  return {model:'gemini-decision-1',gates,checked:11,durationMs:d.durationMs as number,audit};
}
