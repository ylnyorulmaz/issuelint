import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.ts";
import { parseTask, parseAnalysis, ValidationError } from "../worker/schema.ts";
import { extractJsonResponse, selectModel } from "../worker/inference.ts";

const url = "https://issuelint.example";
const originalTask = {
  title: "Contact all leads today",
  description: "Only qualified leads can be contacted after approval tomorrow.",
  type: "General",
  domain: "Sales",
  criteria: "",
  context: "",
};
const validAnalysis = {
  status: "blocked",
  summary: "Timing and audience instructions conflict.",
  findings: [{
    kind: "contradiction",
    severity: "critical",
    title: "Conflicting audience and deadline",
    detail: "The title asks for all leads today; the description limits outreach until tomorrow.",
    evidence: ["Contact all leads today", "Only qualified leads can be contacted after approval tomorrow."],
    question: "Should the deadline move until after approval?",
  }],
  suggestedRewrite: "Contact qualified leads after approval tomorrow. Confirm the new deadline before outreach.",
};

function makeEnv(overrides = {}) {
  const calls = [];
  const env = {
    ANALYZE_ENABLED: "true",
    PREVIEW_TOKEN: "test-preview-secret-with-24-plus-characters",
    AI_MODEL: "@cf/openai/gpt-oss-20b",
    AI: {
      async run(model, options) {
        calls.push({ model, options });
        return { choices: [{ message: { content: JSON.stringify(validAnalysis) }, finish_reason: "stop" }] };
      },
    },
    ASSETS: { async fetch() { return new Response("STATIC_ASSET_OK"); } },
    ...overrides,
  };
  return { env, calls };
}

function post(body = originalTask, headers = {}) {
  return new Request(url + "/api/analyze", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-preview-secret-with-24-plus-characters",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET /api/health reports Iteration 2 without running AI", async () => {
  const { env, calls } = makeEnv({ ANALYZE_ENABLED: "false" });
  const res = await worker.fetch(new Request(url + "/api/health"), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.iteration, 2);
  assert.equal(data.aiEnabled, false);
  assert.equal(data.aiBindingConfigured, true);
  assert.equal(calls.length, 0);
});

test("disabled AI endpoint is fail-closed and does not infer", async () => {
  const { env, calls } = makeEnv({ ANALYZE_ENABLED: "false" });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "AI_DISABLED");
  assert.equal(calls.length, 0);
});

test("unauthenticated requests cannot invoke live model", async () => {
  const { env, calls } = makeEnv();
  const res = await worker.fetch(post(originalTask, { authorization: "" }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "PREVIEW_AUTH_REQUIRED");
  assert.equal(calls.length, 0);
});

test("missing preview secret also blocks inference", async () => {
  const { env } = makeEnv({ PREVIEW_TOKEN: undefined });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 401);
});

test("valid analysis calls the native AI binding once and returns validated JSON", async () => {
  const { env, calls } = makeEnv();
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "ai");
  assert.equal(data.analyzed, true);
  assert.deepEqual(data.analysis, { ...validAnalysis, rewriteStatus: 'rewritten' });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "@cf/openai/gpt-oss-20b");
  assert.equal(calls[0].options.response_format.type, "json_schema");
  assert.equal(calls[0].options.stream, false);
  assert.equal(calls[0].options.reasoning_effort, "low");
  assert.equal(calls[0].options.max_tokens, 1600);
  assert.match(calls[0].options.messages[1].content, /Contact all leads today/);
});

test("missing or unsupported media type is rejected", async () => {
  const { env, calls } = makeEnv();
  const res = await worker.fetch(post(originalTask, { "content-type": "text/plain" }), env);
  assert.equal(res.status, 415);
  assert.equal(calls.length, 0);
});

test("invalid task fields are rejected without calling AI", async () => {
  const { env, calls } = makeEnv();
  const res = await worker.fetch(post({ ...originalTask, type: "Whatever" }), env);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, "INVALID_TASK");
  assert.equal(calls.length, 0);
});

test("malformed JSON receives 400", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(post("{not valid JSON"), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_JSON");
});

test("oversized body is rejected before calling AI", async () => {
  const { env, calls } = makeEnv();
  const res = await worker.fetch(post({ ...originalTask, description: "a".repeat(35_000) }), env);
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

test("model-output hallucinated evidence is not passed through", async () => {
  const analysis = structuredClone(validAnalysis);
  analysis.findings[0].evidence = ["Completely fictional quote", "Also not in source"];
  const { env } = makeEnv({ AI: { run: async () => ({ choices: [{ message: { content: JSON.stringify(analysis) } }] }) } });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "AI_INVALID_RESPONSE");
});

test("malformed model response is not shown as an analysis", async () => {
  const { env } = makeEnv({ AI: { run: async () => ({ choices: [{ message: { content: "not json" } }] }) } });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "AI_INVALID_RESPONSE");
});

test("truncated model completion returns an explicit error", async () => {
  const { env } = makeEnv({ AI: { run: async () => ({ choices: [{ message: { content: null, reasoning: "long chain of thought" }, finish_reason: "length" }] }) } });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "AI_TRUNCATED");
});

test("upstream failure is not retried and exposes no provider details", async () => {
  let callCount = 0;
  const { env } = makeEnv({ AI: { run: async () => { callCount++; throw Error("provider secret details"); } } });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, "AI_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(body), /provider secret/);
  assert.equal(callCount, 1);
});

test("unsupported model configuration falls back to allowlisted default", () => {
  assert.equal(selectModel("@cf/attacker/arbitrary-expensive-model"), "@cf/openai/gpt-oss-20b");
  assert.equal(selectModel("@cf/openai/gpt-oss-20b"), "@cf/openai/gpt-oss-20b");
});

test("accepts object response variants from Workers AI", () => {
  const task = parseTask(originalTask);
  assert.deepEqual(extractJsonResponse({ response: validAnalysis }), validAnalysis);
  assert.deepEqual(parseAnalysis(validAnalysis, task), validAnalysis);
});

test("no forced findings for a clear task", () => {
  const task = parseTask(originalTask);
  const clean = { status: "ready", summary: "Task is clear enough.", findings: [], suggestedRewrite: "Contact all leads today." };
  assert.deepEqual(parseAnalysis(clean, task).findings, []);
});

test("contradiction without two verifiable source quotes is rejected", () => {
  const task = parseTask(originalTask);
  const invalid = structuredClone(validAnalysis);
  invalid.findings[0].evidence = ["Contact all leads today"];
  assert.throws(() => parseAnalysis(invalid, task), ValidationError);
});

test("unknown API routes do not fall back to SPA", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request(url + "/api/unknown"), env);
  assert.equal(res.status, 404);
});

test("other paths continue to use static asset binding", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request(url + "/"), env);
  assert.equal(await res.text(), "STATIC_ASSET_OK");
});

test("GET /api/analyze is rejected", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request(url + "/api/analyze"), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("empty primary draft triggers one focused AI rewrite repair", async () => {
  let calls = 0;
  const first = { ...validAnalysis, suggestedRewrite: "" };
  const { env } = makeEnv({ AI: { run: async (_model, input) => {
    calls++;
    assert.equal(input.response_format.type, "json_schema");
    return { choices: [{ message: { content: JSON.stringify(calls === 1
      ? first
      : { suggestedRewrite: "Follow up with qualified leads after copy approval tomorrow. Open questions: Should the original today deadline be changed? Which leads qualify?" }) }, finish_reason: "stop" }] };
  } } });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.analysis.rewriteStatus, "rewritten");
  assert.match(body.analysis.suggestedRewrite, /Open questions/);
  assert.equal(calls, 2);
});

test("verbatim copy in primary output triggers rewrite repair", async () => {
  let calls = 0;
  const same = [originalTask.title, originalTask.description].join("\\n\\n");
  const { env } = makeEnv({ AI: { run: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify(calls === 1
      ? { ...validAnalysis, suggestedRewrite: same }
      : { suggestedRewrite: "Task: Contact qualified leads once outreach copy has been approved. Clarify whether the deadline should move from today to tomorrow." }) }, finish_reason: "stop" }] };
  } } });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(calls, 2);
  assert.equal(body.analysis.rewriteStatus, "rewritten");
  assert.notEqual(body.analysis.suggestedRewrite, same);
});

test("failed second rewrite retains findings and labels a question checklist", async () => {
  let calls = 0;
  const { env } = makeEnv({ AI: { run: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify(calls === 1
      ? { ...validAnalysis, suggestedRewrite: "" }
      : { suggestedRewrite: "" }) }, finish_reason: "stop" }] };
  } } });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(calls, 2);
  assert.equal(body.analysis.rewriteStatus, "clarification_draft");
  assert.match(body.analysis.suggestedRewrite, /Open questions/);
  assert.match(body.analysis.suggestedRewrite, /Should the deadline move/);
  assert.equal(body.analysis.findings.length, 1);
});

test("no findings and no revised text shows unavailable, not a fake rewrite", async () => {
  let calls = 0;
  const review = { ...validAnalysis, status: "ready", findings: [], suggestedRewrite: "" };
  const { env } = makeEnv({ AI: { run: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify(calls === 1
      ? review : { suggestedRewrite: "" }) }, finish_reason: "stop" }] };
  } } });
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.analysis.rewriteStatus, "unavailable");
  assert.equal(body.analysis.suggestedRewrite, "");
  assert.equal(calls, 2);
});
