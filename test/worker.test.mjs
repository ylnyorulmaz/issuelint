import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.ts";
import { parseTask, parseAnalysis, ValidationError } from "../worker/schema.ts";
import { extractJsonResponse, selectModel, isGroundedCore } from "../worker/inference.ts";
import { REVIEW_DIMENSIONS, parseReviewV2, contextHints, highConfidenceContradictions } from "../worker/review-v2.ts";

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

function toV2(analysis) {
  const finding = analysis.findings[0];
  return {
    detectedDomain: "Sales",
    detectedType: "General",
    summary: analysis.summary,
    rewriteCore: analysis.suggestedRewrite,
    checks: REVIEW_DIMENSIONS.map(d => d === "contradictions" && finding
      ? {dimension:d,assessment:"gap",severity:finding.severity,kind:finding.kind,
         title:finding.title,detail:finding.detail,evidence:finding.evidence,question:finding.question}
      : {dimension:d,assessment:"clear",severity:"suggestion",kind:"suggestion",
         title:"",detail:"",evidence:[],question:""}),
  };
}

function makeEnv(overrides = {}) {
  const calls = [];
  const env = {
    ANALYZE_ENABLED: "true",
    PREVIEW_TOKEN: "test-preview-secret-with-24-plus-characters",
    AI_MODEL: "@cf/openai/gpt-oss-20b",
    AI: {
      async run(model, options) {
        calls.push({ model, options });
        return { choices: [{ message: { content: JSON.stringify(toV2(validAnalysis)) }, finish_reason: "stop" }] };
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
  assert.equal(data.analysis.status, "blocked");
  assert.deepEqual(data.analysis.findings, validAnalysis.findings);
  assert.equal(data.analysis.rewriteStatus, "rewritten");
  assert.match(data.analysis.suggestedRewrite, /Open questions:/);
  assert.equal(data.analysis.reviewCoverage.checked, 8);
  assert.equal(data.analysis.reviewCoverage.reported, 1);
  assert.equal(data.analysis.reviewContext.domain, "Sales");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "@cf/openai/gpt-oss-20b");
  assert.equal(calls[0].options.response_format.type, "json_schema");
  assert.equal(calls[0].options.stream, false);
  assert.equal(calls[0].options.reasoning_effort, "low");
  assert.equal(calls[0].options.max_tokens, 2800);
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
  const { env } = makeEnv({ AI: { run: async () => ({ choices: [{ message: { content: JSON.stringify(toV2(analysis)) } }] }) } });
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
      ? toV2(first)
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
  const same = [originalTask.title, originalTask.description].join("\n\n");
  const { env } = makeEnv({ AI: { run: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify(calls === 1
      ? toV2({ ...validAnalysis, suggestedRewrite: same })
      : { suggestedRewrite: "Task: Contact qualified leads after approval tomorrow. Clarify whether the deadline should move from today to tomorrow." }) }, finish_reason: "stop" }] };
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
      ? toV2({ ...validAnalysis, suggestedRewrite: "" })
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
      ? toV2(review) : { suggestedRewrite: "" }) }, finish_reason: "stop" }] };
  } } });
  const res = await worker.fetch(post({
    ...originalTask,
    title: "Send newsletter tomorrow",
    description: "Send the prepared newsletter to subscribers tomorrow."
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.analysis.rewriteStatus, "unavailable");
  assert.equal(body.analysis.suggestedRewrite, "");
  assert.equal(calls, 2);
});

test("v2 audits all dimensions and ranks multiple important gaps ahead of generic AC-only feedback", () => {
  const task = parseTask({
    title:"Add dark mode",
    description:"Users want dark mode on web and mobile. Follow the design from Figma and ship it in the next sprint.",
    type:"General",domain:"Other",criteria:"",context:"",
  });
  const makeGap=(dimension,title,question)=>({
    dimension,assessment:"gap",severity:"important",kind:"missing",
    title,detail:"Clarification is necessary before implementation.",evidence:[],question,
  });
  const real={
    detectedDomain:"Software",detectedType:"Feature",summary:"Work needs scope and behavior decisions.",
    rewriteCore:"Implement a dark visual theme for the web and mobile applications using the referenced Figma design.",
    checks:REVIEW_DIMENSIONS.map(d=>{
      if(d==="scope")return makeGap(d,"Unspecified screens","Which screens are in scope?");
      if(d==="behavior")return makeGap(d,"Undefined theme switching","System preference or manual toggle?");
      if(d==="completion")return makeGap(d,"No verification criteria","How will the feature be verified?");
      if(d==="references")return makeGap(d,"Figma reference not identifiable","Which Figma file is the reference?");
      if(d==="clarity")return makeGap(d,"Generic wording","Can you rewrite the task to explicitly state the deliverables?");
      return {dimension:d,assessment:"clear",severity:"suggestion",kind:"suggestion",
        title:"",detail:"",question:"",evidence:[]};
    }),
  };
  const review=parseReviewV2(real,task);
  assert.equal(review.analysis.status,"needs_clarification");
  assert.equal(review.analysis.findings.length,4);
  assert.deepEqual(review.analysis.findings.map(f=>f.title),[
    "Unspecified screens","Undefined theme switching","No verification criteria","Figma reference not identifiable"
  ]);
  assert.equal(review.reviewCoverage.checked,8);
  assert.equal(review.context.domain,"Software");
  assert.equal(review.context.type,"Feature");
});

test("v2 rejects audits with duplicate or missing dimensions",()=>{
  const task=parseTask(originalTask);
  const sample=toV2(validAnalysis);
  sample.checks[0].dimension="behavior";
  assert.throws(()=>parseReviewV2(sample,task),ValidationError);
  const short=toV2(validAnalysis);
  short.checks.pop();
  assert.throws(()=>parseReviewV2(short,task),ValidationError);
});

test("v2 does not force acceptance criteria into a fully specified task",()=>{
  const task=parseTask({...originalTask,title:"Send approved newsletter",description:"Send the approved newsletter to the subscribed list tomorrow using the existing approved template. Confirm delivery in the email platform.",domain:"Marketing"});
  const clean=toV2({summary:"The request is executable.",findings:[],suggestedRewrite:"Send tomorrow's approved newsletter to the subscribed list. Verify delivery in the email platform."});
  clean.detectedDomain="Marketing";
  const result=parseReviewV2(clean,task);
  assert.equal(result.analysis.findings.length,0);
  assert.equal(result.analysis.status,"ready");
});

test("v2 infers clear technical context from pasted content, not General/Other defaults",()=>{
  const hints=contextHints(parseTask({title:"Add dark mode",description:"Use Figma to add dark mode on web and mobile.",type:"General",domain:"Other",criteria:"",context:""}));
  assert.deepEqual(hints,{domain:"Software",type:"Feature"});
});

test("rewrites reject unsupported claims that source never confirmed",()=>{
  const task=parseTask({...originalTask,description:"Implement dark mode from the Figma design.",domain:"Software"});
  assert.equal(isGroundedCore("Implement the approved Figma design, fully tested and production-ready.",task),false);
  assert.equal(isGroundedCore("Implement dark mode using the referenced Figma design.",task),true);
});

test("critical source-verifiable deadline and audience conflicts survive an AI omission",()=>{
  const task=parseTask({
    title:"Follow up with every lead today",
    description:"Only contact qualified leads. Do not send messages before the new copy is approved tomorrow. Everyone must be contacted by end of today.",
    type:"General",domain:"Sales",criteria:"",context:"",
  });
  const conflicts=highConfidenceContradictions(task);
  assert.equal(conflicts.length,2);
  assert.ok(conflicts.every(c=>c.kind==="contradiction"&&c.severity==="critical"&&c.evidence.length===2));
  const audit=toV2({summary:"The request contains several unresolved issues.",findings:[],suggestedRewrite:""});
  const output=parseReviewV2(audit,task);
  assert.equal(output.analysis.status,"blocked");
  assert.equal(output.analysis.findings.filter(f=>f.kind==="contradiction").length,2);
  assert.equal(output.reviewCoverage.checked,8);
});

test("conflict guard does not invent issues in unrelated work",()=>{
  const task=parseTask({...originalTask,title:"Create two newsletter variants",description:"Design email versions for the next campaign.",domain:"Marketing"});
  assert.deepEqual(highConfidenceContradictions(task),[]);
});

test("wrapped model evidence quotes are normalized but still source-verified",()=>{
  const task=parseTask({...originalTask,title:"Add dark mode",description:"Follow the design from Figma.",domain:"Software"});
  const sample=toV2({summary:"The Figma reference needs identifying.",findings:[],suggestedRewrite:""});
  sample.detectedDomain="Software";
  sample.checks[0]={
    dimension:REVIEW_DIMENSIONS[0],assessment:"clear",severity:"suggestion",kind:"suggestion",
    title:"",detail:"",question:"",evidence:[],
  };
  const refs=sample.checks.find(c=>c.dimension==="references");
  Object.assign(refs,{
    assessment:"gap",severity:"important",kind:"missing",title:"Figma reference unclear",
    detail:"The cited design is not identifiable.",question:"Which Figma file should be used?",
    evidence:['"Follow the design from Figma."'],
  });
  const parsed=parseReviewV2(sample,task);
  assert.deepEqual(parsed.analysis.findings[0].evidence,["Follow the design from Figma."]);
});

test("guard-added contradiction prevents the model from silently committing to impossible timing",async()=>{
  const conflict={
    title:"Follow up with every lead today",
    description:"Only contact qualified leads. Do not send messages before the new copy is approved tomorrow. Everyone must be contacted by end of today.",
    type:"General",domain:"Sales",criteria:"",context:"",
  };
  const missed=toV2({
    status:"ready",summary:"Several details need clarifying.",findings:[],
    suggestedRewrite:"Contact all qualified leads today using the approved copy.",
  });
  let calls=0;
  const {env}=makeEnv({AI:{run:async()=>{calls++;return {choices:[{message:{content:JSON.stringify(missed)},finish_reason:"stop"}]};}}});
  const response=await worker.fetch(post(conflict),env);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.analysis.status,"blocked");
  assert.equal(body.analysis.rewriteStatus,"clarification_draft");
  assert.equal(body.analysis.findings.filter(f=>f.kind==="contradiction").length,2);
  assert.match(body.analysis.suggestedRewrite,/Open questions/);
  assert.equal(calls,1);
});
