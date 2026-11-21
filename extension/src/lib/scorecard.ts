/**
 * Normalizes a backend response into what the side panel renders.
 *
 * Three shapes are understood:
 *  - IssueLint Quick Scan  (POST /api/quick-scan):  { mode: "quick_scan", scan: { gates: [{dimension, assessment}] } }
 *  - IssueLint Decision    (POST /api/analyze-v2):  { mode: "decision", decision: { gates, audit } }
 *  - Generic custom backend contract (see README):
 *   { status, summary?, counts?, checks?: Check[], findings?: Finding[] }
 * `checks` carries one assessment per dimension (clear | gap | not_applicable);
 * `findings` is accepted on its own for backends that only report gaps.
 * The response may also be wrapped as { analysis: {...} } or { result: {...} }.
 */

export type ReadinessStatus = "ready" | "needs_clarification" | "blocked" | "unknown";
export type Assessment = "gap" | "clear" | "not_applicable";
export type ScorecardKind = "quick_scan" | "decision" | "generic";
/** What the UI shows per dimension. `unverified` is never a pass. */
export type Mark = "pass" | "issue" | "not_applicable" | "unverified";

export interface DimensionResult {
  dimension: string;
  mark: Mark;
  /** Who decided the mark (Decision mode only). */
  source?: "gpt-oss" | "gemini" | "unverified";
  /** Gemini screening probability P(clear), Decision mode only. Not a verified accuracy. */
  pClear?: number;
}

export interface AuditSummary {
  status: "complete" | "partial" | "unavailable";
  selected: string[];
  unverified: string[];
  threshold: number;
}

export interface ScorecardFinding {
  dimension: string;
  severity: string;
  issue: string;
  detail: string;
  evidence: string[];
  question: string;
}

export interface Scorecard {
  kind: ScorecardKind;
  /** Only the generic contract carries a readiness status; IssueLint screens do not. */
  status: ReadinessStatus;
  summary: string;
  counts: { gaps: number; clear: number; notApplicable: number; unverified: number };
  findings: ScorecardFinding[];
  /** Per-dimension result when the backend reported one. */
  dimensions: DimensionResult[];
  audit?: AuditSummary;
}

export class ScorecardError extends Error {}

const MAX_ITEMS = 50;
const MAX_TEXT = 2_000;

export const DIMENSION_LABELS: Record<string, string> = {
  contradictions: "Contradictions",
  actionability: "Actionability",
  scope: "Scope",
  granularity: "Granularity",
  behavior: "Expected behavior",
  completion: "Definition of done",
  outcome: "Outcome",
  references: "References",
  dependencies: "Dependencies",
  clarity: "Clarity",
  feasibility: "Feasibility",
};

export const STATUS_LABELS: Record<ReadinessStatus, string> = {
  ready: "Ready",
  needs_clarification: "Needs Clarification",
  blocked: "Blocked",
  unknown: "Unknown",
};

export function dimensionLabel(id: string): string {
  if (DIMENSION_LABELS[id]) return DIMENSION_LABELS[id];
  const words = id.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "General";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "";
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

export function normalizeStatus(v: unknown): ReadinessStatus {
  const s = text(v).toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "ready") return "ready";
  if (s === "blocked") return "blocked";
  if (s === "needs_clarification" || s === "needsclarification" || s === "clarify") return "needs_clarification";
  return "unknown";
}

function normalizeAssessment(v: unknown): Assessment | undefined {
  const s = text(v).toLowerCase().replace(/[\s/-]+/g, "_");
  if (s === "gap") return "gap";
  if (s === "clear" || s === "pass") return "clear";
  if (s === "not_applicable" || s === "n_a" || s === "na") return "not_applicable";
  return undefined;
}

function evidenceList(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return items.map(text).filter(Boolean).slice(0, 5);
}

function toFinding(raw: Record<string, unknown>): ScorecardFinding | undefined {
  const issue = text(raw.issue) || text(raw.title);
  const detail = text(raw.detail) || text(raw.explanation) || text(raw.description);
  if (!issue && !detail) return undefined;
  return {
    dimension: text(raw.dimension) || text(raw.gate) || "general",
    severity: text(raw.severity).toLowerCase(),
    issue: issue || detail,
    detail: issue ? detail : "",
    evidence: evidenceList(raw.evidence ?? raw.quotes ?? raw.quote),
    question: text(raw.question) || text(raw.clarification_question) || text(raw.clarificationQuestion),
  };
}

function unwrap(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) throw new ScorecardError("The API did not return a JSON object.");
  for (const key of ["analysis", "result", "data"]) {
    const inner = raw[key];
    if (isObj(inner) && ("status" in inner || "checks" in inner || "findings" in inner)) {
      // Keep top-level fields (e.g. checks next to analysis) available to the caller.
      return { ...raw, ...inner, checks: inner.checks ?? raw.checks, findings: inner.findings ?? raw.findings };
    }
  }
  return raw;
}

function normalizeGeneric(input: unknown): Scorecard {
  const raw = unwrap(input);
  const status = normalizeStatus(raw.status);
  const hasChecks = Array.isArray(raw.checks);
  const hasFindings = Array.isArray(raw.findings);
  if (status === "unknown" && !hasChecks && !hasFindings) {
    throw new ScorecardError("The API response has no status, checks or findings.");
  }

  const dimensions: { dimension: string; assessment: Assessment }[] = [];
  const findings: ScorecardFinding[] = [];

  if (hasChecks) {
    for (const item of (raw.checks as unknown[]).slice(0, MAX_ITEMS)) {
      if (!isObj(item)) continue;
      const assessment = normalizeAssessment(item.assessment ?? item.choice ?? item.decision);
      const dimension = text(item.dimension) || text(item.gate);
      if (!assessment || !dimension) continue;
      dimensions.push({ dimension, assessment });
      if (assessment === "gap") {
        const f = toFinding({ ...item, dimension });
        if (f) findings.push(f);
      }
    }
  }
  // Explicit findings win over gap checks when both are present (they are the final, deduplicated list).
  if (hasFindings) {
    const explicit = (raw.findings as unknown[])
      .slice(0, MAX_ITEMS)
      .flatMap((f) => (isObj(f) ? [toFinding(f)] : []))
      .filter((f): f is ScorecardFinding => !!f);
    if (explicit.length || !findings.length) findings.splice(0, findings.length, ...explicit);
  }

  const c = isObj(raw.counts) ? raw.counts : isObj(raw.summary_counts) ? raw.summary_counts : {};
  const fromDims = (a: Assessment) => dimensions.filter((d) => d.assessment === a).length;
  const counts = {
    gaps: count(c.gaps) ?? (dimensions.length ? fromDims("gap") : findings.length),
    clear: count(c.clear) ?? fromDims("clear"),
    notApplicable: count(c.not_applicable) ?? count(c.notApplicable) ?? count(c.na) ?? fromDims("not_applicable"),
    unverified: 0,
  };

  return {
    kind: "generic",
    status,
    summary: text(raw.summary) || text(raw.message),
    counts,
    findings,
    dimensions: dimensions.map((d) => ({ dimension: d.dimension, mark: markOf(d.assessment) })),
  };
}

function markOf(a: Assessment): Mark {
  return a === "gap" ? "issue" : a === "clear" ? "pass" : "not_applicable";
}

function strictAssessment(v: unknown): Assessment | undefined {
  return v === "clear" || v === "gap" || v === "not_applicable" ? v : undefined;
}

function countMarks(dimensions: DimensionResult[]): Scorecard["counts"] {
  const n = (m: Mark) => dimensions.filter((d) => d.mark === m).length;
  return { gaps: n("issue"), clear: n("pass"), notApplicable: n("not_applicable"), unverified: n("unverified") };
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_ITEMS) : [];
}

/** IssueLint POST /api/quick-scan: Gemini-only screen. ✓ = clear or N/A, ✕ = gap. No evidence, no status. */
function normalizeQuickScan(scan: Record<string, unknown>): Scorecard {
  const gates = Array.isArray(scan.gates) ? scan.gates.slice(0, MAX_ITEMS) : [];
  const dimensions: DimensionResult[] = [];
  for (const g of gates) {
    if (!isObj(g)) continue;
    const assessment = strictAssessment(g.assessment);
    const dimension = text(g.dimension);
    if (!assessment || !dimension) throw new ScorecardError("Quick Scan returned an invalid gate.");
    dimensions.push({ dimension, mark: markOf(assessment) });
  }
  if (!dimensions.length) throw new ScorecardError("Quick Scan returned no gates.");
  return { kind: "quick_scan", status: "unknown", summary: "", counts: countMarks(dimensions), findings: [], dimensions };
}

/**
 * IssueLint POST /api/analyze-v2. Mirrors presentDecisionGate() in the web app (src/decision-presentation.ts):
 * a validated GPT-OSS check wins; a gate selected for audit but not validated is unverified;
 * a Gemini "clear" counts only when P(clear) >= threshold; everything else is unverified.
 */
function normalizeDecision(decision: Record<string, unknown>): Scorecard {
  const gates = Array.isArray(decision.gates) ? decision.gates.slice(0, MAX_ITEMS) : [];
  const rawAudit = isObj(decision.audit) ? decision.audit : {};
  const auditStatus = rawAudit.status === "complete" || rawAudit.status === "partial" ? rawAudit.status : "unavailable";
  const threshold = typeof rawAudit.threshold === "number" && rawAudit.threshold > 0 && rawAudit.threshold <= 1
    ? rawAudit.threshold : 0.85;
  const audit: AuditSummary = {
    status: auditStatus,
    selected: stringList(rawAudit.selected),
    unverified: stringList(rawAudit.unverified),
    threshold,
  };
  const checks = (Array.isArray(rawAudit.checks) ? rawAudit.checks.slice(0, MAX_ITEMS) : [])
    .filter(isObj)
    .flatMap((c) => {
      const assessment = strictAssessment(c.assessment);
      const dimension = text(c.dimension);
      return assessment && dimension ? [{ raw: c as Record<string, unknown>, assessment, dimension }] : [];
    });

  const dimensions: DimensionResult[] = [];
  for (const g of gates) {
    if (!isObj(g)) continue;
    const assessment = strictAssessment(g.assessment);
    const dimension = text(g.dimension);
    if (!assessment || !dimension) throw new ScorecardError("Decision review returned an invalid gate.");
    const probs = isObj(g.probabilities) ? g.probabilities : {};
    const pClear = typeof probs.clear === "number" && probs.clear >= 0 && probs.clear <= 1 ? probs.clear : undefined;
    const reviewed = checks.find((c) => c.dimension === dimension);
    let result: DimensionResult;
    if (reviewed) result = { dimension, mark: markOf(reviewed.assessment), source: "gpt-oss" };
    else if (audit.selected.includes(dimension)) result = { dimension, mark: "unverified", source: "unverified" };
    else if (assessment === "not_applicable") result = { dimension, mark: "not_applicable", source: "gemini" };
    else if (assessment === "clear" && pClear !== undefined && pClear >= threshold) {
      result = { dimension, mark: "pass", source: "gemini" };
    } else result = { dimension, mark: "unverified", source: "unverified" };
    dimensions.push({ ...result, pClear });
  }
  if (!dimensions.length) throw new ScorecardError("Decision review returned no gates.");

  const findings = checks
    .filter((c) => c.assessment === "gap")
    .map((c) => ({
      dimension: c.dimension,
      severity: text(c.raw.severity).toLowerCase(),
      issue: text(c.raw.title) || "Gap found",
      detail: text(c.raw.reason),
      evidence: evidenceList(c.raw.evidence),
      question: text(c.raw.question),
    }));

  return { kind: "decision", status: "unknown", summary: "", counts: countMarks(dimensions), findings, dimensions, audit };
}

export function normalizeScorecard(input: unknown): Scorecard {
  if (isObj(input) && input.mode === "quick_scan" && isObj(input.scan)) return normalizeQuickScan(input.scan);
  if (isObj(input) && input.mode === "decision" && isObj(input.decision)) return normalizeDecision(input.decision);
  return normalizeGeneric(input);
}

/** Groups findings by dimension, preserving first-seen order. */
export function groupByDimension(findings: ScorecardFinding[]): [string, ScorecardFinding[]][] {
  const groups = new Map<string, ScorecardFinding[]>();
  for (const f of findings) {
    const list = groups.get(f.dimension) ?? [];
    list.push(f);
    groups.set(f.dimension, list);
  }
  return [...groups.entries()];
}
