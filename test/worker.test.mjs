import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.ts";
import { parseTask, parseAnalysis, ValidationError } from "../worker/schema.ts";
import { extractJsonResponse, selectModel, isGroundedCore, assembleRewrite, polishRewriteCore, containsAdditionalRequirements } from "../worker/inference.ts";
import { REVIEW_DIMENSIONS, parseReviewV2, contextHints, highConfidenceContradictions, dimensionPriority } from "../worker/review-v2.ts";
import { suspiciousClearDimensions, applyQualityGate } from "../worker/quality-gate.ts";

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


const repairTask = {
  title:"Draft welcome note",
  description:"Write a welcome note for new volunteers.",
  type:"General",domain:"Other",criteria:"",context:"",
};
const repairAnalysis = {
  status:"needs_clarification", summary:"The audience is not specified.",
  findings:[{
    kind:"missing",severity:"important",title:"Recipients need confirmation",
    detail:"It is unclear which group of new volunteers should receive the message.",
    evidence:["new volunteers"],question:"Which volunteers should receive the note?",
  }],
  suggestedRewrite:"Write a welcome note for new volunteers.",
};

function makeEnv(overrides = {}) {
  const calls = [];
  const env = {
    ANALYZE_ENABLED: "true",
    PREVIEW_TOKEN: "test-preview-secret-with-24-plus-characters",
    AI_MODEL: "@cf/openai/gpt-oss-120b",
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

test("GET /api/health reports Iteration 5 without running AI", async () => {
  const { env, calls } = makeEnv({ ANALYZE_ENABLED: "false" });
  const res = await worker.fetch(new Request(url + "/api/health"), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.iteration, 5);
  assert.equal(data.reviewEngineVersion,"2.5");
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

test("health distinguishes preview secret readiness from visible AI configuration", async () => {
  for (const [secret, ready] of [
    [undefined, false],
    ["yalin", false],
    ["  test-preview-secret-with-24-plus-characters  ", true],
  ]) {
    const {env} = makeEnv({ PREVIEW_TOKEN: secret });
    const res = await worker.fetch(new Request(url + "/api/health"), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.previewAuthConfigured, ready);
    assert.ok(!JSON.stringify(body).includes(secret ?? "missing-key-never-exposed"));
  }
});

test("unauthenticated requests cannot invoke live model", async () => {
  const { env, calls } = makeEnv();
  const res = await worker.fetch(post(originalTask, { authorization: "" }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "PREVIEW_AUTH_REQUIRED");
  assert.equal(calls.length, 0);
});

test("missing or too-short preview secret reports configuration failure without inference", async () => {
  for (const secret of [undefined, "", "yalin", "  short-preview-token  ", "x".repeat(257)]) {
    const { env, calls } = makeEnv({ PREVIEW_TOKEN: secret });
    const res = await worker.fetch(post(), env);
    assert.equal(res.status, 503);
    const output = await res.json();
    assert.equal(output.error, "PREVIEW_AUTH_MISCONFIGURED");
    if (secret?.trim()) assert.ok(!JSON.stringify(output).includes(secret.trim()));
    assert.equal(calls.length, 0);
  }
});

test("preview token accepts accidental outer whitespace in Cloudflare secret only", async () => {
  const { env, calls } = makeEnv({ PREVIEW_TOKEN: "  test-preview-secret-with-24-plus-characters\n" });
  const res = await worker.fetch(post(), env);
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 503);
  assert.ok(calls.length >= 1);
});

test("incorrect but well-formed token still returns 401 without invoking AI", async () => {
  const { env, calls } = makeEnv();
  const res = await worker.fetch(post(originalTask, { authorization: "Bearer wrong-preview-token-with-valid-length" }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "PREVIEW_AUTH_REQUIRED");
  assert.equal(calls.length, 0);
});

test("valid analysis calls the native AI binding once and returns validated JSON", async () => {
  const { env, calls } = makeEnv();
  const res = await worker.fetch(post(), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "ai");
  assert.equal(data.analyzed, true);
  assert.equal(data.analysis.status, "blocked");
  assert.deepEqual(data.analysis.findings.map(f=>f.title),[
    "Deadline conflicts with prerequisite", "Audience instructions conflict"
  ]);
  assert.ok(data.analysis.findings.every(f=>f.evidence.length===2));
  assert.equal(data.analysis.rewriteStatus, "clarification_draft");
  assert.match(data.analysis.suggestedRewrite, /Open questions:/);
  assert.equal(data.analysis.reviewCoverage.checked, REVIEW_DIMENSIONS.length);
  assert.equal(data.analysis.reviewCoverage.reported, 2);
  assert.equal(data.analysis.reviewContext.domain, "Sales");
  assert.deepEqual(data.analysis.findingDimensions,["contradictions","contradictions"]);
  assert.equal(data.analysis.modelUsage.calls,1);
  assert.equal(data.analysis.modelUsage.neurons,null);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "@cf/openai/gpt-oss-120b");
  assert.equal(calls[0].options.response_format.type, "json_schema");
  assert.equal(calls[0].options.stream, false);
  assert.equal(calls[0].options.reasoning_effort, "low");
  assert.equal(calls[0].options.max_tokens, 4700);
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
  assert.equal(selectModel("@cf/attacker/arbitrary-expensive-model"), "@cf/openai/gpt-oss-120b");
  assert.equal(selectModel("@cf/openai/gpt-oss-120b"), "@cf/openai/gpt-oss-120b");
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
  const first = { ...repairAnalysis, suggestedRewrite: "" };
  const { env } = makeEnv({ AI: { run: async (_model, input) => {
    calls++;
    assert.equal(input.response_format.type, "json_schema");
    return { choices: [{ message: { content: JSON.stringify(calls === 1
      ? toV2(first)
      : { suggestedRewrite: "Write a short welcome message for new volunteers and confirm who should receive it." }) }, finish_reason: "stop" }] };
  } } });
  const res = await worker.fetch(post(repairTask), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.analysis.rewriteStatus, "rewritten");
  assert.match(body.analysis.suggestedRewrite, /Open questions/);
  assert.equal(calls, 2);
});

test("verbatim copy in primary output triggers rewrite repair", async () => {
  let calls = 0;
  const same = [repairTask.title, repairTask.description].join("\n\n");
  const { env } = makeEnv({ AI: { run: async () => {
    calls++;
    return { choices: [{ message: { content: JSON.stringify(calls === 1
      ? toV2({ ...repairAnalysis, suggestedRewrite: same })
      : { suggestedRewrite: "Prepare a welcome note for new volunteers and confirm the recipients before sending." }) }, finish_reason: "stop" }] };
  } } });
  const res = await worker.fetch(post(repairTask), env);
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
      ? toV2({ ...repairAnalysis, suggestedRewrite: "" })
      : { suggestedRewrite: "" }) }, finish_reason: "stop" }] };
  } } });
  const res = await worker.fetch(post(repairTask), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(calls, 2);
  assert.equal(body.analysis.rewriteStatus, "clarification_draft");
  assert.match(body.analysis.suggestedRewrite, /Open questions/);
  assert.match(body.analysis.suggestedRewrite, /Which volunteers should receive the note/);
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
  assert.equal(calls, 3);
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
  assert.equal(review.reviewCoverage.checked,REVIEW_DIMENSIONS.length);
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
  assert.equal(output.reviewCoverage.checked,REVIEW_DIMENSIONS.length);
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

test("v2.1 flags suspicious optimistic clear assessments for software features",()=>{
  const task=parseTask({title:"Add dark mode",description:"Users want dark mode on web and mobile, following Figma.",type:"Feature",domain:"Software",criteria:"",context:""});
  const sample=toV2({summary:"Needs more detail.",findings:[],suggestedRewrite:"Implement dark mode for web and mobile using the referenced Figma design."});
  const audit=parseReviewV2({...sample,detectedDomain:"Software",detectedType:"Feature"},task);
  assert.deepEqual(suspiciousClearDimensions(task,audit.checks),["scope","behavior"]);
});

test("v2.1 quality gate promotes only grounded nonduplicated high-value gaps",()=>{
  const task=parseTask({title:"Add dark mode",description:"Users want dark mode on web and mobile, following Figma.",type:"Feature",domain:"Software",criteria:"",context:""});
  const sample=toV2({summary:"Needs completion criteria.",findings:[],suggestedRewrite:"Implement dark mode for web and mobile."});
  const audit=parseReviewV2({...sample,detectedDomain:"Software",detectedType:"Feature"},task);
  const checked=applyQualityGate(task,audit.checks,["scope","behavior"],{
    checks:[
      {dimension:"scope",assessment:"gap",title:"Screens and components not specified",
        detail:"Web and mobile are named, but individual screens/components for implementation are not established.",
        question:"Which web pages and mobile screens should dark mode cover?",evidence:["dark mode on web and mobile"]},
      {dimension:"behavior",assessment:"gap",title:"Theme interaction not defined",
        detail:"The task does not describe how the user chooses dark or light or whether the choice persists.",
        question:"Should the theme follow system preferences or be selected manually?",evidence:[]},
    ]
  });
  const output=parseReviewV2({...sample,detectedDomain:"Software",detectedType:"Feature",checks:checked},task);
  assert.equal(output.analysis.findings.length,2);
  assert.deepEqual(output.findingDimensions,["scope","behavior"]);
  assert.equal(output.analysis.status,"needs_clarification");
  assert.ok(output.analysis.findings.every(f=>f.severity==="important"));
});

test("v2.1 does not force optional gaps on detailed work and rejects invented citations",()=>{
  const task=parseTask({title:"Add dark mode",description:"Add a manual toggle on Settings only; save the choice after reload.",type:"Feature",domain:"Software",criteria:"Toggle works on Settings after refresh.",context:""});
  const sample=toV2({summary:"Ready to implement.",findings:[],suggestedRewrite:"Implement the Settings dark-mode toggle and persist the user's choice."});
  const audit=parseReviewV2({...sample,detectedDomain:"Software",detectedType:"Feature"},task);
  const inspected=applyQualityGate(task,audit.checks,["scope","behavior"],{checks:[
    {dimension:"scope",assessment:"gap",title:"Invented missing source",detail:"A fictitious comment says some screens lack a theme.",question:"What else is in scope?",evidence:["nonexistent source quote"]}
  ]});
  assert.deepEqual(inspected,audit.checks);
  assert.deepEqual(dimensionPriority(task).slice(0,3),["contradictions","actionability","scope"]);
});

test("v2.1 end-to-end rechecks missing feature scope/behavior, not AC alone",async()=>{
  const task={title:"Add dark mode",description:"Users want dark mode on web and mobile. Follow the design from Figma and ship it next sprint.",type:"Feature",domain:"Software",criteria:"",context:""};
  const audit=toV2({summary:"Missing completion criteria and design reference.",findings:[],suggestedRewrite:"Implement dark mode for web and mobile as referenced by Figma."});
  audit.detectedDomain="Software";audit.detectedType="Feature";
  const completion=audit.checks.find(c=>c.dimension==="completion");
  Object.assign(completion,{assessment:"gap",kind:"missing",severity:"important",title:"Missing completion criteria",detail:"It is unclear how to confirm dark mode works.",question:"What tests confirm dark mode is complete?"});
  let calls=0;
  const {env}=makeEnv({AI:{run:async(_model,options)=>{
    calls++;
    if(calls===1)return {choices:[{message:{content:JSON.stringify(audit)},finish_reason:"stop"}],
      usage:{prompt_tokens:600,completion_tokens:800,neurons:30}};
    assert.equal(options.reasoning_effort,"low");
    return {choices:[{message:{content:JSON.stringify({checks:[
      {dimension:"scope",assessment:"gap",title:"Scope of dark mode is unspecified",detail:"Web and mobile are mentioned, but no specific screens or reusable components are included.",question:"Which screens and UI components should support dark mode?",evidence:[]},
      {dimension:"behavior",assessment:"gap",title:"Theme switching is unspecified",detail:"No interaction is described for selecting dark mode or remembering the choice across sessions.",question:"Should the mode follow system settings, use a manual toggle, or persist?",evidence:[]}
    ]})},finish_reason:"stop"}],usage:{prompt_tokens:180,completion_tokens:270,neurons:10}};
  }}});
  const res=await worker.fetch(post(task),env);
  assert.equal(res.status,200);
  const a=(await res.json()).analysis;
  assert.equal(calls,2);
  assert.deepEqual(a.findingDimensions,["scope","behavior","completion"]);
  assert.equal(a.reviewCoverage.checked,REVIEW_DIMENSIONS.length);
  assert.match(a.suggestedRewrite,/Which screens and UI components/);
  assert.equal(a.modelUsage.neurons,40);
  assert.equal(a.modelUsage.promptTokens,780);
  assert.equal(a.modelUsage.completionTokens,1070);
  assert.equal(a.modelUsage.calls,2);
});

test("2.1 rejects invented toggle and release-readiness commitments in rewrite",()=>{
  const task=parseTask({
    title:"Add dark mode",
    description:"Users want dark mode on web and mobile. Follow the Figma design.",
    type:"Feature",domain:"Software",criteria:"",context:"",
  });
  assert.equal(isGroundedCore("Implement dark mode with a manual toggle.",task),false);
  assert.equal(isGroundedCore("Implement dark mode, ready for release at the end of the sprint.",task),false);
  assert.equal(isGroundedCore("Implement dark mode on web and mobile following Figma.",task),true);
});


test("2.2 audited dimensions include actionability, granularity and outcome exactly once",()=>{
  assert.equal(REVIEW_DIMENSIONS.length,11);
  for(const name of ["actionability","granularity","outcome"])assert.ok(REVIEW_DIMENSIONS.includes(name));
  const task=parseTask({title:"Build onboarding platform",description:"Create registration, billing, notifications, support and admin tools as one project.",type:"Feature",domain:"Software",criteria:"",context:""});
  const draft=toV2({summary:"The task contains multiple deliverables.",findings:[],suggestedRewrite:"Create onboarding capabilities."});
  draft.detectedDomain="Software"; draft.detectedType="Feature";
  const size=draft.checks.find(c=>c.dimension==="granularity");
  Object.assign(size,{assessment:"gap",severity:"important",kind:"suggestion",title:"Split into deliverable tasks",
    detail:"Registration, billing and administration can be implemented, tested and shipped independently.",
    question:"Which independently deliverable part should be implemented first?",evidence:[]});
  const review=parseReviewV2(draft,task);
  assert.equal(review.analysis.status,"needs_clarification");
  assert.equal(review.reviewCoverage.checked,11);
  assert.equal(review.findingDimensions[0],"granularity");
  assert.match(review.analysis.findings[0].question,/implemented first/);
});

test("2.2 simple actionable tasks are not forced to have a separate business purpose or subtasks",()=>{
  const task=parseTask({title:"Draft Q4 budget summary",
    description:"Draft the Q4 budget summary from the approved workbook and send the PDF to the finance lead Friday.",
    type:"General",domain:"Operations",criteria:"PDF emailed by Friday",context:"Approved workbook in shared folder."});
  const draft=toV2({summary:"The request is executable and has a clear deliverable.",
    findings:[],suggestedRewrite:"Draft the Q4 budget summary and send the final PDF by Friday."});
  draft.detectedDomain="Operations";
  const review=parseReviewV2(draft,task);
  assert.equal(review.analysis.status,"ready");
  assert.equal(review.analysis.findings.length,0);
  assert.equal(review.reviewCoverage.checked,11);
  assert.equal(review.checks.find(x=>x.dimension==="outcome").assessment,"clear");
  assert.equal(review.checks.find(x=>x.dimension==="granularity").assessment,"clear");
});

test("2.2 ranks actionability and oversized epics above generic completion concerns",()=>{
  const task=parseTask({title:"Q4 growth",description:"Q4 growth, improve everything and build a large platform for customers.",type:"General",domain:"Marketing",criteria:"",context:""});
  const draft=toV2({summary:"This is a broad topic not a task.",findings:[],suggestedRewrite:"Define a specific growth deliverable."});
  draft.detectedDomain="Marketing";
  for(const [dimension,title,question] of [
    ["completion","Completion is unclear","How will the work be recognized as done?"],
    ["granularity","Several deliverables combined","Which independently releasable phase should happen first?"],
    ["actionability","No executable action specified","What concrete deliverable should the assignee produce?"],
  ]){
    const check=draft.checks.find(c=>c.dimension===dimension);
    Object.assign(check,{assessment:"gap",severity:"important",kind:"missing",title,
      detail:"A specific decision is needed before this work can be assigned and delivered.",question,evidence:[]});
  }
  const review=parseReviewV2(draft,task);
  assert.deepEqual(review.findingDimensions,["actionability","granularity","completion"]);
});

test("2.2 quality gate rechecks granularity when scope and behavior are already flagged",()=>{
  const task=parseTask({title:"Build platform",description:"Build a new customer onboarding platform with payments, identity and analytics.",type:"Feature",domain:"Software",criteria:"",context:""});
  const draft=toV2({summary:"Scope and behavior need decisions.",findings:[],suggestedRewrite:"Plan customer onboarding."});
  draft.detectedDomain="Software"; draft.detectedType="Feature";
  for(const d of ["scope","behavior"]){
    Object.assign(draft.checks.find(c=>c.dimension===d),{
      assessment:"gap",kind:"missing",severity:"important",title:"Missing "+d,
      detail:"The work needs more specific design decisions to be executable.",
      question:"Which "+d+" requirements are intended?",evidence:[]
    });
  }
  const audit=parseReviewV2(draft,task);
  assert.deepEqual(suspiciousClearDimensions(task,audit.checks),["granularity"]);
  const checked=applyQualityGate(task,audit.checks,["granularity"],{checks:[{
    dimension:"granularity",assessment:"gap",title:"Large multi-part epic",
    detail:"Identity verification and payments are separate deliverables which can be split.",
    question:"Which independently deliverable part of onboarding should be implemented first?",evidence:[]
  }]});
  const result=parseReviewV2({...draft,checks:checked},task);
  assert.equal(result.analysis.findings.length,3);
  assert.ok(result.findingDimensions.includes("granularity"));
});

test("2.2 autonomous agent missing environment is a real dependency, not a universal field requirement",()=>{
  const task=parseTask({title:"Agent fixes auth",description:"Have an autonomous coding agent fix login, but the agent has no repository access and no test environment.",type:"Bug",domain:"Software",criteria:"Verify the fix before merging.",context:""});
  const sample=toV2({summary:"The agent cannot run without a repository.",findings:[],suggestedRewrite:"Fix the authentication bug when access is available."});
  sample.detectedDomain="Software";sample.detectedType="Bug";
  Object.assign(sample.checks.find(c=>c.dimension==="dependencies"),{
    assessment:"gap",kind:"missing",severity:"important",title:"Agent lacks source access",
    detail:"The task states that the agent lacks access to the repository and cannot inspect or test code.",
    question:"Which repository and safe test environment should the agent use?",evidence:["no repository access"]
  });
  const result=parseReviewV2(sample,task);
  assert.ok(result.findingDimensions.includes("dependencies"));
  assert.equal(result.analysis.status,"needs_clarification");
});


test("2.3 derives summary from final findings, ignoring optimistic model claims", () => {
  const task = parseTask({
    title:"Add dark mode",
    description:"Users want dark mode on web and mobile. Follow the design from Figma.",
    type:"Feature",domain:"Software",criteria:"",context:"",
  });
  const sample=toV2({summary:"The task is well-defined; no missing details are present.",findings:[],suggestedRewrite:"Implement dark mode."});
  sample.detectedDomain="Software";sample.detectedType="Feature";
  sample.checks=sample.checks.map(c=>c.dimension==="scope"
    ? {...c,assessment:"gap",severity:"important",kind:"missing",title:"Screens unspecified",
      detail:"No specific screens are listed for dark mode.",question:"Which screens are covered?",
      evidence:["dark mode on web and mobile"]}
    : c);
  const parsed=parseReviewV2(sample,task);
  assert.equal(parsed.analysis.status,"needs_clarification");
  assert.match(parsed.analysis.summary,/Screens unspecified/);
  assert.doesNotMatch(parsed.analysis.summary,/well-defined|no missing details/i);
});

test("2.3 accepts optional source fields without requiring them from legacy clients", () => {
  const old=parseTask(originalTask);
  assert.equal("scope" in old,false);
  const task=parseTask({...repairTask,scope:"Only Settings screen",
    outcome:"Users can select a theme",references:"https://example.com/design"});
  assert.equal(task.scope,"Only Settings screen");
  assert.equal(task.outcome,"Users can select a theme");
  assert.equal(task.references,"https://example.com/design");
  assert.throws(()=>parseTask({...originalTask,scope:42}),ValidationError);
  assert.throws(()=>parseTask({...originalTask,references:"x".repeat(1001)}),ValidationError);
  const sample=toV2({summary:"Missing component details.",findings:[],suggestedRewrite:"Review the theme feature."});
  sample.checks=sample.checks.map(c=>c.dimension==="references"
    ? {...c,assessment:"gap",severity:"important",kind:"missing",title:"Reference needs review",
      detail:"The cited reference should be checked for design completeness.",
      question:"Which reference frames apply?",evidence:["https://example.com/design"]}
    : c);
  assert.deepEqual(parseReviewV2(sample,task).analysis.findings[0].evidence,["https://example.com/design"]);
  sample.checks.find(c=>c.dimension==="references").evidence=["https://example.com/fake"];
  assert.throws(()=>parseReviewV2(sample,task),ValidationError);
});

test("2.3 structured rewrite separates confirmed context and unresolved choices", async () => {
  const task={
    title:"Add dark mode",description:"Implement dark mode following the design.",
    type:"Feature",domain:"Software",
    scope:"Web settings and mobile settings",outcome:"Users can use a dark theme",
    references:"https://example.com/figma",criteria:"Theme is available in settings",
    context:"Use existing design tokens",
  };
  const {env}=makeEnv({AI:{async run(){return {choices:[{message:{content:JSON.stringify({
    detectedDomain:"Software",detectedType:"Feature",summary:"Looks good.",
    rewriteCore:"Implement dark mode using the provided design and settings screens.",
    checks:REVIEW_DIMENSIONS.map(d=>d==="behavior"
      ? {dimension:d,assessment:"gap",severity:"important",kind:"ambiguity",
        title:"Theme switching behavior unresolved",
        detail:"The selection and persistence behavior must be specified.",
        question:"Should selection persist after restart?",evidence:[]}
      : {dimension:d,assessment:"clear",severity:"suggestion",kind:"suggestion",title:"",detail:"",question:"",evidence:[]}),
  })},finish_reason:"stop"}]};}}});
  const res=await worker.fetch(post(task),env);
  assert.equal(res.status,200);
  const a=(await res.json()).analysis;
  assert.equal(a.status,"needs_clarification");
  assert.match(a.suggestedRewrite,/Goal:/);
  assert.match(a.suggestedRewrite,/Scope:\nWeb settings and mobile settings/);
  assert.match(a.suggestedRewrite,/Expected outcome:\nUsers can use a dark theme/);
  assert.match(a.suggestedRewrite,/Confirmed requirements/);
  assert.match(a.suggestedRewrite,/References supplied/);
  assert.match(a.suggestedRewrite,/Open questions:/);
  assert.match(a.suggestedRewrite,/Should selection persist after restart/);
  assert.doesNotMatch(a.suggestedRewrite,/selection will persist/i);
});


test("2.3 rejects unrelated or newly invented rewrite facts", () => {
  const task=parseTask(repairTask);
  assert.equal(isGroundedCore("Follow up with qualified leads after approval tomorrow.",task),false);
  assert.equal(isGroundedCore("Write a welcome note for volunteers at https://invented.example",task),false);
  assert.equal(isGroundedCore("Send 500 welcome notes to volunteers.",task),false);
  assert.equal(isGroundedCore("Prepare a welcome note for new volunteers.",task),true);
});


test("2.4 merges repeated sales contradictions and approval dependency into two distinct root issues", () => {
  const task=parseTask({
    title:"Follow up with every lead today",
    description:"Only contact qualified leads. Do not send messages before the new copy is approved tomorrow. Everyone must be contacted by end of today.",
    type:"General",domain:"Sales",criteria:"",context:"",
  });
  const audit=toV2({summary:"Four problems with outreach.",findings:[],suggestedRewrite:""});
  const gap=(dimension,kind,severity,title,detail,question,evidence)=>({
    dimension,assessment:"gap",kind,severity,title,detail,question,evidence,
  });
  const replacements={
    contradictions:gap("contradictions","contradiction","critical",
      "Conflicting instructions on lead contact",
      "The task says only contact qualified leads but everyone must be contacted today.",
      "Which instruction takes priority: contacting all leads or qualified leads?",
      ["Only contact qualified leads.","Everyone must be contacted by end of today."]),
    dependencies:gap("dependencies","missing","important",
      "Pending copy approval",
      "Copy cannot be sent until approval tomorrow, blocking today's required deadline.",
      "Will the copy be approved in time or should the deadline move?",
      ["Do not send messages before the new copy is approved tomorrow."]),
    scope:gap("scope","missing","important",
      "Unclear audience",
      "The recipient decision between all leads and qualified leads is unresolved.",
      "Should outreach target all leads or qualified leads only?",
      ["Only contact qualified leads."]),
  };
  audit.checks=audit.checks.map(c=>replacements[c.dimension]??c);
  const output=parseReviewV2(audit,task);
  assert.equal(output.analysis.status,"blocked");
  assert.deepEqual(output.analysis.findings.map(f=>f.title),[
    "Deadline conflicts with prerequisite","Audience instructions conflict"
  ]);
  assert.deepEqual(output.findingDimensions,["contradictions","contradictions"]);
  assert.equal(output.reviewCoverage.reported,2);
  assert.equal(output.reviewCoverage.checked,11);
});

test("2.4 blocked review keeps one genuinely independent supporting issue", () => {
  const task=parseTask({
    title:"Follow up with every lead today",
    description:"Only contact qualified leads. Do not send messages before the new copy is approved tomorrow. Everyone must be contacted by end of today. Use the Figma file for message copy.",
    type:"General",domain:"Sales",criteria:"",context:"",
  });
  const audit=toV2({summary:"Conflicts and reference.",findings:[],suggestedRewrite:""});
  audit.checks=audit.checks.map(c=>c.dimension==="references"?
    {...c,assessment:"gap",kind:"missing",severity:"important",
      title:"Message copy reference is unclear",detail:"The Figma file referenced for copy cannot be identified.",
      question:"Which Figma file contains the message copy?",evidence:["Use the Figma file for message copy."]}:c);
  const output=parseReviewV2(audit,task);
  assert.equal(output.analysis.status,"blocked");
  assert.deepEqual(output.analysis.findings.map(f=>f.title),[
    "Deadline conflicts with prerequisite","Audience instructions conflict","Message copy reference is unclear"
  ]);
});

test("2.4 does not merge distinct software scope, behavior and design questions", () => {
  const task=parseTask({title:"Add dark mode",
    description:"Users want dark mode on web and mobile. Follow the design from Figma and ship it next sprint.",
    type:"Feature",domain:"Software",criteria:"",context:""});
  const audit=toV2({summary:"Three decisions are needed.",findings:[],suggestedRewrite:""});
  const issues={
    scope:["Unspecified target screens/components","Which screens and components should support dark mode?","dark mode on web and mobile"],
    behavior:["Unclear theme behavior","Should dark mode be toggled or follow system preferences?","Users want dark mode"],
    references:["Missing design reference link","Which Figma design file should developers use?","Follow the design from Figma"],
  };
  audit.checks=audit.checks.map(c=>issues[c.dimension]?{
    ...c,assessment:"gap",kind:"missing",severity:"important",
    title:issues[c.dimension][0],detail:"This decision needs clarification before implementation.",
    question:issues[c.dimension][1],evidence:[issues[c.dimension][2]]
  }:c);
  const review=parseReviewV2(audit,task);
  assert.deepEqual(review.findingDimensions,["scope","behavior","references"]);
  assert.equal(review.analysis.findings.length,3);
});

test("2.4 rewrites a named but unprovided Figma design conservatively and reduces echoes", () => {
  const task=parseTask({
    title:"Implement dark mode",
    description:"Users want dark mode on web and mobile. Follow the design from Figma and ship it in the next sprint.",
    type:"Feature",domain:"Software",criteria:"",context:"",
  });
  const core="Implement dark mode for web and mobile following the specified Figma design, and ship it in the next sprint.";
  assert.equal(polishRewriteCore(core,task).includes("specified Figma design"),false);
  const draft=assembleRewrite(core,[],task);
  assert.match(draft,/the referenced Figma design/);
  assert.doesNotMatch(draft,/Confirmed requirements/);
  assert.match(draft,/Goal:/);
  const withCriteria=assembleRewrite(core,[],{...task,criteria:"Verify contrast accessibility."});
  assert.match(withCriteria,/Confirmed requirements/);
  assert.match(withCriteria,/Verify contrast accessibility/);
});

test("2.4 retains source requirements that are missing from the rewrite core", () => {
  const task=parseTask({
    title:"Create an onboarding page",
    description:"Create an onboarding page. Do not collect payment card details. Keep translations for French and Turkish.",
    type:"Feature",domain:"Software",criteria:"",context:"",
  });
  const draft=assembleRewrite("Create an onboarding page.",[],task);
  assert.match(draft,/Confirmed requirements/);
  assert.match(draft,/Do not collect payment card details/);
  assert.equal(containsAdditionalRequirements(task.description,"Create an onboarding page."),true);
});


test("2.4 retains separate audience and timing roots even when they cite the same two sentences",()=>{
  const task=parseTask(originalTask);
  const output=parseReviewV2(toV2(validAnalysis),task);
  assert.deepEqual(output.analysis.findings.map(f=>f.title),[
    "Deadline conflicts with prerequisite","Audience instructions conflict"
  ]);
  assert.equal(output.reviewCoverage.reported,2);
});


test("API correlation IDs are returned to client, without logging task content or access token", async () => {
  const originalInfo=console.info, originalWarn=console.warn;
  const messages=[];
  console.info=(...args)=>messages.push(args);
  console.warn=(...args)=>messages.push(args);
  try {
    const {env}=makeEnv();
    const req=post(originalTask,{"X-Request-ID":"frontend-trace-test-01"});
    const res=await worker.fetch(req,env);
    assert.equal(res.status,200);
    assert.equal(res.headers.get("X-Request-ID"),"frontend-trace-test-01");
    const serialized=JSON.stringify(messages);
    assert.match(serialized,/issuelint.request_started/);
    assert.match(serialized,/issuelint.inference_stage/);
    assert.match(serialized,/issuelint.analysis_result/);
    assert.doesNotMatch(serialized,/Contact all leads today|test-preview-secret-with-24-plus-characters/);
  } finally { console.info=originalInfo; console.warn=originalWarn; }
});

test("private frontend diagnostics endpoint accepts only bounded, authenticated, allowlisted values", async () => {
  const {env}=makeEnv();
  const urlBase=url+"/api/client-events";
  const payload={event:"review_failed",category:"http",status:502,durationMs:3210};
  const send=(body,headers={})=>worker.fetch(new Request(urlBase,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer test-preview-secret-with-24-plus-characters",
      "X-Request-ID":"browser-trace-001",...headers},
    body:typeof body==="string"?body:JSON.stringify(body)
  }),env);
  const originalWarn=console.warn;
  const captured=[];
  console.warn=(...args)=>captured.push(args);
  try {
    const ok=await send(payload);
    assert.equal(ok.status,200);
    assert.equal(ok.headers.get("X-Request-ID"),"browser-trace-001");
    assert.equal((await ok.json()).ok,true);
    assert.match(JSON.stringify(captured),/issuelint.client_event/);
    assert.doesNotMatch(JSON.stringify(captured),/test-preview-secret-with-24-plus-characters/);
    const noAuth=await send(payload,{Authorization:""});
    assert.equal(noAuth.status,401);
    const arbitrary=await send({...payload,task:"should never appear in logs"});
    assert.equal(arbitrary.status,422);
    const huge=await send("x".repeat(1100));
    assert.equal(huge.status,422);
    assert.doesNotMatch(JSON.stringify(captured),/should never appear in logs/);
  }finally{console.warn=originalWarn;}
});


test("Worker verifier logs safe contract subcode, never raw SayGM response or task content", async () => {
  const originalFetch=globalThis.fetch, originalWarn=console.warn;
  const events=[];
  const invented="CONFIDENTIAL_EXAMPLE_NOT_IN_TASK";
  globalThis.fetch=async()=>new Response(JSON.stringify({
    choices:[{finish_reason:"stop",message:{content:JSON.stringify({
      verdicts:[{dimension:"scope",action:"ADD",
        reason:"The named screen boundaries have not yet been confirmed.",
        severity:"important",title:"Clarify screen coverage",
        detail:"The ticket does not identify every affected area in this screen.",
        question:"Which specific screens are affected?",
        evidence:[invented]
      }],repair_needed:false
    })}}]
  }),{status:200,headers:{"Content-Type":"application/json"}});
  console.warn=(...args)=>events.push(args);
  try {
    const {env}=makeEnv({SAYGM_API_KEY:"private-secret-not-for-logs",FEEDBACK_VERIFIER_MODE:"on"});
    const res=await worker.fetch(post(),env);
    assert.equal(res.status,200);
    assert.equal((await res.json()).mode,"ai");
    const safe=JSON.stringify(events);
    assert.match(safe,/issuelint.verifier_result/);
    assert.match(safe,/"category":"invalid_patch"/);
    assert.match(safe,/"validationCode":"evidence_not_in_task"/);
    assert.doesNotMatch(safe,/CONFIDENTIAL_EXAMPLE_NOT_IN_TASK|private-secret-not-for-logs|Contact all leads today/);
  }finally{
    globalThis.fetch=originalFetch;
    console.warn=originalWarn;
  }
});
