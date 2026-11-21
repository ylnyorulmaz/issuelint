import test from "node:test";
import assert from "node:assert/strict";
import { callSaygmVerifier, verifierMode, SaygmError, SAYGM_MODEL, SAYGM_ENDPOINT } from "../worker/saygm.ts";
const task = { title: "Fix typo", description: "Change Sing in to Sign in on login button.",
  type: "Bug", domain: "Software", criteria: "", context: "" };
const checks = [{ dimension: "scope", assessment: "clear", severity: "suggestion",
  kind: "missing", title: "", detail: "", question: "", evidence: [] }];
const valid = { verdicts: [], repair_needed: false };
const response = (payload, status=200) => new Response(JSON.stringify(payload), { status,
  headers: { "content-type": "application/json" } });
const completion = value => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 123, completion_tokens: 40, total_tokens: 163 } });
test("defaults invalid and missing modes to off", () => {
  assert.equal(verifierMode(undefined), "off");
  assert.equal(verifierMode("ON"), "off");
  assert.equal(verifierMode("shadow"), "shadow");
  assert.equal(verifierMode("on"), "on");
});
test("sends one authenticated request and parses usage without exposing token", async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url, SAYGM_ENDPOINT);
    assert.equal(init.headers.Authorization, "Bearer secret-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, SAYGM_MODEL);
    assert.equal(body.messages[1].role, "user");
    assert.equal(body.stream, false);
    assert.equal(Object.hasOwn(body, "max_tokens"), false, "No local token cap must be sent");
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
    assert.equal(Object.hasOwn(init, "signal"), false, "SayGM request must not have an application timeout/abort signal");
    return response(completion(valid));
  };
  const result = await callSaygmVerifier({ apiKey: "secret-key", task, checks, fetcher });
  assert.equal(calls, 1);
  assert.equal(result.usage.totalTokens, 163);
  assert.deepEqual(result.verdict.verdicts, []);
});
test("missing secret fails without contacting provider", async () => {
  await assert.rejects(callSaygmVerifier({ task, checks, fetcher: async () => { throw Error("should not call"); } }),
    e => e instanceof SaygmError && e.category === "config");
});
test("HTTP errors never include upstream content", async () => {
  await assert.rejects(callSaygmVerifier({ apiKey: "key", task, checks,
    fetcher: async () => response({ private: "sensitive task data" }, 402) }),
    e => e instanceof SaygmError && e.category === "http" && !e.message.includes("sensitive"));
});
test("invalid JSON and invalid patches fail closed", async () => {
  await assert.rejects(callSaygmVerifier({ apiKey: "key", task, checks,
    fetcher: async () => response(completion({ verdicts: [{ action: "DELETE" }], repair_needed: false })) }),
    e => e instanceof SaygmError && e.category === "invalid_patch");
});
test("provider-side abort can still be classified without an application timeout", async () => {
  await assert.rejects(callSaygmVerifier({ apiKey: "key", task, checks,
    fetcher: async () => { const e = new Error("abort"); e.name = "TimeoutError"; throw e; } }),
    e => e instanceof SaygmError && e.category === "timeout");
});

test("separates truncated, blank, malformed JSON, invalid envelope and invalid patch", async () => {
  const samples = [
    [{choices:[{finish_reason:"length",message:{content:"{}"}}]}, "output_truncated"],
    [{choices:[{finish_reason:"stop",message:{content:" "}}]}, "empty_content"],
    [{choices:[{finish_reason:"stop",message:{content:"{broken"}}]}, "invalid_json"],
    [{unexpected:true}, "invalid_shape"],
    [completion({verdicts:[{action:"REVISE",dimension:"scope",reason:"No source support for changing this check."}],repair_needed:false}), "invalid_patch"],
  ];
  for (const [payload,category] of samples) {
    await assert.rejects(
      callSaygmVerifier({apiKey:"test-secret-should-never-log",task,checks,fetcher:async()=>response(payload)}),
      err => err instanceof SaygmError && err.category === category && !err.message.includes("secret")
    );
  }
});
test("oversized provider response is bounded and never logged", async () => {
  await assert.rejects(
    callSaygmVerifier({apiKey:"test-key",task,checks,fetcher:async()=>new Response("x".repeat(1024 * 1024 + 1),{status:200})}),
    e => e instanceof SaygmError && e.category === "response_too_large"
  );
});
test("HTTP status and network failures have distinct safe diagnostics", async () => {
  await assert.rejects(
    callSaygmVerifier({apiKey:"test-key",task,checks,fetcher:async()=>response({sensitive:"private text"},429)}),
    e => e instanceof SaygmError && e.category === "http" && e.httpStatus===429 && !e.message.includes("private")
  );
  await assert.rejects(
    callSaygmVerifier({apiKey:"test-key",task,checks,fetcher:async()=>{throw Error("Authorization: Bearer secret-raw-data")}}),
    e => e instanceof SaygmError && e.category === "network" && !e.message.includes("Bearer")
  );
});

test("large, valid reasoning-bearing upstream envelope no longer fails at old 30KB cap", async () => {
  const envelope = { ...completion(valid), choices:[{
    ...completion(valid).choices[0],
    message: {
      content: JSON.stringify(valid),
      reasoning_content: "internal reasoning omitted from logs".repeat(3000)
    }
  }] };
  assert.ok(JSON.stringify(envelope).length > 30_000);
  const result = await callSaygmVerifier({
    apiKey:"test-secret", task, checks,
    fetcher:async()=>response(envelope)
  });
  assert.deepEqual(result.verdict.verdicts, []);
  assert.equal(result.usage.totalTokens, 163);
});

test("oversized streamed responses are cut off even without Content-Length", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(2));
    },
    cancel() {}
  });
  await assert.rejects(
    callSaygmVerifier({ apiKey:"test-secret", task, checks,
      fetcher:async()=>new Response(stream,{status:200}) }),
    e=>e instanceof SaygmError && e.category==="response_too_large"
  );
});


test("reports precise verifier rejection code without exposing invalid content", async () => {
  const invalid = {verdicts:[{
    dimension:"scope",action:"ADD",
    reason:"The ticket could have a missing decision.",
    severity:"important",title:"Clarify affected screen",
    detail:"The update needs a named affected screen before development begins.",
    question:"Which screen should this update affect?",
    evidence:["secret customer data that is not in source"]
  }],repair_needed:false};
  await assert.rejects(
    callSaygmVerifier({apiKey:"never-log-key",task,checks,
      fetcher:async()=>response(completion(invalid))}),
    e=>e instanceof SaygmError && e.category==="invalid_patch" &&
      e.validationCode==="evidence_not_in_task" &&
      !JSON.stringify(e).includes("secret customer") &&
      !JSON.stringify(e).includes("never-log-key"),
  );
});

test("prompt explicitly encodes action-specific keys and grounded source evidence", async () => {
  let system="";
  const result=await callSaygmVerifier({
    apiKey:"secret-key",task,checks,
    fetcher:async(_url,init)=>{
      const payload=JSON.parse(init.body);
      system=payload.messages[0].content;
      return response(completion(valid));
    }
  });
  assert.deepEqual(result.verdict.verdicts,[]);
  for(const rule of [
    "KEEP: {dimension,action,reason}",
    "SUPPRESS: {dimension,action,reason}",
    "DOWNGRADE: {dimension,action,reason,severity}",
    "REVISE: {dimension,action,reason,title,detail,question,evidence}",
    "ADD: {dimension,action,reason,severity,title,detail,question,evidence}",
    "Do NOT include severity",
    "exact literal substrings",
    "evidence: []",
    "Never change existing critical gaps",
    '"repair_needed":false'
  ]) assert.ok(system.includes(rule),"missing "+rule);
  assert.ok(!system.includes("max_tokens: 1800"));
});
