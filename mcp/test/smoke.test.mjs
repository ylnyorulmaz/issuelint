// Boots the built MCP server over stdio (dist/index.js) and drives it with the official MCP client,
// against a local mock of the IssueLint Worker. No real API key or network is used.
// Run: npm run smoke-test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const KEY_OK = "test-key-ok-000000000000000";
const KEY_401 = "test-key-401-00000000000000";
const KEY_403 = "test-key-403-00000000000000";
const KEY_429 = "test-key-429-00000000000000";
const KEY_SLOW = "test-key-slow-0000000000000";
const KEY_RATE502 = "test-key-rate502-0000000000";

const gate = (dimension, assessment, clear) => ({
  dimension, assessment, confidence: 0.9, probabilities: { clear, gap: +(1 - clear).toFixed(2), not_applicable: 0 },
});
const DECISION = {
  mode: "decision", analyzed: true,
  decision: {
    model: "gemini-decision-1", checked: 11, durationMs: 900,
    gates: [
      gate("contradictions", "gap", 0.1), gate("actionability", "clear", 0.95), gate("scope", "clear", 0.92),
      gate("granularity", "clear", 0.9), gate("behavior", "clear", 0.9), gate("completion", "gap", 0.2),
      gate("outcome", "clear", 0.88), gate("references", "clear", 0.7), gate("dependencies", "clear", 0.91),
      gate("clarity", "clear", 0.93), { ...gate("feasibility", "not_applicable", 0.05) },
    ],
    audit: {
      status: "partial", unverified: ["references"], model: "@cf/openai/gpt-oss-120b", threshold: 0.85,
      selected: ["contradictions", "completion", "references"], durationMs: 8000, findings: [],
      checks: [
        { dimension: "completion", assessment: "gap", reason: "No verifiable done state.", severity: "important", kind: "missing",
          title: "No definition of done", evidence: ["Totals are off by one cent."], question: "What should a reviewer see when this is done?" },
        { dimension: "contradictions", assessment: "gap", reason: "USD only vs EUR check.", severity: "critical", kind: "contradiction",
          title: "Currency scope conflicts", evidence: ["Only USD prices are affected", "Verify EUR totals"], question: "Should EUR change too?" },
      ],
    },
  },
};

let mock;
let baseUrl;
const requests = [];

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json", "X-Request-ID": req.headers["x-request-id"] ?? "" });
        res.end(JSON.stringify(obj));
      };
      if (req.url !== "/api/analyze-v2" || req.method !== "POST") return send(404, { error: "NOT_FOUND", message: "Unknown API endpoint." });
      if (auth === `Bearer ${KEY_401}`) return send(401, { error: "PREVIEW_AUTH_REQUIRED", message: "A valid preview token is required." });
      if (auth === `Bearer ${KEY_403}`) return send(403, {});
      if (auth === `Bearer ${KEY_429}`) return send(429, { error: "RATE_LIMITED", message: "Too many requests." });
      if (auth === `Bearer ${KEY_RATE502}`) return send(502, { error: "DECISION_RATE_LIMIT", message: "Gemini Decision 1 rate limit reached. Try again later." });
      if (auth === `Bearer ${KEY_SLOW}`) return setTimeout(() => send(200, DECISION), 2_000);
      if (auth === `Bearer ${KEY_OK}`) return send(200, DECISION);
      return send(401, { error: "PREVIEW_AUTH_REQUIRED", message: "A valid preview token is required." });
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  baseUrl = `http://localhost:${mock.address().port}`;
});
after(() => new Promise((r) => mock.close(r)));

async function connect(env) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH ?? "", ISSUELINT_API_URL: baseUrl, ...env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => stderr.push(String(d)));
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}

const TASK = {
  title: "PAY-123 Fix rounding on the checkout summary",
  description: "Totals are off by one cent. Only USD prices are affected. Verify EUR totals before release.",
};
const text = (r) => r.content.map((c) => c.text).join("\n");

test("boots over stdio and lists tools and the prompt", async () => {
  const { client, close } = await connect({ ISSUELINT_API_KEY: KEY_OK });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["lint_markdown", "lint_task"]);
    const lintTask = tools.find((t) => t.name === "lint_task");
    assert.deepEqual(lintTask.inputSchema.required?.sort(), ["description", "title"]);
    assert.deepEqual(lintTask.inputSchema.properties.type.enum, ["General", "Bug", "Feature", "Improvement", "Request"]);
    assert.equal(lintTask.inputSchema.properties.title.maxLength, 180);
    assert.equal(lintTask.inputSchema.properties.description.maxLength, 6500);
    assert.equal(lintTask.annotations.readOnlyHint, true);
    const md = tools.find((t) => t.name === "lint_markdown");
    assert.deepEqual(md.inputSchema.required, ["markdown"]);

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), ["preflight_check"]);
    const prompt = await client.getPrompt({ name: "preflight_check", arguments: { request: "Add dark mode" } });
    assert.match(prompt.messages[0].content.text, /lint_task.*lint_markdown/s);
    assert.match(prompt.messages[0].content.text, /ask the user\s+the returned clarification questions first/i);
    assert.match(prompt.messages[0].content.text, /Add dark mode$/);
  } finally {
    await close();
  }
});

test("lint_task sends the exact Worker contract and returns an agent-readable summary", async () => {
  requests.length = 0;
  const { client, stderr, close } = await connect({ ISSUELINT_API_KEY: KEY_OK });
  try {
    const r = await client.callTool({ name: "lint_task", arguments: { ...TASK, type: "Bug", criteria: "  ", context: "Checkout v2" } });
    assert.equal(r.isError, undefined);
    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.url, "/api/analyze-v2");
    assert.equal(req.headers.authorization, `Bearer ${KEY_OK}`);
    assert.match(req.headers["content-type"], /^application\/json/);
    assert.match(req.headers["x-request-id"], /^[a-zA-Z0-9_-]{8,64}$/);
    assert.deepEqual(req.body, { ...TASK, type: "Bug", domain: "Software", context: "Checkout v2" }, "empty optional fields are omitted");

    const out = text(r);
    assert.match(out, /^## IssueLint pre-flight: STOP: critical gap or contradiction/);
    assert.match(out, /2 potential gaps · 7 clear · 1 not applicable · 1 not verified/);
    // Critical gap sorted first, with exact quotes and the question.
    assert.match(out, /\*\*1\. Contradictions: Currency scope conflicts\*\* _\(critical, contradiction\)_/);
    assert.match(out, /> Only USD prices are affected\n> Verify EUR totals/);
    assert.match(out, /\*\*Ask the user:\*\* Should EUR change too\?/);
    assert.match(out, /\*\*2\. Definition of done: No definition of done\*\*/);
    assert.match(out, /\? References \(unverified, P\(clear\) 70%\)/);
    assert.match(out, /Audit partial: References could not be verified/);

    const s = r.structuredContent;
    assert.equal(s.readiness, "blocked_by_critical_gap");
    assert.deepEqual(s.counts, { gaps: 2, clear: 7, notApplicable: 1, unverified: 1 });
    assert.equal(s.gaps[0].dimension, "contradictions");
    assert.deepEqual(s.gaps[0].quotes, ["Only USD prices are affected", "Verify EUR totals"]);
    assert.equal(s.requestId, req.headers["x-request-id"]);

    const logs = stderr.join("");
    assert.match(logs, /check_ok tool=lint_task/);
    assert.doesNotMatch(logs, new RegExp(KEY_OK), "API key must never be logged");
    assert.doesNotMatch(logs, /off by one cent|Currency scope/, "task text and model output must never be logged");
  } finally {
    await close();
  }
});

test("lint_markdown maps like the Clipper extension and keeps source_url out of the request", async () => {
  requests.length = 0;
  const { client, close } = await connect({ ISSUELINT_API_KEY: KEY_OK });
  try {
    const markdown = "## Fix rounding on checkout\n\nTotals are off by one cent.";
    const r = await client.callTool({ name: "lint_markdown", arguments: { markdown, source_url: "https://github.com/o/r/issues/1" } });
    assert.equal(r.isError, undefined);
    assert.deepEqual(requests[0].body, { title: "Fix rounding on checkout", description: markdown, type: "General", domain: "Software" });
    assert.match(text(r), /\*\*Source:\*\* https:\/\/github.com\/o\/r\/issues\/1/);
    assert.equal(r.structuredContent.sourceUrl, "https://github.com/o/r/issues/1");
  } finally {
    await close();
  }
});

test("missing API key returns an actionable tool error and sends nothing", async () => {
  requests.length = 0;
  const { client, close } = await connect({});
  try {
    const r = await client.callTool({ name: "lint_task", arguments: TASK });
    assert.equal(r.isError, true);
    assert.match(text(r), /ISSUELINT_API_KEY is not set/);
    assert.match(text(r), /has NOT been checked/);
    assert.equal(requests.length, 0);
  } finally {
    await close();
  }
});

test("HTTP 401 / 403 / 429 / rate-limit 502 map to clear errors", async () => {
  const cases = [
    [KEY_401, /rejected the API key \(HTTP 401 PREVIEW_AUTH_REQUIRED\)/],
    [KEY_403, /refused the request \(HTTP 403\)/],
    [KEY_429, /rate limited \(HTTP 429\).*do not retry in a loop/],
    [KEY_RATE502, /rate limited \(HTTP 502\)/],
  ];
  for (const [key, pattern] of cases) {
    const { client, stderr, close } = await connect({ ISSUELINT_API_KEY: key });
    try {
      const r = await client.callTool({ name: "lint_task", arguments: TASK });
      assert.equal(r.isError, true, String(pattern));
      assert.match(text(r), pattern);
      assert.match(text(r), /\(request [a-zA-Z0-9_-]{8,64}\)/);
      assert.doesNotMatch(stderr.join(""), new RegExp(key));
    } finally {
      await close();
    }
  }
});

test("timeout is reported and configurable via ISSUELINT_TIMEOUT_MS", async () => {
  const { client, close } = await connect({ ISSUELINT_API_KEY: KEY_SLOW, ISSUELINT_TIMEOUT_MS: "300" });
  try {
    const started = Date.now();
    const r = await client.callTool({ name: "lint_task", arguments: TASK });
    assert.equal(r.isError, true);
    assert.match(text(r), /did not respond within 0s|did not respond within/);
    assert.match(text(r), /ISSUELINT_TIMEOUT_MS/);
    assert.ok(Date.now() - started < 1_900, "aborted before the slow mock answered");
  } finally {
    await close();
  }
});

test("input limits: schema bounds and the 8,000-char total are enforced before any request", async () => {
  requests.length = 0;
  const { client, close } = await connect({ ISSUELINT_API_KEY: KEY_OK });
  try {
    const tooLongTitle = await client.callTool({ name: "lint_task", arguments: { ...TASK, title: "x".repeat(181) } });
    assert.equal(tooLongTitle.isError, true);
    const badType = await client.callTool({ name: "lint_task", arguments: { ...TASK, type: "Epic" } });
    assert.equal(badType.isError, true);
    const total = await client.callTool({ name: "lint_task", arguments: {
      title: "t", description: "d".repeat(6_500), criteria: "c".repeat(1_200), context: "x".repeat(400),
    } });
    assert.equal(total.isError, true);
    assert.match(text(total), /accepts at most 8,000/);
    const longMd = await client.callTool({ name: "lint_markdown", arguments: { markdown: "m".repeat(6_501) } });
    assert.equal(longMd.isError, true);
    assert.equal(requests.length, 0);
  } finally {
    await close();
  }
});

test("invalid ISSUELINT_API_URL is reported as a tool error, not a crash", async () => {
  const { client, close } = await connect({ ISSUELINT_API_KEY: KEY_OK, ISSUELINT_API_URL: "http://example.com" });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 2);
    const r = await client.callTool({ name: "lint_task", arguments: TASK });
    assert.equal(r.isError, true);
    assert.match(text(r), /ISSUELINT_API_URL must be an https:\/\/ URL/);
  } finally {
    await close();
  }
});
