import test from "node:test";
import assert from "node:assert/strict";
import { applyVerifierVerdict, verifyPatchedReview } from "../worker/verifier-patch.ts";
import { parseReviewV2, REVIEW_DIMENSIONS } from "../worker/review-v2.ts";
const task={title:"Add dark mode",description:"Add dark mode on Settings screen.",type:"Feature",domain:"Software",criteria:"",context:""};
const checks=REVIEW_DIMENSIONS.map(d=>({dimension:d,assessment:"clear",severity:"suggestion",kind:"missing",title:"",detail:"",question:"",evidence:[]}));
const original={detectedDomain:"Software",detectedType:"Feature",summary:"",checks,rewriteCore:"Add dark mode on Settings screen."};
const patch={dimension:"scope",action:"ADD",reason:"The affected screen boundaries are unspecified.",
 severity:"important",title:"Clarify screen coverage",
 detail:"The request names Settings but does not say whether other screens should change.",
 question:"Should dark mode affect any screens beyond Settings?",evidence:["Settings screen"]};
test("ADD becomes a validated important finding and recalculates status",()=>{
 const result=verifyPatchedReview(original,task,checks,{verdicts:[patch],repair_needed:false});
 assert.equal(result.analysis.status,"needs_clarification");
 assert.ok(result.analysis.findings.some(f=>f.title==="Clarify screen coverage"));
 assert.equal(result.reviewCoverage.checked,11);
 assert.equal(result.reviewCoverage.gaps,1);
 assert.equal(checks.find(c=>c.dimension==="scope").assessment,"clear");
});
test("SUPPRESS removes a noncritical finding and recalculates ready",()=>{
 const withGap=applyVerifierVerdict(task,checks,{verdicts:[patch],repair_needed:false});
 const result=verifyPatchedReview({...original,checks:withGap},task,withGap,{
  verdicts:[{dimension:"scope",action:"SUPPRESS",reason:"The scope is sufficient for an atomic task."}],repair_needed:false
 });
 assert.equal(result.analysis.status,"ready");
 assert.equal(result.analysis.findings.length,0);
});
test("critical contradiction cannot be suppressed or downgraded",()=>{
 const conflict=checks.map(c=>c.dimension==="contradictions"?{...c,assessment:"gap",severity:"critical",kind:"contradiction",
  title:"Conflicting instructions",detail:"Requirements conflict",question:"Which requirement wins?",
  evidence:["Add dark mode","Settings screen"]}:c);
 assert.throws(()=>applyVerifierVerdict(task,conflict,{verdicts:[{
  dimension:"contradictions",action:"SUPPRESS",reason:"Ignore the apparent contradiction."
 }],repair_needed:false}));
});
test("a fabricated quote fails atomically and does not mutate checks",()=>{
 assert.throws(()=>applyVerifierVerdict(task,checks,{verdicts:[{...patch,evidence:["approved Figma design"]}],repair_needed:false}));
 assert.equal(checks.find(c=>c.dimension==="scope").assessment,"clear");
});
test("verifier cannot create a critical finding",()=>{
 assert.throws(()=>applyVerifierVerdict(task,checks,{verdicts:[{...patch,severity:"critical"}],repair_needed:false}));
});
