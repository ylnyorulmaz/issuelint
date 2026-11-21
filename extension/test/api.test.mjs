import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { postAnalysis, ApiError } from "../src/lib/api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const body = { title: "A-1", description: "# Task", type: "General", domain: "Other" };
const signal = () => new AbortController().signal;

test("posts JSON with Bearer code and a Worker-compatible request ID, no cookies", async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ mode: "quick_scan" }), { status: 200 });
  };
  const out = await postAnalysis({ url: "https://issuelint.com/api/quick-scan", body, apiKey: " code-123 ", signal: signal() });
  assert.deepEqual(out, { mode: "quick_scan" });
  assert.equal(seen.url, "https://issuelint.com/api/quick-scan");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), body);
  assert.equal(seen.init.headers.Authorization, "Bearer code-123");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  // IssueLint Worker SAFE_ID allowlist: /^[a-zA-Z0-9_-]{8,64}$/
  assert.match(seen.init.headers["X-Request-ID"], /^[a-zA-Z0-9_-]{8,64}$/);
  assert.equal(seen.init.credentials, "omit");
  assert.equal(seen.init.redirect, "error");
});

test("omits Authorization when no key is set", async () => {
  let headers;
  globalThis.fetch = async (_u, init) => { headers = init.headers; return new Response("{}", { status: 200 }); };
  await postAnalysis({ url: "https://api.example.com", body, apiKey: "", signal: signal() });
  assert.equal("Authorization" in headers, false);
});

test("Worker errors use the server message and keep the server request ID", async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "INVALID_TASK", message: "description must contain between 1 and 6500 characters." }),
    { status: 422, headers: { "X-Request-ID": "server-id-123" } });
  await assert.rejects(postAnalysis({ url: "https://issuelint.com/api/quick-scan", body, apiKey: "k", signal: signal() }),
    (err) => err instanceof ApiError && err.status === 422 && err.requestId === "server-id-123" &&
      err.message === "The API returned HTTP 422: description must contain between 1 and 6500 characters.");
});

test("401 points at the access code and never echoes it", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "PREVIEW_AUTH_REQUIRED", message: "A valid preview token is required." }), { status: 401 });
  await assert.rejects(postAnalysis({ url: "https://issuelint.com/api/analyze-v2", body, apiKey: "secret-code-value-xxxxxxxxxx", signal: signal() }),
    (err) => err.status === 401 && /access code was rejected/.test(err.message) && !err.message.includes("secret-code-value"));
});

test("rate limit and 503 messages are surfaced", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "DECISION_RATE_LIMIT", message: "Gemini Decision 1 rate limit reached. Try again later." }), { status: 502 });
  await assert.rejects(postAnalysis({ url: "https://issuelint.com/api/quick-scan", body, apiKey: "k", signal: signal() }), /rate limit reached.*Wait a bit/);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "AI_DISABLED", message: "Live analysis is not enabled in this environment." }), { status: 503 });
  await assert.rejects(postAnalysis({ url: "https://issuelint.com/api/quick-scan", body, apiKey: "k", signal: signal() }), /HTTP 503: Live analysis is not enabled/);
});

test("invalid JSON, network failure and cancellation are reported", async () => {
  globalThis.fetch = async () => new Response("<html>challenge</html>", { status: 200 });
  await assert.rejects(postAnalysis({ url: "https://api.example.com", body, apiKey: "", signal: signal() }), /valid JSON/);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(postAnalysis({ url: "https://api.example.com", body, apiKey: "", signal: signal() }), /Could not reach the API/);
  const ctrl = new AbortController();
  globalThis.fetch = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))));
  const p = postAnalysis({ url: "https://api.example.com", body, apiKey: "", signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, /cancelled/);
});
