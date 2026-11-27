import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pbkdf2Sync} from 'node:crypto';
import worker from '../worker/index.ts';
import {adminSession, issueAdminSession, checkPassword, adminConfigured} from '../worker/admin-auth.ts';

const PASSWORD='unit-test-only-strong-password-12345';
const SALT=Buffer.from('0102030405060708090a0b0c0d0e0f10','hex');
const HASH='pbkdf2-sha256$100000$'+SALT.toString('base64url')+'$'+pbkdf2Sync(PASSWORD,SALT,100000,32,'sha256').toString('base64url');
const SECRET=Buffer.alloc(32,27).toString('base64url');
const BASE='https://issuelint.example';
const PREVIEW='separate-public-preview-code-at-least-24-chars';
const index='<html><head><meta name="robots" content="index,follow,max-image-preview:large"/><link rel="canonical" href="https://issuelint.com/"/></head><body><div id="root"></div></body></html>';
function env(overrides={}){
  return {
    ADMIN_USERNAME:'admin',
    ADMIN_PASSWORD_HASH:HASH,
    ADMIN_SESSION_SECRET:SECRET,
    ADMIN_LOGIN_RATE_LIMIT:{async limit(){return {success:true};}},
    ANALYZE_ENABLED:'true',PREVIEW_TOKEN:PREVIEW,
    ASSETS:{async fetch(request){
      return new Response(new URL(request.url).pathname==='/index.html'?index:'public asset',{
        headers:{'Content-Type':'text/html; charset=utf-8'},
      });
    }},
    ...overrides,
  };
}
const cookie=(await issueAdminSession(env())).split(';')[0];
function req(path,init={}){return new Request(BASE+path,init);}
function post(path,data,extra={}){
  return req(path,{method:'POST',headers:{Origin:BASE,'Content-Type':'application/json',...extra},
    body:JSON.stringify(data)});
}
test('admin settings fail closed when credentials, password hash, signer or limiter missing',()=>{
  for(const overrides of [{ADMIN_USERNAME:''},{ADMIN_PASSWORD_HASH:''},{ADMIN_SESSION_SECRET:''},{ADMIN_LOGIN_RATE_LIMIT:undefined}])
    assert.equal(adminConfigured(env(overrides)),false);
  assert.equal(adminConfigured(env()),true);
  // This exact unsupported 600k hash used to pass Node tests but fail at Cloudflare runtime.
  assert.equal(adminConfigured(env({ADMIN_PASSWORD_HASH:HASH.replace('$100000
});
test('PBKDF2 verification requires correct password and username',async()=>{
  assert.equal(await checkPassword('admin',PASSWORD,env()),true);
  assert.equal(await checkPassword('admin','bad-password',env()),false);
  assert.equal(await checkPassword('other',PASSWORD,env()),false);
});
test('GET /admin serves login, not private SPA, until a signed session exists',async()=>{
  const login=await worker.fetch(req('/admin'),env());
  assert.equal(login.status,200);
  const html=await login.text();
  assert.match(html,/Admin sign in/);
  assert.doesNotMatch(html,/div id="root"/);
  assert.match(html,/name="robots" content="noindex,nofollow,noarchive"/);
  assert.equal(login.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  assert.equal(login.headers.get('Cache-Control'),'no-store, private');
  assert.equal(login.headers.get('X-Frame-Options'),'DENY');
  const publicPage=await worker.fetch(req('/'),env());
  assert.equal(await publicPage.text(),'public asset');
  const configuredOff=await worker.fetch(req('/admin'),env({ADMIN_PASSWORD_HASH:''}));
  assert.equal(configuredOff.status,503);
  assert.doesNotMatch(await configuredOff.text(),/div id="root"/);
});
test('correct login creates secure cookie, which grants dashboard HTML',async()=>{
  const res=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),env());
  assert.equal(res.status,200);
  assert.equal(res.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  const setCookie=res.headers.get('Set-Cookie')??'';
  assert.match(setCookie,/__Host-issuelint_admin=/);
  assert.match(setCookie,/HttpOnly/);
  assert.match(setCookie,/Secure/);
  assert.match(setCookie,/SameSite=Strict/);
  const value=setCookie.split(';')[0];
  assert.equal(await adminSession(req('/admin',{headers:{Cookie:value}}),env()),true);
  const page=await worker.fetch(req('/admin',{headers:{Cookie:value}}),env());
  assert.equal(page.status,200);
  const body=await page.text();
  assert.match(body,/div id="root"/);
  assert.match(body,/noindex,nofollow,noarchive/);
  assert.doesNotMatch(body,/rel="canonical" href="https:\/\/issuelint.com\//);
  assert.equal(page.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
});
test('wrong login cannot create cookie; anti-CSRF origin is required',async()=>{
  const wrong=await worker.fetch(post('/api/admin/login',{username:'admin',password:'not-correct'}),env());
  assert.equal(wrong.status,401);
  assert.equal(wrong.headers.get('Set-Cookie'),null);
  const noOrigin=await worker.fetch(req('/api/admin/login',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:PASSWORD})
  }),env());
  assert.equal(noOrigin.status,403);
  const crossOrigin=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD},{Origin:'https://evil.example'}),env());
  assert.equal(crossOrigin.status,403);
});
test('admin login rate limit rejects attempts before password hashing, even with correct creds',async()=>{
  const throttled=env({ADMIN_LOGIN_RATE_LIMIT:{async limit(){return {success:false};}}});
  const res=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),throttled);
  assert.equal(res.status,429);
  assert.equal(res.headers.get('Retry-After'),'60');
  const missing=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),env({ADMIN_LOGIN_RATE_LIMIT:undefined}));
  assert.equal(missing.status,503);
});
test('private benchmark data requires admin cookie, never the public preview bearer',async()=>{
  const url='/api/admin/test-cases?source=chatgpt';
  const none=await worker.fetch(req(url),env());assert.equal(none.status,401);
  const previewOnly=await worker.fetch(req(url,{headers:{Authorization:'Bearer '+PREVIEW}}),env());
  assert.equal(previewOnly.status,401);
  assert.doesNotMatch(await previewOnly.text(),/must_detect|SW-01/);
  const authorized=await worker.fetch(req(url,{headers:{Cookie:cookie}}),env());
  assert.equal(authorized.status,200);
  assert.equal((await authorized.json()).cases.length,12);
  assert.equal(authorized.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  const tampered=await worker.fetch(req(url,{headers:{Cookie:cookie+'x'}}),env());
  assert.equal(tampered.status,401);
  assert.equal(await adminSession(req('/admin',{headers:{Cookie:cookie}}),env({ADMIN_SESSION_SECRET:Buffer.alloc(32,13).toString('base64url')})),false);
});
test('admin session authorizes model route only for same-origin POST, with public bearer behavior unchanged',async()=>{
  const task={title:'Test task',description:'Do the thing',type:'General',domain:'Other',criteria:'',context:''};
  const validCookie={Cookie:cookie};
  const invalidOrigin=await worker.fetch(post('/api/analyze-v2',task,{...validCookie,Origin:'https://evil.example'}),env({GEMINI_API_KEY:'placeholder'}));
  assert.equal(invalidOrigin.status,401);
  const cookieNoOrigin=await worker.fetch(req('/api/analyze-v2',{method:'POST',headers:{...validCookie,'Content-Type':'application/json'},body:JSON.stringify(task)}),env({GEMINI_API_KEY:'placeholder'}));
  assert.equal(cookieNoOrigin.status,401);
  const bearerOnly=await worker.fetch(post('/api/analyze',task,{Authorization:'Bearer wrong'}),env());
  assert.equal(bearerOnly.status,401);
});
test('sign out clears cookie and noindex never leaks public semantics',async()=>{
  const logout=await worker.fetch(post('/api/admin/logout',{}),env());
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('Set-Cookie')??'',/Max-Age=0/);
  const cross=await worker.fetch(post('/api/admin/logout',{},{Origin:'https://evil.example'}),env());
  assert.equal(cross.status,403);
  const protectedReq=await worker.fetch(req('/api/admin/session',{headers:{Cookie:cookie}}),env());
  assert.equal(protectedReq.status,200);
  const anonymous=await worker.fetch(req('/api/admin/session'),env());
  assert.equal(anonymous.status,401);
});
, '$600000
});
test('PBKDF2 verification requires correct password and username',async()=>{
  assert.equal(await checkPassword('admin',PASSWORD,env()),true);
  assert.equal(await checkPassword('admin','bad-password',env()),false);
  assert.equal(await checkPassword('other',PASSWORD,env()),false);
});
test('GET /admin serves login, not private SPA, until a signed session exists',async()=>{
  const login=await worker.fetch(req('/admin'),env());
  assert.equal(login.status,200);
  const html=await login.text();
  assert.match(html,/Admin sign in/);
  assert.doesNotMatch(html,/div id="root"/);
  assert.match(html,/name="robots" content="noindex,nofollow,noarchive"/);
  assert.equal(login.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  assert.equal(login.headers.get('Cache-Control'),'no-store, private');
  assert.equal(login.headers.get('X-Frame-Options'),'DENY');
  const publicPage=await worker.fetch(req('/'),env());
  assert.equal(await publicPage.text(),'public asset');
  const configuredOff=await worker.fetch(req('/admin'),env({ADMIN_PASSWORD_HASH:''}));
  assert.equal(configuredOff.status,503);
  assert.doesNotMatch(await configuredOff.text(),/div id="root"/);
});
test('correct login creates secure cookie, which grants dashboard HTML',async()=>{
  const res=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),env());
  assert.equal(res.status,200);
  assert.equal(res.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  const setCookie=res.headers.get('Set-Cookie')??'';
  assert.match(setCookie,/__Host-issuelint_admin=/);
  assert.match(setCookie,/HttpOnly/);
  assert.match(setCookie,/Secure/);
  assert.match(setCookie,/SameSite=Strict/);
  const value=setCookie.split(';')[0];
  assert.equal(await adminSession(req('/admin',{headers:{Cookie:value}}),env()),true);
  const page=await worker.fetch(req('/admin',{headers:{Cookie:value}}),env());
  assert.equal(page.status,200);
  const body=await page.text();
  assert.match(body,/div id="root"/);
  assert.match(body,/noindex,nofollow,noarchive/);
  assert.doesNotMatch(body,/rel="canonical" href="https:\/\/issuelint.com\//);
  assert.equal(page.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
});
test('wrong login cannot create cookie; anti-CSRF origin is required',async()=>{
  const wrong=await worker.fetch(post('/api/admin/login',{username:'admin',password:'not-correct'}),env());
  assert.equal(wrong.status,401);
  assert.equal(wrong.headers.get('Set-Cookie'),null);
  const noOrigin=await worker.fetch(req('/api/admin/login',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:PASSWORD})
  }),env());
  assert.equal(noOrigin.status,403);
  const crossOrigin=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD},{Origin:'https://evil.example'}),env());
  assert.equal(crossOrigin.status,403);
});
test('admin login rate limit rejects attempts before password hashing, even with correct creds',async()=>{
  const throttled=env({ADMIN_LOGIN_RATE_LIMIT:{async limit(){return {success:false};}}});
  const res=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),throttled);
  assert.equal(res.status,429);
  assert.equal(res.headers.get('Retry-After'),'60');
  const missing=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),env({ADMIN_LOGIN_RATE_LIMIT:undefined}));
  assert.equal(missing.status,503);
});
test('private benchmark data requires admin cookie, never the public preview bearer',async()=>{
  const url='/api/admin/test-cases?source=chatgpt';
  const none=await worker.fetch(req(url),env());assert.equal(none.status,401);
  const previewOnly=await worker.fetch(req(url,{headers:{Authorization:'Bearer '+PREVIEW}}),env());
  assert.equal(previewOnly.status,401);
  assert.doesNotMatch(await previewOnly.text(),/must_detect|SW-01/);
  const authorized=await worker.fetch(req(url,{headers:{Cookie:cookie}}),env());
  assert.equal(authorized.status,200);
  assert.equal((await authorized.json()).cases.length,12);
  assert.equal(authorized.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  const tampered=await worker.fetch(req(url,{headers:{Cookie:cookie+'x'}}),env());
  assert.equal(tampered.status,401);
  assert.equal(await adminSession(req('/admin',{headers:{Cookie:cookie}}),env({ADMIN_SESSION_SECRET:Buffer.alloc(32,13).toString('base64url')})),false);
});
test('admin session authorizes model route only for same-origin POST, with public bearer behavior unchanged',async()=>{
  const task={title:'Test task',description:'Do the thing',type:'General',domain:'Other',criteria:'',context:''};
  const validCookie={Cookie:cookie};
  const invalidOrigin=await worker.fetch(post('/api/analyze-v2',task,{...validCookie,Origin:'https://evil.example'}),env({GEMINI_API_KEY:'placeholder'}));
  assert.equal(invalidOrigin.status,401);
  const cookieNoOrigin=await worker.fetch(req('/api/analyze-v2',{method:'POST',headers:{...validCookie,'Content-Type':'application/json'},body:JSON.stringify(task)}),env({GEMINI_API_KEY:'placeholder'}));
  assert.equal(cookieNoOrigin.status,401);
  const bearerOnly=await worker.fetch(post('/api/analyze',task,{Authorization:'Bearer wrong'}),env());
  assert.equal(bearerOnly.status,401);
});
test('sign out clears cookie and noindex never leaks public semantics',async()=>{
  const logout=await worker.fetch(post('/api/admin/logout',{}),env());
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('Set-Cookie')??'',/Max-Age=0/);
  const cross=await worker.fetch(post('/api/admin/logout',{},{Origin:'https://evil.example'}),env());
  assert.equal(cross.status,403);
  const protectedReq=await worker.fetch(req('/api/admin/session',{headers:{Cookie:cookie}}),env());
  assert.equal(protectedReq.status,200);
  const anonymous=await worker.fetch(req('/api/admin/session'),env());
  assert.equal(anonymous.status,401);
});
)})),false);
});
test('PBKDF2 verification requires correct password and username',async()=>{
  assert.equal(await checkPassword('admin',PASSWORD,env()),true);
  assert.equal(await checkPassword('admin','bad-password',env()),false);
  assert.equal(await checkPassword('other',PASSWORD,env()),false);
});
test('GET /admin serves login, not private SPA, until a signed session exists',async()=>{
  const login=await worker.fetch(req('/admin'),env());
  assert.equal(login.status,200);
  const html=await login.text();
  assert.match(html,/Admin sign in/);
  assert.doesNotMatch(html,/div id="root"/);
  assert.match(html,/name="robots" content="noindex,nofollow,noarchive"/);
  assert.equal(login.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  assert.equal(login.headers.get('Cache-Control'),'no-store, private');
  assert.equal(login.headers.get('X-Frame-Options'),'DENY');
  const publicPage=await worker.fetch(req('/'),env());
  assert.equal(await publicPage.text(),'public asset');
  const configuredOff=await worker.fetch(req('/admin'),env({ADMIN_PASSWORD_HASH:''}));
  assert.equal(configuredOff.status,503);
  assert.doesNotMatch(await configuredOff.text(),/div id="root"/);
});
test('correct login creates secure cookie, which grants dashboard HTML',async()=>{
  const res=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),env());
  assert.equal(res.status,200);
  assert.equal(res.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  const setCookie=res.headers.get('Set-Cookie')??'';
  assert.match(setCookie,/__Host-issuelint_admin=/);
  assert.match(setCookie,/HttpOnly/);
  assert.match(setCookie,/Secure/);
  assert.match(setCookie,/SameSite=Strict/);
  const value=setCookie.split(';')[0];
  assert.equal(await adminSession(req('/admin',{headers:{Cookie:value}}),env()),true);
  const page=await worker.fetch(req('/admin',{headers:{Cookie:value}}),env());
  assert.equal(page.status,200);
  const body=await page.text();
  assert.match(body,/div id="root"/);
  assert.match(body,/noindex,nofollow,noarchive/);
  assert.doesNotMatch(body,/rel="canonical" href="https:\/\/issuelint.com\//);
  assert.equal(page.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
});
test('wrong login cannot create cookie; anti-CSRF origin is required',async()=>{
  const wrong=await worker.fetch(post('/api/admin/login',{username:'admin',password:'not-correct'}),env());
  assert.equal(wrong.status,401);
  assert.equal(wrong.headers.get('Set-Cookie'),null);
  const noOrigin=await worker.fetch(req('/api/admin/login',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:PASSWORD})
  }),env());
  assert.equal(noOrigin.status,403);
  const crossOrigin=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD},{Origin:'https://evil.example'}),env());
  assert.equal(crossOrigin.status,403);
});
test('admin login rate limit rejects attempts before password hashing, even with correct creds',async()=>{
  const throttled=env({ADMIN_LOGIN_RATE_LIMIT:{async limit(){return {success:false};}}});
  const res=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),throttled);
  assert.equal(res.status,429);
  assert.equal(res.headers.get('Retry-After'),'60');
  const missing=await worker.fetch(post('/api/admin/login',{username:'admin',password:PASSWORD}),env({ADMIN_LOGIN_RATE_LIMIT:undefined}));
  assert.equal(missing.status,503);
});
test('private benchmark data requires admin cookie, never the public preview bearer',async()=>{
  const url='/api/admin/test-cases?source=chatgpt';
  const none=await worker.fetch(req(url),env());assert.equal(none.status,401);
  const previewOnly=await worker.fetch(req(url,{headers:{Authorization:'Bearer '+PREVIEW}}),env());
  assert.equal(previewOnly.status,401);
  assert.doesNotMatch(await previewOnly.text(),/must_detect|SW-01/);
  const authorized=await worker.fetch(req(url,{headers:{Cookie:cookie}}),env());
  assert.equal(authorized.status,200);
  assert.equal((await authorized.json()).cases.length,12);
  assert.equal(authorized.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  const tampered=await worker.fetch(req(url,{headers:{Cookie:cookie+'x'}}),env());
  assert.equal(tampered.status,401);
  assert.equal(await adminSession(req('/admin',{headers:{Cookie:cookie}}),env({ADMIN_SESSION_SECRET:Buffer.alloc(32,13).toString('base64url')})),false);
});
test('admin session authorizes model route only for same-origin POST, with public bearer behavior unchanged',async()=>{
  const task={title:'Test task',description:'Do the thing',type:'General',domain:'Other',criteria:'',context:''};
  const validCookie={Cookie:cookie};
  const invalidOrigin=await worker.fetch(post('/api/analyze-v2',task,{...validCookie,Origin:'https://evil.example'}),env({GEMINI_API_KEY:'placeholder'}));
  assert.equal(invalidOrigin.status,401);
  const cookieNoOrigin=await worker.fetch(req('/api/analyze-v2',{method:'POST',headers:{...validCookie,'Content-Type':'application/json'},body:JSON.stringify(task)}),env({GEMINI_API_KEY:'placeholder'}));
  assert.equal(cookieNoOrigin.status,401);
  const bearerOnly=await worker.fetch(post('/api/analyze',task,{Authorization:'Bearer wrong'}),env());
  assert.equal(bearerOnly.status,401);
});
test('sign out clears cookie and noindex never leaks public semantics',async()=>{
  const logout=await worker.fetch(post('/api/admin/logout',{}),env());
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('Set-Cookie')??'',/Max-Age=0/);
  const cross=await worker.fetch(post('/api/admin/logout',{},{Origin:'https://evil.example'}),env());
  assert.equal(cross.status,403);
  const protectedReq=await worker.fetch(req('/api/admin/session',{headers:{Cookie:cookie}}),env());
  assert.equal(protectedReq.status,200);
  const anonymous=await worker.fetch(req('/api/admin/session'),env());
  assert.equal(anonymous.status,401);
});
