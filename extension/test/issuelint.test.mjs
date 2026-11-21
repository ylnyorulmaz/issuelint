import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIssueLintTask, buildRequestBody, checkPreviewCode, deriveTitle, ISSUELINT_LIMITS, resolveTarget,
} from "../src/lib/issuelint.ts";
import { mockAnalyze } from "../src/lib/mock.ts";
import { normalizeScorecard } from "../src/lib/scorecard.ts";

test("task uses the web app's paste defaults and the page title", () => {
  const r = buildIssueLintTask("  PAY-123   Fix rounding  ", "\n# Heading\n\nBody text\n");
  assert.deepEqual(r, { ok: true, value: { title: "PAY-123 Fix rounding", description: "# Heading\n\nBody text", type: "General", domain: "Other" } });
});

test("title falls back to the first Markdown line and is capped", () => {
  assert.equal(deriveTitle("", "\n\n## Ship dark mode\nmore"), "Ship dark mode");
  assert.equal(deriveTitle("x".repeat(300), "body").length, ISSUELINT_LIMITS.title);
  assert.equal(deriveTitle("", "y".repeat(300)).length, 120);
});

test("text over the Worker's 6,500-char description limit is rejected, not truncated", () => {
  const r = buildIssueLintTask("T", "a".repeat(6_501));
  assert.equal(r.ok, false);
  assert.match(r.error, /up to 6,500 characters\. Trim 1 more/);
  assert.equal(buildIssueLintTask("T", "a".repeat(6_500)).ok, true);
  assert.equal(buildIssueLintTask("T", "   ").ok, false);
});

test("custom mode keeps the clip payload", () => {
  const r = buildRequestBody("custom", { url: "https://x.test/1", title: "T", markdown: " md " });
  assert.deepEqual(r, { ok: true, value: { source_url: "https://x.test/1", page_title: "T", markdown: "md" } });
  const q = buildRequestBody("quick_scan", { url: "https://x.test/1", title: "T", markdown: "md" });
  assert.equal("source_url" in q.value, false, "IssueLint requests must not inject the URL into the task");
});

test("targets resolve to the real IssueLint routes", () => {
  const base = { serverUrl: "https://issuelint.com", apiUrl: "" };
  assert.deepEqual(resolveTarget({ ...base, mode: "quick_scan" }),
    { ok: true, value: { url: "https://issuelint.com/api/quick-scan", originPattern: "https://issuelint.com/*" } });
  assert.equal(resolveTarget({ ...base, serverUrl: "https://issuelint.com/some/path/", mode: "analyze_v2" }).value.url,
    "https://issuelint.com/api/analyze-v2");
  assert.equal(resolveTarget({ ...base, serverUrl: "http://localhost:8787", mode: "quick_scan" }).value.url,
    "http://localhost:8787/api/quick-scan");
  assert.equal(resolveTarget({ ...base, serverUrl: "http://issuelint.com", mode: "quick_scan" }).ok, false);
  assert.equal(resolveTarget({ ...base, mode: "custom" }).ok, false);
});

test("preview code check mirrors the Worker's shape rule", () => {
  assert.match(checkPreviewCode(""), /Enter your IssueLint preview access code/);
  assert.match(checkPreviewCode("short"), /at least 24/);
  assert.match(checkPreviewCode("a".repeat(12) + " " + "b".repeat(12)), /spaces/);
  assert.equal(checkPreviewCode("a".repeat(24)), null);
});

test("mock mode returns each backend shape without any network call", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network used in mock mode"); };
  try {
    const signal = new AbortController().signal;
    assert.equal(normalizeScorecard(await mockAnalyze("quick_scan", signal)).kind, "quick_scan");
    assert.equal(normalizeScorecard(await mockAnalyze("analyze_v2", signal)).kind, "decision");
    assert.equal(normalizeScorecard(await mockAnalyze("custom", signal)).kind, "generic");
  } finally {
    globalThis.fetch = realFetch;
  }
});
