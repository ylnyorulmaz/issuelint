/**
 * Normalizes a backend response into what the side panel renders.
 *
 * Preferred contract (see README):
 *   { status, summary?, counts?, checks?: Check[], findings?: Finding[] }
 * `checks` carries one assessment per dimension (clear | gap | not_applicable);
 * `findings` is accepted on its own for backends that only report gaps.
 * The response may also be wrapped as { analysis: {...} } or { result: {...} }.
 */

export type ReadinessStatus = "ready" | "needs_clarification" | "blocked" | "unknown";
export type Assessment = "gap" | "clear" | "not_applicable";

export interface ScorecardFinding {
  dimension: string;
  severity: string;
  issue: string;
  detail: string;
  evidence: string[];
  question: string;
}

export interface Scorecard {
  status: ReadinessStatus;
  summary: string;
  counts: { gaps: number; clear: number; notApplicable: number };
  findings: ScorecardFinding[];
  /** Per-dimension assessment when the backend reported one. */
  dimensions: { dimension: string; assessment: Assessment }[];
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

export function normalizeScorecard(input: unknown): Scorecard {
  const raw = unwrap(input);
  const status = normalizeStatus(raw.status);
  const hasChecks = Array.isArray(raw.checks);
  const hasFindings = Array.isArray(raw.findings);
  if (status === "unknown" && !hasChecks && !hasFindings) {
    throw new ScorecardError("The API response has no status, checks or findings.");
  }

  const dimensions: Scorecard["dimensions"] = [];
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
  };

  return {
    status,
    summary: text(raw.summary) || text(raw.message),
    counts,
    findings,
    dimensions,
  };
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
