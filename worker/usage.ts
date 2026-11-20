/**
 * Non-sensitive inference telemetry for private evaluation.
 * Never include prompts, task text, credentials, or generated content.
 */
export type ModelUsage = {
  calls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  neurons: number | null;
  latencyMs: number;
};
export function emptyUsage(): ModelUsage {
  return { calls:0, promptTokens:null, completionTokens:null, neurons:null, latencyMs:0 };
}
function record(v:unknown):v is Record<string,unknown>{
  return !!v && typeof v==="object" && !Array.isArray(v);
}
function metric(v:unknown):number|null{
  return typeof v==="number" && Number.isFinite(v) && v>=0?v:null;
}
export function collectUsage(result:unknown,current:ModelUsage):void {
  if(!record(result)||!record(result.usage))return;
  const u=result.usage;
  const prompt=metric(u.prompt_tokens ?? u.input_tokens);
  const output=metric(u.completion_tokens ?? u.output_tokens);
  const neurons=metric(u.neurons);
  if(prompt!==null)current.promptTokens=(current.promptTokens??0)+prompt;
  if(output!==null)current.completionTokens=(current.completionTokens??0)+output;
  if(neurons!==null)current.neurons=(current.neurons??0)+neurons;
}
