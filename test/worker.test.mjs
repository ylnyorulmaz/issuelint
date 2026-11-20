import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.ts";

const mockEnv = {
  AI: { run() { throw new Error("AI must not be called in iteration 1"); } },
  ASSETS: { fetch: async () => new Response("STATIC_ASSET_OK") },
};

test("GET /api/health confirms binding without calling AI", async () => {
  const response = await worker.fetch(new Request("https://example.com/api/health"), mockEnv);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual({ status: data.status, iteration: data.iteration, aiBindingConfigured: data.aiBindingConfigured },
    { status: "ok", iteration: 1, aiBindingConfigured: true });
});

test("POST /api/analyze returns explicit stub, not fake analysis", async () => {
  const response = await worker.fetch(new Request("https://example.com/api/analyze", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Example", description: "Sample" }),
  }), mockEnv);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).findings, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("GET /api/analyze is rejected", async () => {
  const response = await worker.fetch(new Request("https://example.com/api/analyze"), mockEnv);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("API rejects non-JSON media type", async () => {
  const response = await worker.fetch(new Request("https://example.com/api/analyze", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "test",
  }), mockEnv);
  assert.equal(response.status, 415);
});

test("Unknown API paths are JSON 404, not SPA fallback", async () => {
  const response = await worker.fetch(new Request("https://example.com/api/wrong"), mockEnv);
  assert.equal(response.status, 404);
});

test("Non-API paths use static assets binding", async () => {
  const response = await worker.fetch(new Request("https://example.com/"), mockEnv);
  assert.equal(await response.text(), "STATIC_ASSET_OK");
});
