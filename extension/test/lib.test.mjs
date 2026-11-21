import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupMarkdown, truncateMarkdown } from "../src/lib/markdown.ts";
import { checkApiUrl } from "../src/lib/api-url.ts";
import { normalizeScorecard, groupByDimension, normalizeStatus, ScorecardError } from "../src/lib/scorecard.ts";
import { MOCK_RESPONSE } from "../src/lib/mock.ts";

test("cleanupMarkdown removes empty links, empty bullets and extra blank lines", () => {
  const md = "# Title  \n\n\n\n[](https://x.test)\n-   \n- item\n![ ](a.png)\n[keep](  )\r\nend ";
  assert.equal(cleanupMarkdown(md), "# Title\n\n- item\n\nkeep\nend");
});

test("truncateMarkdown cuts on a line boundary and flags truncation", () => {
  const line = "x".repeat(99) + "\n";
  const { text, truncated } = truncateMarkdown(line.repeat(20), 1050);
  assert.equal(truncated, true);
  assert.equal(text.length, 999);
  assert.deepEqual(truncateMarkdown("short", 10), { text: "short", truncated: false });
});

test("checkApiUrl accepts https and localhost http only", () => {
  const ok = checkApiUrl(" https://api.example.com:8443/v1/clip ");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.originPattern, "https://api.example.com/*");
  assert.equal(checkApiUrl("http://localhost:8787/api").ok, true);
  assert.equal(checkApiUrl("http://api.example.com").ok, false);
  assert.equal(checkApiUrl("https://user:pw@api.example.com").ok, false);
  assert.equal(checkApiUrl("ftp://api.example.com").ok, false);
  assert.equal(checkApiUrl("not a url").ok, false);
  assert.equal(checkApiUrl("").ok, false);
});

test("mock response normalizes to a full 11-dimension scorecard", () => {
  const card = normalizeScorecard(structuredClone(MOCK_RESPONSE));
  assert.equal(card.status, "needs_clarification");
  assert.deepEqual(card.counts, { gaps: 3, clear: 7, notApplicable: 1, unverified: 0 });
  assert.equal(card.dimensions.length, 11);
  assert.equal(card.findings.length, 3);
  for (const f of card.findings) {
    assert.ok(f.issue && f.question && f.evidence.length > 0);
  }
  assert.deepEqual(groupByDimension(card.findings).map(([d]) => d), ["contradictions", "completion", "references"]);
});

test("counts are derived from checks when the backend omits them", () => {
  const card = normalizeScorecard({
    status: "Ready",
    checks: [
      { dimension: "scope", assessment: "clear" },
      { dimension: "outcome", assessment: "not_applicable" },
      { dimension: "clarity", assessment: "gap", title: "Ambiguous term", evidence: "the thing", question: "Which thing?" },
      { dimension: "bogus" },
    ],
  });
  assert.equal(card.status, "ready");
  assert.deepEqual(card.counts, { gaps: 1, clear: 1, notApplicable: 1, unverified: 0 });
  assert.deepEqual(card.findings[0].evidence, ["the thing"]);
});

test("findings-only and wrapped responses are accepted", () => {
  const card = normalizeScorecard({
    analysis: {
      status: "blocked",
      summary: "Two blockers.",
      findings: [
        { dimension: "dependencies", severity: "Critical", title: "Waiting on API", detail: "d", evidence: ["a"], question: "q?" },
        { issue: "No owner", clarification_question: "Who owns it?" },
      ],
    },
  });
  assert.equal(card.status, "blocked");
  assert.equal(card.counts.gaps, 2);
  assert.equal(card.findings[0].severity, "critical");
  assert.equal(card.findings[1].dimension, "general");
  assert.equal(card.findings[1].question, "Who owns it?");
});

test("unrecognized responses are rejected", () => {
  assert.throws(() => normalizeScorecard(null), ScorecardError);
  assert.throws(() => normalizeScorecard([1, 2]), ScorecardError);
  assert.throws(() => normalizeScorecard({ ok: true }), ScorecardError);
  assert.equal(normalizeStatus("needs clarification"), "needs_clarification");
  assert.equal(normalizeStatus(42), "unknown");
});

test("cleanupMarkdown tightens list markers but leaves code fences alone", () => {
  const md = "-   one\n    -   nested\n1.  first\n-   [x]  done\n```\n-   literal\n```";
  assert.equal(cleanupMarkdown(md), "- one\n    - nested\n1. first\n- [x] done\n```\n-   literal\n```");
});

const DIMS = ["contradictions", "actionability", "scope", "granularity", "behavior", "completion", "outcome", "references", "dependencies", "clarity", "feasibility"];

test("Quick Scan: gap is the only issue; N/A is not a gap; no status or findings", async () => {
  const { MOCK_QUICK_SCAN } = await import("../src/lib/mock.ts");
  const card = normalizeScorecard(structuredClone(MOCK_QUICK_SCAN));
  assert.equal(card.kind, "quick_scan");
  assert.equal(card.status, "unknown");
  assert.deepEqual(card.findings, []);
  assert.deepEqual(card.counts, { gaps: 3, clear: 7, notApplicable: 1, unverified: 0 });
  assert.equal(card.dimensions.length, 11);
  assert.throws(() => normalizeScorecard({ mode: "quick_scan", scan: { gates: [{ dimension: "scope", assessment: "maybe" }] } }), ScorecardError);
  assert.throws(() => normalizeScorecard({ mode: "quick_scan", scan: { gates: [] } }), ScorecardError);
});

const g = (dimension, assessment, clear) => ({ dimension, assessment, confidence: 0.9, probabilities: { clear, gap: 1 - clear, not_applicable: 0 } });

test("Decision: mirrors presentDecisionGate (GPT-OSS wins, selected-but-unchecked is unverified)", () => {
  const card = normalizeScorecard({
    mode: "decision",
    decision: {
      gates: [
        g("scope", "clear", 0.95),            // confident Gemini clear → pass
        g("clarity", "clear", 0.6),           // selected, GPT says clear → pass (gpt-oss)
        g("completion", "gap", 0.1),          // selected, GPT says gap → issue
        g("references", "gap", 0.2),          // selected, not returned → unverified
        g("outcome", "not_applicable", 0.9),  // Gemini N/A, not selected → N/A
        g("behavior", "gap", 0.9),            // not selected, Gemini gap ≥ threshold → unverified (never a pass)
      ],
      audit: {
        status: "partial", threshold: 0.85, selected: ["clarity", "completion", "references"], unverified: ["references"],
        checks: [
          { dimension: "clarity", assessment: "clear", reason: "", title: "", evidence: [], question: "" },
          { dimension: "completion", assessment: "gap", severity: "important", title: "No definition of done", reason: "Why", evidence: ["Fix rounding"], question: "What is done?" },
        ],
      },
    },
  });
  const marks = Object.fromEntries(card.dimensions.map((d) => [d.dimension, [d.mark, d.source]]));
  assert.deepEqual(marks, {
    scope: ["pass", "gemini"], clarity: ["pass", "gpt-oss"], completion: ["issue", "gpt-oss"],
    references: ["unverified", "unverified"], outcome: ["not_applicable", "gemini"], behavior: ["unverified", "unverified"],
  });
  assert.deepEqual(card.counts, { gaps: 1, clear: 2, notApplicable: 1, unverified: 2 });
  assert.equal(card.audit.status, "partial");
  assert.deepEqual(card.findings, [{ dimension: "completion", severity: "important", issue: "No definition of done", detail: "Why", evidence: ["Fix rounding"], question: "What is done?" }]);
  assert.equal(card.dimensions[0].pClear, 0.95);
});

test("Decision: unavailable audit leaves routed gates unverified", () => {
  const card = normalizeScorecard({
    mode: "decision",
    decision: { gates: DIMS.map((d) => g(d, "clear", d === "scope" ? 0.5 : 0.99)), audit: { status: "unavailable", selected: ["scope"], unverified: [], checks: [], threshold: 0.85 } },
  });
  assert.equal(card.dimensions.find((d) => d.dimension === "scope").mark, "unverified");
  assert.deepEqual(card.counts, { gaps: 0, clear: 10, notApplicable: 0, unverified: 1 });
  assert.equal(card.findings.length, 0);
});
