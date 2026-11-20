/** Evaluator core. The labels are manually curated, not ground truth in all contexts. */
export function scoreEvaluation(caseDef, response) {
  const expected=new Set(caseDef.expected);
  const allowed=new Set(caseDef.allowed);
  const dimensions=Array.isArray(response.findingDimensions) ? response.findingDimensions : [];
  const found=new Set(dimensions);
  const matched=[...expected].filter(x=>found.has(x));
  const missed=[...expected].filter(x=>!found.has(x));
  const unexpected=[...found].filter(x=>!allowed.has(x));
  return {
    matched,missed,unexpected,dimensions:[...found],
    expectedCount:expected.size,
    correctCount:matched.length,
    findingCount:dimensions.length,
    unexpectedCount:unexpected.length,
    statusCorrect:response.status===caseDef.status,
  };
}
export function evaluateSummary(rows) {
  const expected=rows.reduce((a,x)=>a+x.score.expectedCount,0);
  const hits=rows.reduce((a,x)=>a+x.score.correctCount,0);
  const predictions=rows.reduce((a,x)=>a+x.score.findingCount,0);
  const unexpected=rows.reduce((a,x)=>a+x.score.unexpectedCount,0);
  const statusMatches=rows.filter(x=>x.score.statusCorrect).length;
  const modelCalls=rows.reduce((n,x)=>n+(x.usage?.calls||0),0);
  const inputTokens=rows.map(x=>x.usage?.promptTokens).filter(x=>typeof x==="number");
  const outputTokens=rows.map(x=>x.usage?.completionTokens).filter(x=>typeof x==="number");
  const neurons=rows.map(x=>x.usage?.neurons).filter(x=>typeof x==="number");
  const sum=values=>values.reduce((a,b)=>a+b,0);
  return {
    samples:rows.length,
    criticalIssueRecall:expected?hits/expected:null,
    unexpectedFindingRate:predictions?unexpected/predictions:0,
    statusAccuracy:rows.length?statusMatches/rows.length:null,
    averageLatencyMs:rows.length?Math.round(sum(rows.map(x=>x.latencyMs))/rows.length):null,
    modelCalls,
    inputTokens:inputTokens.length===rows.length?sum(inputTokens):null,
    outputTokens:outputTokens.length===rows.length?sum(outputTokens):null,
    neurons:neurons.length===rows.length?sum(neurons):null,
    estimatedUsd:inputTokens.length===rows.length && outputTokens.length===rows.length
      ? sum(inputTokens)*0.35/1_000_000 + sum(outputTokens)*0.75/1_000_000:null,
  };
}
export function repeatConsistency(rows){
  const groups=new Map();
  for(const row of rows){
    const prev=groups.get(row.id)||[];
    prev.push(new Set(row.score.dimensions));
    groups.set(row.id,prev);
  }
  const values=[];
  for(const group of groups.values()){
    if(group.length<2)continue;
    const a=group[0],b=group[1];
    const union=new Set([...a,...b]);
    const overlap=[...a].filter(x=>b.has(x)).length;
    values.push(union.size===0?1:overlap/union.size);
  }
  return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
}
