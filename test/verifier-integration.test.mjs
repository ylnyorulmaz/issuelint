import test from "node:test";
import assert from "node:assert/strict";
import { runAnalysis } from "../worker/inference.ts";
import { REVIEW_DIMENSIONS } from "../worker/review-v2.ts";
import { verifyPatchedReview } from "../worker/verifier-patch.ts";

const task = {title:"Change login button label",description:"Replace Sing in with Sign in on the login screen.",
 type:"Bug",domain:"Software",criteria:"Button displays Sign in.",context:""};
const checks=REVIEW_DIMENSIONS.map(d=>({dimension:d,assessment:"clear",severity:"suggestion",
 kind:"missing",title:"",detail:"",evidence:[],question:""}));
const source={detectedDomain:"Software",detectedType:"Bug",summary:"",rewriteCore:"Replace Sing in with Sign in on the login screen.",checks};
const gap={dimension:"scope",action:"ADD",reason:"The relevant screen boundary is unspecified.",
 severity:"important",title:"Clarify screen coverage",
 detail:"The ticket names the login screen but leaves other login surfaces ambiguous.",
 question:"Does this change apply to other login screens?",evidence:["login screen"]};
function runner() {
 const calls=[];
 const ai={async run(_model,options){
  calls.push(options);
  if(options.messages[0].content.includes("You edit work tickets"))
   return {choices:[{message:{content:JSON.stringify({suggestedRewrite:"Update the login button label to Sign in."})}}]};
  return {choices:[{message:{content:JSON.stringify(source)},finish_reason:"stop"}]};
 }};
 return {ai,calls};
}
test("on mode applies a grounded patch and recomputes final status",async()=>{
 const {ai}=runner();
 const result=await runAnalysis(task,ai,undefined,async()=>({verdicts:[gap],repair_needed:false}),true);
 assert.equal(result.status,"needs_clarification");
 assert.ok(result.findings.some(f=>f.title==="Clarify screen coverage"));
 assert.equal(result.reviewCoverage.checked,11);
});
test("invalid verifier patch falls back to primary review without throwing",async()=>{
 const {ai}=runner();
 const result=await runAnalysis(task,ai,undefined,async()=>({verdicts:[{...gap,evidence:["fabricated source quote"]}],repair_needed:false}),true);
 assert.equal(result.status,"ready");
 assert.equal(result.findings.length,0);
});
test("verifier transport failure leaves primary response usable",async()=>{
 const {ai}=runner();
 const result=await runAnalysis(task,ai,undefined,async()=>{throw Error("private provider response");},true);
 assert.equal(result.status,"ready");
 assert.ok(!JSON.stringify(result).includes("private provider response"));
});
test("verifier repair signal triggers exactly one rewrite repair",async()=>{
 const {ai,calls}=runner();
 const result=await runAnalysis(task,ai,undefined,async()=>({verdicts:[gap],repair_needed:true}),true);
 assert.equal(result.status,"needs_clarification");
 assert.ok(calls.length<=2,"one primary and at most one repair call");
 assert.equal(result.modelUsage.calls,calls.length);
});
test("empty verdict with repair_needed does not trigger forced repair",async()=>{
 const {ai,calls}=runner();
 await runAnalysis(task,ai,undefined,async()=>({verdicts:[],repair_needed:true}),true);
 assert.ok(calls.length<=2);
});
test("critical deterministic contradictions survive an unrelated verifier patch",()=>{
 const conflict={title:"Contact all leads today",description:"Only qualified leads can be contacted after approval tomorrow.",
 type:"General",domain:"Sales",criteria:"",context:""};
 const base={...source,detectedDomain:"Sales",detectedType:"General"};
 const result=verifyPatchedReview(base,conflict,checks,{verdicts:[],repair_needed:false});
 assert.equal(result.analysis.status,"blocked");
 assert.ok(result.analysis.findings.some(f=>f.severity==="critical"));
});
