#!/usr/bin/env node
/**
 * REAL MODEL golden evaluation, deliberately excluded from default CI.
 * Usage: ISSUELINT_EVAL_TOKEN=<private preview access> npm run eval:live -- [--repeat 2] [--case software-dark-mode-vague]
 * Prints aggregate scores only. Never logs task text or bearer token.
 */
import { readFile } from "node:fs/promises";
import { evaluateSummary, scoreEvaluation, repeatConsistency } from "./eval-metrics.mjs";

const opts=process.argv.slice(2);
const option=(key,def)=>{const i=opts.indexOf(key);return i<0?def:opts[i+1];};
const repeat=Number(option("--repeat","1"));
const selected=option("--case","");
const base=option("--base","https://issuelint-dev.yorulmazyln.workers.dev").replace(/\/$/,"");
const token=process.env.ISSUELINT_EVAL_TOKEN;
if(!token || token.length<20){
  console.error("Missing ISSUELINT_EVAL_TOKEN. Use a private access code; never commit it.");
  process.exit(2);
}
if(!/^https:\/\//.test(base) || !Number.isInteger(repeat) || repeat<1 || repeat>3){
  console.error("Expected HTTPS --base and --repeat between 1 and 3");
  process.exit(2);
}
const golden=JSON.parse(await readFile(new URL("../eval/golden.json",import.meta.url),"utf8"));
const fixtures=golden.cases.filter(item=>!selected||item.id===selected);
if(!fixtures.length){console.error("No fixture matches --case");process.exit(2);}
const rows=[];
for(const item of fixtures){
  for(let n=0;n<repeat;n++){
    const started=Date.now();
    let res;
    try {
      res=await fetch(base+"/api/analyze",{
        method:"POST",
        headers:{"content-type":"application/json",authorization:"Bearer "+token},
        body:JSON.stringify(item.task),
        signal:AbortSignal.timeout(120_000),
      });
      const data=await res.json();
      if(!res.ok || data.analyzed!==true || !data.analysis){
        throw Error("HTTP "+res.status+" ("+String(data.error||"invalid response")+")");
      }
      const analysis=data.analysis;
      if(!Array.isArray(analysis.findingDimensions) || analysis.findingDimensions.length!==analysis.findings.length){
        throw Error("V2.1 API must include dimension identifiers for every finding");
      }
      const score=scoreEvaluation(item,analysis);
      const usage=analysis.modelUsage||null;
      rows.push({id:item.id,iteration:n+1,latencyMs:Date.now()-started,score,usage});
      console.log(JSON.stringify({id:item.id,run:n+1,latencyMs:Date.now()-started,
        expected:item.expected,detected:score.dimensions,missed:score.missed,
        unexpected:score.unexpected,statusCorrect:score.statusCorrect,modelCalls:usage?.calls??null,
        neurons:usage?.neurons??null}));
    } catch(error){
      console.error(JSON.stringify({id:item.id,run:n+1,error:String(error).slice(0,160)}));
      process.exitCode=1;
    }
  }
}
const summary=evaluateSummary(rows);
const consistency=repeatConsistency(rows);
console.log("\nGolden Evaluation v"+golden.version+" — actual deployed model");
console.log(JSON.stringify({...summary,repeatConsistency:consistency},null,2));
console.log("Gold labels are human-authored; false-positive figures reflect their coverage, not objective truth.");
if(rows.length!==fixtures.length*repeat)process.exitCode=1;
