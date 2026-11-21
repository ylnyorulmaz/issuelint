import type { BackendMode } from "./settings.ts";

/**
 * Sample responses for Mock mode, one per backend shape. They describe a fictional checkout ticket and are
 * deliberately NOT derived from the clipped page, so they can never be mistaken for a real review.
 */

/** Generic custom-backend contract (see README). */
export const MOCK_RESPONSE = {
  status: "needs_clarification",
  summary:
    "The ticket names the feature and the affected page, but it does not define when the work is done, conflicts on which currencies are in scope, and depends on an API that is not linked.",
  counts: { gaps: 3, clear: 7, not_applicable: 1 },
  checks: [
    {
      dimension: "contradictions",
      assessment: "gap",
      severity: "critical",
      title: "Currency scope conflicts",
      detail: "The description limits the change to USD, but the checklist expects EUR prices as well.",
      evidence: ["Only USD prices are affected", "Verify EUR totals on the summary step"],
      question: "Should EUR totals change in this ticket, or only USD?",
    },
    {
      dimension: "completion",
      assessment: "gap",
      severity: "important",
      title: "No definition of done",
      detail: "Nothing states how a reviewer confirms the rounding fix is complete.",
      evidence: ["Fix rounding on the checkout summary"],
      question: "What result should a reviewer see on the summary step for the work to count as done?",
    },
    {
      dimension: "references",
      assessment: "gap",
      severity: "suggestion",
      title: "Pricing API is mentioned but not linked",
      detail: "The task depends on the pricing service response but gives no link to its spec.",
      evidence: ["use the new pricing API response"],
      question: "Which pricing API version or document should the implementation follow?",
    },
    { dimension: "actionability", assessment: "clear" },
    { dimension: "scope", assessment: "clear" },
    { dimension: "granularity", assessment: "clear" },
    { dimension: "behavior", assessment: "clear" },
    { dimension: "outcome", assessment: "clear" },
    { dimension: "dependencies", assessment: "clear" },
    { dimension: "clarity", assessment: "clear" },
    { dimension: "feasibility", assessment: "not_applicable" },
  ],
};

const gate = (dimension: string, assessment: string, clear: number, gap: number) => ({
  dimension,
  assessment,
  confidence: Math.max(clear, gap, 1 - clear - gap),
  probabilities: { clear, gap, not_applicable: Math.round((1 - clear - gap) * 1000) / 1000 },
});

const GEMINI_GATES = [
  gate("contradictions", "gap", 0.12, 0.85),
  gate("actionability", "clear", 0.94, 0.05),
  gate("scope", "clear", 0.9, 0.08),
  gate("granularity", "clear", 0.91, 0.07),
  gate("behavior", "clear", 0.88, 0.1),
  gate("completion", "gap", 0.2, 0.78),
  gate("outcome", "clear", 0.87, 0.1),
  gate("references", "gap", 0.35, 0.6),
  gate("dependencies", "clear", 0.7, 0.25),
  gate("clarity", "clear", 0.93, 0.06),
  gate("feasibility", "not_applicable", 0.1, 0.05),
];

/** Shape of IssueLint POST /api/quick-scan. */
export const MOCK_QUICK_SCAN = {
  mode: "quick_scan",
  analyzed: true,
  scan: {
    model: "gemini-decision-1",
    checked: 11,
    durationMs: 1200,
    gates: GEMINI_GATES.map(({ dimension, assessment }) => ({ dimension, assessment })),
  },
};

/** Shape of IssueLint POST /api/analyze-v2 (partial audit, so the "unverified" state is visible too). */
export const MOCK_DECISION = {
  mode: "decision",
  analyzed: true,
  decision: {
    model: "gemini-decision-1",
    checked: 11,
    durationMs: 1300,
    gates: GEMINI_GATES,
    audit: {
      status: "partial",
      unverified: ["dependencies"],
      model: "@cf/openai/gpt-oss-120b",
      threshold: 0.85,
      selected: ["contradictions", "completion", "references", "dependencies"],
      durationMs: 9400,
      findings: [],
      checks: MOCK_RESPONSE.checks
        .filter((c) => c.assessment === "gap")
        .map((c) => ({
          dimension: c.dimension,
          assessment: "gap",
          reason: c.detail,
          severity: c.severity,
          kind: c.dimension === "contradictions" ? "contradiction" : "missing",
          title: c.title,
          evidence: c.evidence,
          question: c.question,
        })),
    },
  },
};

export function mockResponseFor(mode: BackendMode): unknown {
  return structuredClone(mode === "quick_scan" ? MOCK_QUICK_SCAN : mode === "analyze_v2" ? MOCK_DECISION : MOCK_RESPONSE);
}

export async function mockAnalyze(mode: BackendMode, signal: AbortSignal): Promise<unknown> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 900);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
  return mockResponseFor(mode);
}
