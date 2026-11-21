import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_DIMENSIONS } from "../worker/review-v2.ts";
import { CLEAR_ROUTING_THRESHOLD, buildAuditRequest, routeDecisionGates,
  parseAuditResponse, runSelectiveAudit, exactSourceQuote } from "../worker/decision-audit.ts";
import worker from "../worker/index.ts";

const task={
  title:"Add dark mode",
  description:"Users want dark mode on web and mobile. Follow the design from Figma and ship it in the next sprint.",
  type:"Feature",domain:"Software",criteria:"",context:"",scope:"",outcome:"",references:"",
};
function decision(clearByDimension={}){
  return {
    model:"gemini-decision-1",checked:11,durationMs:125,
    gates:REVIEW_DIMENSIONS.map(d=>({
      dimension:d,assessment:"clear",confidence:clearByDimension[d]??.95,
      probabilities:{clear:clearByDimension[d]??.95,gap:1-(clearByDimension[d]??.95),not_applicable:0},
    })),
  };
}
function check(d,assessment="clear",extra={}){
  return {
    dimension:d,assessment,
    reason:assessment==="clear"?"The supplied task clearly specifies this aspect without material ambiguity.":
      assessment==="not_applicable"?"This dimension does not apply to the particular requested change.":
      "The requested dark mode change cannot be implemented consistently without clarification.",
    severity:assessment==="gap"?"important":"suggestion",
    kind:assessment==="gap"?"missing":"suggestion",
    title:assessment==="gap"?"Clarify the dark mode coverage":"",
    evidence:assessment==="gap"?["Users want dark mode on web and mobile."]:[],
    question:assessment==="gap"?"Which screens and components should support dark mode?":"",
    ...extra,
  };
}
function mockAi(payload,handler){
  const calls=[];
  return {calls,async run(model,input){
    calls.push({model,input});
    if(handler) return handler(model,input);
    return {choices:[{message:{content:JSON.stringify(payload)},finish_reason:"stop"}]};
  }};
}

test("routing is based on P(Clear) alone and uses strict below 0.85",()=>{
  assert.equal(CLEAR_ROUTING_THRESHOLD,.85);
  const d=decision({scope:.849999,behavior:.85,clarity:.2,granularity:.84,references:.01});
  assert.deepEqual(routeDecisionGates(d),["scope","granularity","references","clarity"]);
  const n=decision();
  assert.deepEqual(routeDecisionGates(n),[]);
  const withNa=decision({dependencies:.05});
  withNa.gates.find(g=>g.dimension==="dependencies").assessment="not_applicable";
  withNa.gates.find(g=>g.dimension==="dependencies").probabilities={clear:.05,gap:.05,not_applicable:.9};
  assert.ok(routeDecisionGates(withNa).includes("dependencies"));
});

test("GPT auditor receives task and selected rubrics but no Gemini decisions, scores or probabilities",()=>{
  const req=buildAuditRequest(task,["scope","behavior"]);
  assert.equal(req.reasoning_effort,"high");
  assert.equal(req.messages.length,2);
  assert.deepEqual(JSON.parse(req.messages[1].content).dimensions.map(x=>x.dimension),["scope","behavior"]);
  assert.match(req.messages[1].content,/Figma/);
  assert.doesNotMatch(req.messages[1].content,/probabilities|confidence|gemini|0\.84|0\.85/i);
  assert.deepEqual(req.response_format.json_schema.properties.checks.items.properties.dimension.enum,["scope","behavior"]);
  assert.equal(req.response_format.json_schema.properties.checks.minItems,2);
});

test("one single high-reasoning GPT-OSS request handles every selected gate independently",async()=>{
  const d=decision({scope:.6,behavior:.5,references:.01});
  const selected=routeDecisionGates(d);
  const checks=[
    check("scope","gap"),
    check("behavior","clear"),
    check("references","gap",{
      title:"Missing referenced design file",
      reason:"The work requires a Figma design but no linked file or identifier is included.",
      evidence:["Follow the design from Figma"],
      question:"Which Figma document should implementation follow?",
    }),
  ];
  const ai=mockAi({checks});
  const logs=[];
  const res=await runSelectiveAudit(task,d,ai,undefined,(stage,fields)=>logs.push({stage,fields}));
  assert.equal(ai.calls.length,1);
  assert.equal(ai.calls[0].model,"@cf/openai/gpt-oss-120b");
  assert.equal(ai.calls[0].input.reasoning_effort,"high");
  const userData=JSON.parse(ai.calls[0].input.messages[1].content);
  assert.deepEqual(userData.dimensions.map(x=>x.dimension),selected);
  assert.ok(!("decision" in userData) && !("probabilities" in userData));
  assert.equal(res.status,"complete");
  assert.equal(res.checks.length,3);
  assert.equal(res.checks.find(x=>x.dimension==="behavior").assessment,"clear");
  assert.equal(res.findings.length,2);
  assert.ok(logs.some(x=>x.stage==="completed"));
  assert.ok(logs.every(x=>!JSON.stringify(x).includes("Figma")));
});

test("no audited gates means no GPT call, no fabricated findings",async()=>{
  const ai=mockAi(null,()=>{throw Error("should not run");});
  const res=await runSelectiveAudit(task,decision(),ai);
  assert.equal(res.status,"complete");
  assert.equal(res.selected.length,0);
  assert.equal(res.findings.length,0);
  assert.equal(res.checks.length,0);
  assert.equal(ai.calls.length,0);
});

test("all eleven selected gates fit one request; no hidden per-gate calls",async()=>{
  const ai=mockAi({checks:REVIEW_DIMENSIONS.map(x=>check(x))});
  const res=await runSelectiveAudit(task,decision(Object.fromEntries(REVIEW_DIMENSIONS.map(d=>[d,.6]))),ai);
  assert.equal(ai.calls.length,1);
  assert.equal(res.status,"complete");
  assert.equal(res.checks.length,11);
  assert.equal(res.findings.length,0);
});

test("literal task source grounding rejects invented quotes",()=>{
  assert.equal(exactSourceQuote(task,"Follow the design from Figma"),true);
  assert.equal(exactSourceQuote(task,"This design is approved"),false);
  assert.equal(exactSourceQuote(task,""),false);
  assert.throws(()=>parseAuditResponse({checks:[check("scope","gap",{evidence:["APPROVED FIGMA DESIGN"]})]},task,["scope"]),/invalid_response/);
});

test("independent audit preserves valid Gate findings and isolates malformed evidence",async()=>{
  const d=decision({scope:.6,behavior:.2});
  const valid=check("behavior","gap",{
    title:"Dark mode behavior undefined",
    reason:"The task does not specify activation or persistence, which changes the expected flow.",
    evidence:["Users want dark mode on web and mobile."],
    question:"Should dark mode follow system settings or a user toggle?",
  });
  const ai=mockAi({checks:[
    check("scope","gap",{evidence:["invented specification from Figma"]}),
    valid,
  ]});
  const events=[];
  const res=await runSelectiveAudit(task,d,ai,undefined,(stage,fields)=>events.push({stage,fields}));
  assert.equal(ai.calls.length,1);
  assert.equal(res.status,"partial");
  assert.deepEqual(res.selected,["scope","behavior"]);
  assert.deepEqual(res.unverified,["scope"]);
  assert.deepEqual(res.checks.map(c=>c.dimension),["behavior"]);
  assert.equal(res.findings.length,1);
  assert.equal(res.findings[0].title,"Dark mode behavior undefined");
  assert.ok(events.some(e=>e.stage==="gate_rejected" && e.fields.dimension==="scope" &&
    e.fields.reason==="evidence_not_in_task"));
  assert.ok(!JSON.stringify(events).includes("invented specification"));
});

test("missing or duplicated Gate results are marked unverified, not silently cleared",async()=>{
  const d=decision({scope:.6,behavior:.2});
  for(const checks of [[check("scope")],[check("scope"),check("scope")]]){
    const ai=mockAi({checks});
    const res=await runSelectiveAudit(task,d,ai);
    if(checks.length===1){
      assert.equal(res.status,"partial");
      assert.deepEqual(res.unverified,["behavior"]);
      assert.deepEqual(res.checks.map(c=>c.dimension),["scope"]);
    }else{
      assert.equal(res.status,"unavailable");
      assert.deepEqual(res.unverified,["scope","behavior"]);
      assert.deepEqual(res.checks,[]);
    }
    assert.deepEqual(res.findings,[]);
  }
});

test("whole batch fails closed if no gate result survives validation",async()=>{
  const d=decision({scope:.6,behavior:.2});
  const ai=mockAi({checks:[
    check("scope","gap",{evidence:["fabricated quote"]}),
    check("behavior","gap",{evidence:["also fabricated"]}),
  ]});
  const res=await runSelectiveAudit(task,d,ai);
  assert.equal(res.status,"unavailable");
  assert.equal(res.errorCategory,"invalid_response");
  assert.deepEqual(res.unverified,["scope","behavior"]);
  assert.deepEqual(res.findings,[]);
  assert.deepEqual(res.checks,[]);
});

test("pure quotation wrappers are stripped only when literal original passage matches",async()=>{
  const d=decision({scope:.6});
  const ai=mockAi({checks:[check("scope","gap",{
    title:"Dark mode coverage unspecified",
    reason:"The change names platforms but leaves the affected page boundaries unclear.",
    evidence:["“Users want dark mode on web and mobile.”"],
    question:"Which pages should use dark mode?",
  })]});
  const res=await runSelectiveAudit(task,d,ai);
  assert.equal(res.status,"complete");
  assert.deepEqual(res.unverified,[]);
  assert.equal(res.checks[0].evidence[0],"Users want dark mode on web and mobile.");
  assert.equal(res.findings.length,1);
});

test("GPT model or truncation failures keep Gemini routing without fake findings",async()=>{
  const d=decision({scope:.84});
  const failed=await runSelectiveAudit(task,d,mockAi(null,async()=>{throw Error("some provider secrets");}));
  assert.equal(failed.status,"unavailable");
  assert.equal(failed.errorCategory,"upstream");
  assert.deepEqual(failed.checks,[]);
  const truncated=await runSelectiveAudit(task,d,mockAi(null,()=>({
    choices:[{message:{content:"{}"},finish_reason:"length"}],
  })));
  assert.equal(truncated.status,"unavailable");
  assert.equal(truncated.errorCategory,"truncated");
  const unconfigured=await runSelectiveAudit(task,d,undefined);
  assert.equal(unconfigured.status,"unavailable");
  assert.equal(unconfigured.errorCategory,"not_configured");
});

const token="iteration-two-private-preview-token-1234567";
const decisionFromGoogle=()=>{
  const d=decision({scope:.63,behavior:.6,references:.01});
  return {answers:Object.fromEntries(d.gates.map(g=>[g.dimension,{
    choice:g.assessment,confidence:g.confidence,probabilities:g.probabilities
  }]))};
};
function request(tokenValue=token){
  return new Request("https://issuelint.example/api/analyze-v2",{
    method:"POST",headers:{
      "Content-Type":"application/json",Authorization:"Bearer "+tokenValue,
      "X-Request-ID":"iteration2-test-01",
    },body:JSON.stringify(task),
  });
}
function env(ai){
  return {ANALYZE_ENABLED:"true",PREVIEW_TOKEN:token,GEMINI_API_KEY:"fake-google-test-only",
    AI:ai,AI_MODEL:"@cf/openai/gpt-oss-120b",
    ASSETS:{async fetch(){return new Response("ASSETS")}},
  };
}
test("Worker V2 integration routes once after Gemini, returns source-checked audit and safe logs",async()=>{
  const savedFetch=globalThis.fetch,savedInfo=console.info,savedWarn=console.warn;
  const events=[];
  const ai=mockAi({checks:[
    check("scope","gap"),check("behavior","clear"),
    check("references","gap",{
      title:"Missing Figma file",
      reason:"The referenced design is required for implementation but its location is missing.",
      evidence:["Follow the design from Figma"],
      question:"Where is the Figma design file?",
    }),
  ]});
  let googleCalls=0;
  globalThis.fetch=async(_url,init)=>{googleCalls++;return new Response(JSON.stringify(decisionFromGoogle()),{status:200});};
  console.info=(...args)=>events.push(args);
  console.warn=(...args)=>events.push(args);
  try {
    const res=await worker.fetch(request(),env(ai));
    assert.equal(res.status,200);
    const out=await res.json();
    assert.equal(out.decision.audit.status,"complete");
    assert.deepEqual(out.decision.audit.selected,["scope","behavior","references"]);
    assert.equal(out.decision.audit.checks.length,3);
    assert.equal(out.decision.audit.findings.length,2);
    assert.equal(googleCalls,1);
    assert.equal(ai.calls.length,1);
    const logs=JSON.stringify(events);
    assert.match(logs,/issuelint.decision_audit/);
    assert.doesNotMatch(logs,/fake-google-test-only|iteration-two-private|Users want|Figma/);
  } finally {globalThis.fetch=savedFetch;console.info=savedInfo;console.warn=savedWarn;}
});
test("Worker V2 rejects bad Bearer before calling either model",async()=>{
  const ai=mockAi(null,()=>{throw Error("must not run");});
  const previousFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error("must not run");};
  try {
    const res=await worker.fetch(request("incorrect-token"),env(ai));
    assert.equal(res.status,401);
    assert.equal(ai.calls.length,0);
    assert.equal(calls,0);
  }finally{globalThis.fetch=previousFetch;}
});
