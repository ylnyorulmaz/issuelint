import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.ts";
import { REVIEW_DIMENSIONS } from "../worker/review-v2.ts";
import {
  callGeminiDecisions, buildDecisionPayload, parseDecisionResponse,
  DecisionError, DECISION_MODEL, DECISION_ENDPOINT,
} from "../worker/decision.ts";

const token="private-preview-test-secret-123456789";
const task={
  title:"Add dark mode",
  description:"Users want dark mode on web and mobile. Follow the design from Figma and ship it in the next sprint.",
  type:"Feature",domain:"Software",criteria:"",context:"",scope:"",
  references:"",
};
const sampleResponse=()=>({
  answers:Object.fromEntries(REVIEW_DIMENSIONS.map(dim=>[
    dim,{choice:dim==="scope"||dim==="references"?"gap":"clear",
      confidence:dim==="scope"||dim==="references"?0.87:0.9,
      probabilities:dim==="scope"||dim==="references"?
        {clear:0.08,gap:0.87,not_applicable:0.05}:
        {clear:0.9,gap:0.08,not_applicable:0.02}}
  ]))
});

test("buildDecisionPayload sends all eleven independent choice questions in one input",()=>{
  const payload=buildDecisionPayload(task);
  assert.equal(payload.model,DECISION_MODEL);
  assert.equal(typeof payload.input,"string");
  assert.match(payload.input,/Figma/);
  assert.deepEqual(Object.keys(payload.questions),[...REVIEW_DIMENSIONS]);
  assert.equal(Object.keys(payload.questions).length,11);
  for(const q of Object.values(payload.questions)){
    assert.equal(q.type,"choice");
    assert.ok(q.instructions.length>40);
    assert.deepEqual(Object.keys(q.criteria),["clear","gap","not_applicable"]);
    assert.ok(q.criteria.gap.length>20);
  }
  assert.match(payload.questions.scope.criteria.gap,/pages|screens|platforms|components/i);
  assert.match(payload.questions.references.criteria.gap,/Figma/i);
  assert.match(payload.questions.completion.criteria.clear,/unnecessary|atomic/i);
});

test("Gemini API request uses server secret header and one POST, not eleven calls",async()=>{
  const calls=[];
  const output=await callGeminiDecisions(task,"server-private-api-key",async(url,init)=>{
    calls.push({url,init});
    return new Response(JSON.stringify(sampleResponse()),{status:200});
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,DECISION_ENDPOINT);
  assert.equal(calls[0].init.method,"POST");
  assert.equal(calls[0].init.headers["x-goog-api-key"],"server-private-api-key");
  assert.equal(calls[0].init.headers.Authorization,undefined);
  assert.equal(JSON.parse(calls[0].init.body).model,"gemini-decision-1");
  assert.equal(Object.keys(JSON.parse(calls[0].init.body).questions).length,11);
  assert.equal(output.checked,11);
  assert.equal(output.gates.length,11);
  assert.equal(output.gates.find(g=>g.dimension==="scope").assessment,"gap");
  assert.equal(output.gates.find(g=>g.dimension==="references").confidence,.87);
  assert.equal(output.gates.find(g=>g.dimension==="clarity").probabilities.clear,.9);
});

test("Decision API rejects incomplete or malformed answers rather than inventing scores",()=>{
  const missing=sampleResponse();
  delete missing.answers.scope;
  assert.throws(()=>parseDecisionResponse(missing),e=>e instanceof DecisionError&&e.code==="invalid_response");
  const malformed=sampleResponse();
  malformed.answers.scope.probabilities={clear:.2,gap:.4,not_applicable:.1};
  assert.throws(()=>parseDecisionResponse(malformed),e=>e instanceof DecisionError&&e.code==="invalid_response");
  const outside=sampleResponse();
  outside.answers.references.confidence=1.8;
  assert.throws(()=>parseDecisionResponse(outside),e=>e instanceof DecisionError&&e.code==="invalid_response");
  const invented=sampleResponse();
  invented.answers.fake=invented.answers.scope;
  assert.throws(()=>parseDecisionResponse(invented),e=>e instanceof DecisionError&&e.code==="invalid_response");
});

test("upstream HTTP failures and oversized responses use safe stable error codes",async()=>{
  await assert.rejects(
    callGeminiDecisions(task,"api-private",async()=>new Response("key=should-never-leak",{status:429})),
    e=>e instanceof DecisionError&&e.code==="provider_http"&&e.providerStatus===429&&
      !e.message.includes("should-never-leak")
  );
  await assert.rejects(
    callGeminiDecisions(task,"api-private",async()=>new Response("x".repeat(130_000),{status:200})),
    e=>e instanceof DecisionError&&e.code==="response_too_large"
  );
  await assert.rejects(
    callGeminiDecisions(task,"api-private",async()=>{throw new Error("API KEY EXPOSED")}),
    e=>e instanceof DecisionError&&e.code==="network"&&!e.message.includes("API KEY")
  );
  await assert.rejects(callGeminiDecisions(task,undefined),
    e=>e instanceof DecisionError&&e.code==="config");
});

function request(body=task,extraHeaders={}){
  return new Request("https://issuelint.example/api/analyze-v2",{
    method:"POST",
    headers:{"Content-Type":"application/json",
      Authorization:"Bearer "+token,"X-Request-ID":"decision-test-001",...extraHeaders},
    body:typeof body==="string"?body:JSON.stringify(body),
  });
}
function env(overrides={}){
  return {
    AI:{async run(){throw Error("V2 should not invoke GPT-OSS")}},
    ASSETS:{async fetch(){return new Response("asset")}},
    ANALYZE_ENABLED:"true",PREVIEW_TOKEN:token,
    GEMINI_API_KEY:"fake-key-for-test",...overrides,
  };
}
test("Worker health reports Gemini key presence but never discloses value",async()=>{
  for(const [key,configured] of [[undefined,false],["fake-key-for-test",true]]) {
    const res=await worker.fetch(new Request("https://issuelint.example/api/health"),env({GEMINI_API_KEY:key}));
    const b=await res.json();
    assert.equal(b.decisionConfigured,configured);
    assert.ok(!JSON.stringify(b).includes("fake-key-for-test"));
  }
});

test("V2 fails closed on missing preview code, missing Gemini key and malformed input",async()=>{
  const noAuth=await worker.fetch(request(task,{Authorization:""}),env());
  assert.equal(noAuth.status,401);
  assert.equal((await noAuth.json()).error,"PREVIEW_AUTH_REQUIRED");
  const noKey=await worker.fetch(request(),env({GEMINI_API_KEY:undefined}));
  assert.equal(noKey.status,503);
  assert.equal((await noKey.json()).error,"DECISION_NOT_CONFIGURED");
  const off=await worker.fetch(request(),env({ANALYZE_ENABLED:"false"}));
  assert.equal(off.status,503);
  assert.equal((await off.json()).error,"AI_DISABLED");
  const invalid=await worker.fetch(request({...task,description:""}),env());
  assert.equal(invalid.status,422);
  assert.equal((await invalid.json()).error,"INVALID_TASK");
  const wrongContent=await worker.fetch(request(task,{"Content-Type":"text/plain"}),env());
  assert.equal(wrongContent.status,415);
});

test("V2 logs eleven decisions safely and returns only validated scorecard",async()=>{
  const priorFetch=globalThis.fetch;
  const priorInfo=console.info;
  const priorWarn=console.warn;
  const events=[];
  let sent;
  globalThis.fetch=async(_url,init)=>{
    sent=init;
    return new Response(JSON.stringify(sampleResponse()),{status:200});
  };
  console.info=(...a)=>events.push(a);
  console.warn=(...a)=>events.push(a);
  try {
    const res=await worker.fetch(request(),env());
    assert.equal(res.status,200);
    assert.equal(res.headers.get("X-Request-ID"),"decision-test-001");
    const b=await res.json();
    assert.equal(b.mode,"decision");
    assert.equal(b.analyzed,true);
    assert.equal(b.decision.checked,11);
    assert.equal(b.decision.gates.length,11);
    assert.equal(Object.keys(JSON.parse(sent.body).questions).length,11);
    const flat=JSON.stringify(events);
    assert.match(flat,/issuelint.decision_started/);
    assert.match(flat,/issuelint.decision_gate/);
    assert.match(flat,/issuelint.decision_result/);
    assert.doesNotMatch(flat,/fake-key-for-test|private-preview-test-secret|Figma|Users want/);
    assert.equal(events.filter(x=>x[0]==="issuelint.decision_gate").length,11);
  }finally {globalThis.fetch=priorFetch;console.info=priorInfo;console.warn=priorWarn;}
});
