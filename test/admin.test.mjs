import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../worker/index.ts';
import {parseTask} from '../worker/schema.ts';
import {loadAdminFixture,parseAdminFixture} from '../src/admin-data.ts';
import {issueAdminSession} from '../worker/admin-auth.ts';
import {pbkdf2Sync} from 'node:crypto';

const validCode='admin-preview-test-token-with-24-or-more-characters';
const password='test-admin-password-do-not-use-in-production';
const salt=Buffer.from('0102030405060708090a0b0c0d0e0f10','hex');
const adminHash='pbkdf2-sha256$100000$'+salt.toString('base64url')+'$'+pbkdf2Sync(password,salt,100000,32,'sha256').toString('base64url');
const sessionSecret=Buffer.alloc(32,23).toString('base64url');
function env(overrides={}){
  return {
    ASSETS:{async fetch(){return new Response('not-used')}},
    AI:{async run(){throw new Error('Test station fixture GET must not invoke any model');}},
    ANALYZE_ENABLED:'true',PREVIEW_TOKEN:validCode,
    ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:adminHash,ADMIN_SESSION_SECRET:sessionSecret,
    ADMIN_LOGIN_RATE_LIMIT:{async limit(){return {success:true};}},
    ...overrides,
  };
}
const cookie=(await issueAdminSession(env())).split(';')[0];
function request(source='chatgpt',method='GET',auth=cookie){
  return new Request('https://issuelint.example/api/admin/test-cases?source='+source,{
    method,headers:{Cookie:auth},
  });
}
test('admin fixture API is private and disabled when no private access is configured',async()=>{
  const none=await worker.fetch(request('chatgpt','GET',''),env());
  assert.equal(none.status,401);
  const wrong=await worker.fetch(request('chatgpt','GET','bad-preview-token'),env());
  assert.equal(wrong.status,401);
  const off=await worker.fetch(request('chatgpt','GET',cookie),env({ANALYZE_ENABLED:'false'}));
  assert.equal(off.status,503);
  const misconfigured=await worker.fetch(request('chatgpt','GET',cookie),env({ADMIN_SESSION_SECRET:''}));
  assert.equal(misconfigured.status,503);
  for(const response of [none,wrong,off,misconfigured]){
    const txt=await response.text();
    assert.doesNotMatch(txt,/SW-01|G-SW-01|must_detect|test-preview-token/i);
  }
});
test('admin fixture API is read-only and rejects unknown datasets',async()=>{
  const post=await worker.fetch(request('chatgpt','POST'),env());
  assert.equal(post.status,405);
  assert.equal(post.headers.get('Allow'),'GET');
  for(const source of ['unknown','chatgpt%26admin%3Dtrue','']){
    const res=await worker.fetch(request(source),env());
    assert.equal(res.status,400);
    assert.equal((await res.json()).error,'INVALID_SOURCE');
  }
});
test('admin API returns exactly 12 authentic ChatGPT tasks plus private author oracle',async()=>{
  const res=await worker.fetch(request('chatgpt'),env());
  assert.equal(res.status,200);
  assert.match(res.headers.get('content-type'),/application\/json/);
  assert.equal(res.headers.get('cache-control'),'no-store, private');
  assert.equal(res.headers.get('x-content-type-options'),'nosniff');
  const raw=await res.json();
  assert.equal(raw.source,'chatgpt');
  assert.equal(raw.dataset_id,'issuelint-cross-domain-control-v1');
  assert.equal(raw.cases.length,12);
  const c=parseAdminFixture(raw,'chatgpt');
  assert.equal(c.cases.filter(x=>x.quality==='well_specified_control').length,3);
  assert.equal(c.cases.find(x=>x.id==='SW-01').oracle.must_detect.length,3);
  for(const item of c.cases){
    const normalized=parseTask(item.task);
    assert.deepEqual(normalized,item.task);
    assert.equal('oracle' in normalized,false);
    assert.equal('quality' in normalized,false);
    assert.equal('expected_status' in normalized,false);
  }
});
test('admin API returns twelve reviewed Gemini-origin task payloads, no model call',async()=>{
  const res=await worker.fetch(request('gemini'),env());
  assert.equal(res.status,200);
  const raw=await res.json();
  const c=parseAdminFixture(raw,'gemini');
  assert.equal(c.dataset_id,'issuelint-gemini-independent-reviewed-v1');
  assert.equal(c.cases.length,12);
  assert.equal(c.cases.filter(x=>x.quality==='well_specified_control').length,3);
  assert.equal(c.cases.find(x=>x.id==='G-SW-01').oracle.expected_status,'blocked');
  assert.equal(c.cases.find(x=>x.id==='G-MK-02').oracle.expected_status,'blocked');
  for(const item of c.cases){
    assert.deepEqual(parseTask(item.task),item.task,item.id);
    assert.ok(!('oracle' in item.task),item.id);
    assert.ok(['Software','Marketing','Sales'].includes(item.domain),item.id);
  }
});
test('admin client validation rejects tampered dataset and concealed oracle in task',async()=>{
  const res=await worker.fetch(request('gemini'),env());
  const original=await res.json();
  const missing=structuredClone(original);
  missing.cases.pop();
  assert.throws(()=>parseAdminFixture(missing,'gemini'),/invalid shape/);
  const extra=structuredClone(original);
  extra.cases[0].task.description='';
  assert.throws(()=>parseAdminFixture(extra,'gemini'),/invalid shape/);
  const badDimension=structuredClone(original);
  badDimension.cases[0].oracle.must_detect[0].dimension='impossible_dimension';
  assert.throws(()=>parseAdminFixture(badDimension,'gemini'),/invalid shape/);
  assert.throws(()=>parseAdminFixture(original,'chatgpt'),/invalid shape/);
});
test('admin frontend loader uses session cookies, source filters and respects 401',async()=>{
  const saved=globalThis.fetch;
  const fixtureRes=await worker.fetch(request('chatgpt'),env());
  const contents=await fixtureRes.json();
  const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(contents),{status:200});};
  try {
    const result=await loadAdminFixture('chatgpt','',new AbortController().signal);
    assert.equal(result.cases.length,12);
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,'/api/admin/test-cases?source=chatgpt');
    assert.equal(calls[0].init.method,'GET');
    assert.equal('Authorization' in calls[0].init.headers,false);
    assert.equal(calls[0].init.credentials,'same-origin');
    assert.equal(calls[0].init.cache,'no-store');
  }finally{globalThis.fetch=saved;}
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'PREVIEW_AUTH_REQUIRED'}),{status:401});
  try{
    await assert.rejects(()=>loadAdminFixture('gemini','',new AbortController().signal),
      e=>e.code==='FIXTURE_LOAD_FAILED'&&e.status===401);
  }finally{globalThis.fetch=saved;}
});

test('four protected paste-only tasks have blank extra fields, but valid derived API titles',async()=>{
  const unauthorized=await worker.fetch(request('paste','GET',''),env());
  assert.equal(unauthorized.status,401);
  const result=await worker.fetch(request('paste'),env());
  assert.equal(result.status,200);
  const raw=await result.json();
  assert.equal(raw.cases.length,4);
  const {taskForAdminReview}=await import('../src/admin-data.ts');
  const fixture=parseAdminFixture(raw,'paste');
  assert.equal(fixture.cases.filter(x=>x.quality==='well_specified_control').length,1);
  for(const item of fixture.cases) {
    assert.equal(item.task.title,'');
    assert.equal(item.task.domain,'Other');
    assert.equal(item.task.type,'General');
    for(const k of ['criteria','context','scope','outcome','references']) assert.equal(item.task[k],'');
    const task=taskForAdminReview(item);
    assert.equal(task.title,item.task.description.trim().split(/\\r?\\n/).find(Boolean)?.slice(0,120));
    assert.deepEqual(parseTask(task),task);
    assert.equal('oracle' in task,false);
  }
  const injected=structuredClone(raw);
  injected.cases[0].task.context='Sneaky details';
  assert.throws(()=>parseAdminFixture(injected,'paste'),/invalid shape/);
  assert.throws(()=>parseAdminFixture(raw,'chatgpt'),/invalid shape/);
});
