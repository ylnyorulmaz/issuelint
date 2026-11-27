import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordCompletedLint, buildFeedbackPayload, sendFeedback, LINT_TOTAL_KEY,
  FEEDBACK_SEEN_KEY, SESSION_LINTS_KEY } from '../src/feedback.ts';
import { parseFeedbackEvent } from '../worker/feedback.ts';
import worker from '../worker/index.ts';

function store() {
  const data = new Map();
  return {
    getItem(k) { return data.get(k) ?? null; },
    setItem(k,v) { data.set(k,String(v)); },
    data,
  };
}
const sample = () => ({
  rating:'helpful', note:'More precise questions, please', sessionLintCount:2,
  timestamp:new Date().toISOString(),
});
const url='https://issuelint.example/api/feedback';
function env(overrides={}) {
  const keys=[];
  return {
    keys,
    ASSETS:{async fetch(){return new Response('public');}},
    FEEDBACK_RATE_LIMIT:{async limit({key}){keys.push(key);return {success:true};}},
    ...overrides,
  };
}
function request(payload=sample(),headerOverrides={},method='POST') {
  return new Request(url,{
    method,
    headers:{Origin:'https://issuelint.example','Content-Type':'application/json',...headerOverrides},
    ...(method==='POST'?{body:typeof payload==='string'?payload:JSON.stringify(payload)}:{}),
  });
}

test('one-time prompt appears only on second completed lint, persists across reloads',()=>{
  const local=store(),session=store();
  assert.deepEqual(recordCompletedLint(local,session),{showPrompt:false,sessionLintCount:1});
  assert.equal(local.data.get(LINT_TOTAL_KEY),'1');
  assert.equal(local.data.get(FEEDBACK_SEEN_KEY),undefined);
  assert.deepEqual(recordCompletedLint(local,session),{showPrompt:true,sessionLintCount:2});
  assert.equal(local.data.get(FEEDBACK_SEEN_KEY),'shown');
  assert.deepEqual(recordCompletedLint(local,session),{showPrompt:false,sessionLintCount:3});
  // Simulate reload in same tab and new tab: local persistent flag wins.
  assert.deepEqual(recordCompletedLint(local,session),{showPrompt:false,sessionLintCount:4});
  assert.deepEqual(recordCompletedLint(local,store()),{showPrompt:false,sessionLintCount:1});
  assert.equal(local.data.get(LINT_TOTAL_KEY),'5');
  assert.equal(session.data.get(SESSION_LINTS_KEY),'4');
});
test('a second lint across sessions still triggers once, without invalid session count',()=>{
  const local=store();
  assert.equal(recordCompletedLint(local,store()).showPrompt,false);
  assert.deepEqual(recordCompletedLint(local,store()),{showPrompt:true,sessionLintCount:1});
});
test('broken or unavailable persistent storage fails closed, without repeated nagging',()=>{
  assert.deepEqual(recordCompletedLint(null,store()),{showPrompt:false,sessionLintCount:0});
  const failing={getItem(){throw Error('denied');},setItem(){throw Error('denied');}};
  assert.deepEqual(recordCompletedLint(failing,store()),{showPrompt:false,sessionLintCount:0});
  const local=store();
  local.setItem(LINT_TOTAL_KEY,'garbage');
  assert.equal(recordCompletedLint(local,store()).showPrompt,false);
});
test('only exact four allowed fields are constructed, with optional trimmed note',()=>{
  const at=new Date();
  const withoutNote=buildFeedbackPayload('meh','   ',2,at);
  assert.deepEqual(withoutNote,{rating:'meh',sessionLintCount:2,timestamp:at.toISOString()});
  const note=buildFeedbackPayload('broken','  It froze  ',3,at);
  assert.deepEqual(note,{rating:'broken',note:'It froze',sessionLintCount:3,timestamp:at.toISOString()});
  assert.deepEqual(Object.keys(note).sort(),['rating','note','sessionLintCount','timestamp'].sort());
  assert.throws(()=>buildFeedbackPayload('invalid','',2));
  assert.throws(()=>buildFeedbackPayload('helpful','x'.repeat(241),2));
  assert.throws(()=>buildFeedbackPayload('helpful','',0));
});
test('browser send never includes task, IP, auth token or credentials',async()=>{
  const oldFetch=globalThis.fetch;
  const captures=[];
  globalThis.fetch=async(path,init)=>{captures.push({path,init});return new Response('{"ok":true}',{status:202});};
  try {
    await sendFeedback(buildFeedbackPayload('helpful','Good',2));
    assert.equal(captures.length,1);
    assert.equal(captures[0].path,'/api/feedback');
    assert.equal(captures[0].init.method,'POST');
    assert.equal(captures[0].init.credentials,'omit');
    assert.equal(captures[0].init.referrerPolicy,'no-referrer');
    assert.equal('Authorization' in captures[0].init.headers,false);
    assert.deepEqual(Object.keys(JSON.parse(captures[0].init.body)).sort(),
      ['rating','note','sessionLintCount','timestamp'].sort());
    assert.doesNotMatch(captures[0].init.body,/description|ticket|ipAddress|PREVIEW_TOKEN/);
  } finally {globalThis.fetch=oldFetch;}
});
test('worker accepts feedback and logs only allowlisted fields, never request IP',async()=>{
  const saved=console.info;
  const calls=[];
  console.info=(...args)=>calls.push(args);
  const e=env();
  try {
    const r=await worker.fetch(request(sample(),{'CF-Connecting-IP':'203.0.113.8'}),e);
    assert.equal(r.status,202);
    assert.deepEqual(await r.json(),{ok:true});
    assert.equal(r.headers.get('Cache-Control'),'no-store');
    assert.deepEqual(e.keys,['feedback-global']);
    assert.equal(calls.length,1);
    assert.equal(calls[0][0],'issuelint.user_feedback');
    assert.deepEqual(Object.keys(calls[0][1]).sort(),['rating','note','sessionLintCount','timestamp'].sort());
    assert.equal(calls[0][1].rating,'helpful');
    assert.equal(calls[0][1].note,'More precise questions, please');
    assert.doesNotMatch(JSON.stringify(calls),/203\.0\.113\.8|task|description|ipAddress/i);
  } finally {console.info=saved;}
});
test('server rejects extra fields including raw task text and address',async()=>{
  for(const extra of [
    {task:'secret client ticket'},{description:'secret ticket body'},
    {ip:'203.0.113.8'},{email:'person@example.com'},{previewCode:'hidden'}
  ]){
    const r=await worker.fetch(request({...sample(),...extra}),env());
    assert.equal(r.status,422);
  }
  assert.equal(parseFeedbackEvent({...sample(),note:'\u0000bad'}),null);
  assert.equal(parseFeedbackEvent({...sample(),rating:'good'}),null);
  assert.equal(parseFeedbackEvent({...sample(),sessionLintCount:0}),null);
  assert.equal(parseFeedbackEvent({...sample(),note:'x'.repeat(241)}),null);
  assert.equal(parseFeedbackEvent({...sample(),timestamp:'tomorrow'}),null);
});
test('public endpoint enforces same-origin POST, JSON, byte cap and global rate limit',async()=>{
  const none=await worker.fetch(new Request(url),env());
  assert.equal(none.status,405);
  assert.equal(none.headers.get('Allow'),'POST');
  const cross=await worker.fetch(request(sample(),{Origin:'https://external.test'}),env());
  assert.equal(cross.status,403);
  const missingOrigin=new Request(url,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sample()),
  });
  assert.equal((await worker.fetch(missingOrigin,env())).status,403);
  assert.equal((await worker.fetch(request(sample(),{'Content-Type':'text/plain'}),env())).status,415);
  assert.equal((await worker.fetch(request('{broken json'),env())).status,422);
  assert.equal((await worker.fetch(request('x'.repeat(2000)),env())).status,422);
  assert.equal((await worker.fetch(request(sample()),env({FEEDBACK_RATE_LIMIT:undefined}))).status,503);
  const limited=await worker.fetch(request(sample()),env({FEEDBACK_RATE_LIMIT:{async limit(){return {success:false};}}}));
  assert.equal(limited.status,429);
  assert.equal(limited.headers.get('Retry-After'),'60');
});
test('UI hooks completion in all four success paths, not in error handlers',async()=>{
  const {readFile}=await import('node:fs/promises');
  const [app,card,css]=await Promise.all([
    readFile(new URL('../src/index.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/components/FeedbackPrompt.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/styles.feedback.css',import.meta.url),'utf8'),
  ]);
  assert.equal((app.match(/onLintCompleted\(\);/g)||[]).length,4);
  assert.match(app,/setQuickResult\(scan\);\s*onLintCompleted\(\)/);
  assert.match(app,/setDecisionResult\(decision\);\s*onLintCompleted\(\)/);
  assert.match(app,/setResult\(fromLive\(output\)\);\s*onLintCompleted\(\)/);
  assert.match(app,/setResult\(fromDemo\(prepareReviewTask\(task\(\)\)\)\);\s*onLintCompleted\(\)/);
  assert.match(app,/<FeedbackPrompt sessionLintCount=\{feedbackLintCount\(\)!\}/);
  assert.match(card,/role="group" aria-label="Rate your lint"/);
  assert.match(card,/aria-label="Skip feedback"/);
  assert.match(card,/What was missing or broke\?/);
  assert.match(card,/Thanks for the feedback/);
  assert.match(css,/var\(--soft\)/);
});
