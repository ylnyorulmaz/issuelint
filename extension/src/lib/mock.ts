/**
 * Sample response for Mock mode. It describes a fictional checkout ticket and is
 * deliberately NOT derived from the clipped page, so it can never be mistaken for a real review.
 */
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

export async function mockAnalyze(signal: AbortSignal): Promise<unknown> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 900);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
  return structuredClone(MOCK_RESPONSE);
}
