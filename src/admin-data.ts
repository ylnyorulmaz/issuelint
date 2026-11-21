import type { Task } from './analyzer';
import { prepareReviewTask, reviewInputValid } from './review-task.ts';
import { ApiError } from './api.ts';
import { newRequestId } from './diagnostics.ts';

export type AdminSource = 'chatgpt' | 'gemini' | 'paste';
export type AdminExpectedIssue = { dimension: string; issue: string; importance?: string; question?: string };
export type AdminOracle = {
  expected_status: 'ready' | 'needs_clarification' | 'blocked';
  must_detect: AdminExpectedIssue[];
  bonus_detect?: AdminExpectedIssue[];
  expected_material_findings?: string;
  must_not_invent?: string[];
};
export type AdminCase = {
  id: string;
  domain: Task['domain'];
  quality: 'deliberately_flawed' | 'well_specified_control';
  scenario?: string;
  evaluation_role?: string;
  task: Task;
  oracle: AdminOracle;
};
export type AdminFixture = {
  source: AdminSource;
  dataset_id: string;
  schema_version: string;
  status: string;
  cases: AdminCase[];
};
const TYPES = new Set(['General','Bug','Feature','Improvement','Request']);
const DOMAINS = new Set(['Software','Marketing','Sales']);
const DIMENSIONS = new Set([
  'contradictions','actionability','scope','granularity','behavior','completion',
  'outcome','references','dependencies','clarity','feasibility',
]);
function record(v:unknown):v is Record<string,unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
/** Keep a strict, stable client shape without mixing rubric oracle into model requests. */
export function parseAdminFixture(input:unknown, source:AdminSource):AdminFixture {
  const invalid=()=>new ApiError('INVALID_FIXTURE','The test set has an invalid shape.',0);
  if(!record(input)||input.source!==source||typeof input.dataset_id!=='string'||
    typeof input.schema_version!=='string'||typeof input.status!=='string'||
    !Array.isArray(input.cases)||input.cases.length!==(source==='paste'?4:12)) throw invalid();
  const seen=new Set<string>();
  const cases:AdminCase[]=[];
  for(const raw of input.cases) {
    if(!record(raw)||typeof raw.id!=='string'||!(source==='paste'?/^P-0[1-4]$/.test(raw.id):/^(SW|MK|SA|G-SW|G-MK|G-SA)-0[1-4]$/.test(raw.id))||
      seen.has(raw.id)||!record(raw.task)||!record(raw.oracle)||
      !(source==='paste'?raw.domain==='Other':DOMAINS.has(String(raw.domain)))||
      !['deliberately_flawed','well_specified_control'].includes(String(raw.quality)) ||
      !['ready','needs_clarification','blocked'].includes(String(raw.oracle.expected_status))||
      !Array.isArray(raw.oracle.must_detect)) throw invalid();
    seen.add(raw.id);
    const t=raw.task;
    const keys=['title','description','type','domain','criteria','context','scope','outcome','references'];
    if(!keys.every(k=>typeof t[k]==='string')||
      !TYPES.has(String(t.type))||(source==='paste'?t.domain!=='Other':!DOMAINS.has(String(t.domain)))||
      t.domain!==raw.domain||(source!=='paste'&&(t.title as string).length<1)||(t.title as string).length>180||
      (t.description as string).length<1||(t.description as string).length>6500||
      String(t.criteria).length>1200||String(t.context).length>1200||
      ['scope','outcome','references'].some(k=>String(t[k]).length>1000)||
      keys.filter(k=>k!=='type'&&k!=='domain').reduce((n,k)=>n+String(t[k]).length,0)>8000)
      throw invalid();
    if(source==='paste' && (t.title!=='' || t.type!=='General' ||
      ['criteria','context','scope','outcome','references'].some(k=>t[k]!=='') ||
      !reviewInputValid(t as Task))) throw invalid();
    const issues=(entries:unknown):AdminExpectedIssue[]=>{
      if(!Array.isArray(entries)||entries.length>11)throw invalid();
      return entries.map(v=>{
        if(!record(v)||typeof v.dimension!=='string'||!DIMENSIONS.has(v.dimension)||
          typeof v.issue!=='string'||v.issue.length<5||v.issue.length>800)
          throw invalid();
        return { dimension:v.dimension,issue:v.issue,
          ...(typeof v.importance==='string'?{importance:v.importance}:{}),
          ...(typeof v.question==='string'?{question:v.question}:{}) };
      });
    };
    const oracle:AdminOracle={
      expected_status:raw.oracle.expected_status as AdminOracle['expected_status'],
      must_detect:issues(raw.oracle.must_detect),
      ...(raw.oracle.bonus_detect?{bonus_detect:issues(raw.oracle.bonus_detect)}:{}),
      ...(typeof raw.oracle.expected_material_findings==='string'?
        {expected_material_findings:raw.oracle.expected_material_findings}:{}),
      ...(Array.isArray(raw.oracle.must_not_invent)?
        {must_not_invent:raw.oracle.must_not_invent.filter(v=>typeof v==='string').slice(0,10)}:{}),
    };
    cases.push({
      id:raw.id,domain:raw.domain as AdminCase['domain'],
      quality:raw.quality as AdminCase['quality'],
      ...(typeof raw.scenario==='string'?{scenario:raw.scenario}:{}),
      ...(typeof raw.evaluation_role==='string'?{evaluation_role:raw.evaluation_role}:{}),
      task:t as Task,oracle,
    });
  }
  if(source==='paste') {
    if(cases.filter(c=>c.quality==='well_specified_control').length!==1)throw invalid();
  } else for(const domain of ['Software','Marketing','Sales']) {
    const entries=cases.filter(c=>c.domain===domain);
    if(entries.length!==4||entries.filter(c=>c.quality==='well_specified_control').length!==1)
      throw invalid();
  }
  return {
    source,dataset_id:input.dataset_id,schema_version:input.schema_version,
    status:input.status,cases,
  };
}
export async function loadAdminFixture(source:AdminSource, code:string, signal:AbortSignal):Promise<AdminFixture> {
  if(!code.trim())throw new ApiError('PREVIEW_AUTH_REQUIRED','Enter your private preview code to load test cases.',401);
  const url='/api/admin/test-cases?source='+encodeURIComponent(source);
  let response:Response;
  try {
    response=await fetch(url,{
      method:'GET',headers:{Authorization:'Bearer '+code.trim(),'X-Request-ID':newRequestId()},
      cache:'no-store',signal,
    });
  } catch {
    throw new ApiError(signal.aborted?'CANCELLED':'NETWORK_ERROR',
      signal.aborted?'Loading cancelled.':'Could not load test cases. Check network.',0);
  }
  if(!response.ok)throw new ApiError('FIXTURE_LOAD_FAILED',
    response.status===401?'Incorrect private preview code.':
      response.status===503?'Admin test station is disabled in this environment.':
        'Could not load the test cases.',response.status);
  let body:unknown;
  try{body=await response.json()}catch{throw new ApiError('INVALID_FIXTURE','Unreadable test fixture response.',response.status)}
  return parseAdminFixture(body,source);
}

/** Mirror the public paste-only form without changing the API schema. */
export function taskForAdminReview(item:AdminCase):Task {
  return item.task.title.trim() ? item.task : prepareReviewTask(item.task);
}
