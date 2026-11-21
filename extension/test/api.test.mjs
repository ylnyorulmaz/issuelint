import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { analyzeRemote, ApiError } from "../src/lib/api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const body = { source_url: "https://jira.example/browse/A-1", page_title: "A-1", markdown: "# Task" };

test("posts the exact payload with Bearer key and request ID, no cookies", async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
  };
  const out = await analyzeRemote(body, { apiUrl: "https://api.example.com/clip", apiKey: "k-123", signal: new AbortController().signal });
  assert.deepEqual(out, { status: "ready" });
  assert.equal(seen.url, "https://api.example.com/clip");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), body);
  assert.equal(seen.init.headers.Authorization, "Bearer k-123");
  assert.match(seen.init.headers["X-Request-ID"], /^[0-9a-f-]{36}$/);
  assert.equal(seen.init.credentials, "omit");
});

test("omits Authorization when no key is set", async () => {
  let headers;
  globalThis.fetch = async (_u, init) => { headers = init.headers; return new Response("{}", { status: 200 }); };
  await analyzeRemote(body, { apiUrl: "https://api.example.com", apiKey: "", signal: new AbortController().signal });
  assert.equal("Authorization" in headers, false);
});

test("HTTP errors become ApiError without echoing the key", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  await assert.rejects(
    analyzeRemote(body, { apiUrl: "https://api.example.com", apiKey: "secret-key-value", signal: new AbortController().signal }),
    (err) => err instanceof ApiError && err.status === 401 && /HTTP 401: Unauthorized/.test(err.message) && !err.message.includes("secret-key-value"),
  );
});

test("invalid JSON, network failure and bad URLs are reported", async () => {
  globalThis.fetch = async () => new Response("<html>oops</html>", { status: 200 });
  await assert.rejects(analyzeRemote(body, { apiUrl: "https://api.example.com", apiKey: "", signal: new AbortController().signal }), /valid JSON/);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(analyzeRemote(body, { apiUrl: "https://api.example.com", apiKey: "", signal: new AbortController().signal }), /Could not reach the API/);
  await assert.rejects(analyzeRemote(body, { apiUrl: "http://api.example.com", apiKey: "", signal: new AbortController().signal }), /https/);
});

test("user cancellation is reported as cancelled", async () => {
  const ctrl = new AbortController();
  globalThis.fetch = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))));
  const p = analyzeRemote(body, { apiUrl: "https://api.example.com", apiKey: "", signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, /cancelled/);
});
