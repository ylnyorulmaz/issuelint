import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";
import {scoreEvaluation,evaluateSummary,repeatConsistency} from "../scripts/eval-metrics.mjs";

test("golden fixtures cover four domains and distinguish ready from incomplete work",async()=>{
  const golden=JSON.parse(await readFile(new URL("../eval/golden.json",import.meta.url),"utf8"));
  assert.equal(golden.version,"2.1");
  assert.ok(golden.cases.length>=12);
  for(const domain of ["Software","Sales","Marketing","Operations"]){
    assert.ok(golden.cases.some(x=>x.domain===domain),"missing domain "+domain);
  }
  assert.ok(golden.cases.some(x=>x.task.description.includes("koyu tema")));
  const ids=new Set();
  for(const example of golden.cases){
    assert.ok(example.id&&!ids.has(example.id),"duplicate fixture ID");
    ids.add(example.id);
    assert.ok(Array.isArray(example.expected)&&Array.isArray(example.allowed));
    assert.ok(example.expected.every(d=>example.allowed.includes(d)),"expected must also be allowed");
    assert.ok(["ready","needs_clarification","blocked"].includes(example.status));
  }
});

test("golden evaluator reports genuine misses and unallowed extra findings",()=>{
  const fixture={expected:["scope","behavior"],allowed:["scope","behavior","references"],status:"needs_clarification"};
  const score=scoreEvaluation(fixture,{findingDimensions:["scope","completion"],status:"ready"});
  assert.deepEqual(score.matched,["scope"]);
  assert.deepEqual(score.missed,["behavior"]);
  assert.deepEqual(score.unexpected,["completion"]);
  assert.equal(score.statusCorrect,false);
  const summary=evaluateSummary([{id:"a",score,latencyMs:100,usage:{calls:2,promptTokens:1000,completionTokens:200,neurons:12}}]);
  assert.equal(summary.criticalIssueRecall,0.5);
  assert.equal(summary.unexpectedFindingRate,0.5);
  assert.equal(summary.statusAccuracy,0);
  assert.equal(summary.modelCalls,2);
  assert.equal(summary.neurons,12);
  assert.ok(summary.estimatedUsd>0);
});

test("golden evaluator does not pretend unknown usage means zero cost",()=>{
  const fixture={expected:[],allowed:[],status:"ready"};
  const score=scoreEvaluation(fixture,{findingDimensions:[],status:"ready"});
  const summary=evaluateSummary([{id:"ok",score,latencyMs:31,usage:{calls:1,promptTokens:null,completionTokens:null,neurons:null}}]);
  assert.equal(summary.inputTokens,null);
  assert.equal(summary.neurons,null);
  assert.equal(summary.estimatedUsd,null);
  assert.equal(repeatConsistency([{id:"same",score},{id:"same",score}]),1);
});
