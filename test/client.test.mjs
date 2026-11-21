import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeLive, analyzeDecisionLive, ApiError, getHealth } from '../src/api.ts';

const validTask = { title:'Check sales task', description:'Contact qualified leads on Friday.', type:'General', domain:'Sales', criteria:'', context:'' };
const analysis = { status:'ready', summary:'Clear task', findings:[], suggestedRewrite:'Contact qualified leads on Friday.', rewriteStatus:'rewritten' };
const originalFetch = globalThis.fetch;

test('health distinguishes demo and private preview mode', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({status:'ok',aiBindingConfigured:true,aiEnabled:false}), {status:200});
  try { const data = await getHealth(); assert.equal(data.aiEnabled, false); }
  finally { globalThis.fetch = originalFetch; }
});

test('live review submits the exact task and code, validates response', async () => {
  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = options;
    return new Response(JSON.stringify({mode:'ai', analyzed:true, analysis}), {status:200});
  };
  try {
    const result = await analyzeLive(validTask, 'preview-code', new AbortController().signal);
    assert.equal(result.status, 'ready');
    assert.deepEqual(JSON.parse(captured.body), validTask);
    assert.equal(captured.headers.Authorization, 'Bearer preview-code');
  } finally { globalThis.fetch = originalFetch; }
});

test('private preview returns helpful access error', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({error:'PREVIEW_AUTH_REQUIRED',message:'Access required'}), {status:401});
  try { await assert.rejects(() => analyzeLive(validTask,'invalid',new AbortController().signal), e => e instanceof ApiError && /access code/.test(e.message)); }
  finally { globalThis.fetch = originalFetch; }
});

test('never renders fabricated successful response', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({mode:'stub',analyzed:false,findings:[]}),{status:200});
  try { await assert.rejects(() => analyzeLive(validTask,'token',new AbortController().signal), e => e instanceof ApiError && e.code === 'INVALID_RESPONSE'); }
  finally { globalThis.fetch = originalFetch; }
});

import { DEFAULT_DESIGN_THEME, DESIGN_THEME_STORAGE_KEY, normalizeDesignTheme, readDesignTheme, saveDesignTheme } from '../src/design-theme.ts';

test('Minimalist is the default, including unknown preferences', () => {
  assert.equal(DEFAULT_DESIGN_THEME, 'minimalist');
  assert.equal(normalizeDesignTheme(null), 'minimalist');
  assert.equal(normalizeDesignTheme('not-a-design'), 'minimalist');
  assert.equal(normalizeDesignTheme('neobrutalist'), 'neobrutalist');
  assert.equal(normalizeDesignTheme('minimalist'), 'minimalist');
  assert.equal(normalizeDesignTheme('constructivist'), 'constructivist');
});

test('design theme preference survives a reload via storage', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readDesignTheme(storage), 'minimalist');
  saveDesignTheme('neobrutalist', storage);
  assert.equal(values.get(DESIGN_THEME_STORAGE_KEY), 'neobrutalist');
  assert.equal(readDesignTheme(storage), 'neobrutalist');
  saveDesignTheme('minimalist', storage);
  assert.equal(readDesignTheme(storage), 'minimalist');
  saveDesignTheme('constructivist', storage);
  assert.equal(readDesignTheme(storage), 'constructivist');
  assert.equal(values.size, 1);
});

test('blocked or unavailable localStorage does not break the analyzer', () => {
  const inaccessible = {
    getItem: () => { throw Error('Blocked'); },
    setItem: () => { throw Error('Blocked'); },
  };
  assert.equal(readDesignTheme(inaccessible), 'minimalist');
  assert.doesNotThrow(() => saveDesignTheme('neobrutalist', inaccessible));
  assert.equal(readDesignTheme(), 'minimalist');
});

import { APPEARANCE_STORAGE_KEY, readAppearance, saveAppearance } from '../src/appearance.ts';

test('appearance defaults to OS Light/Dark and ignores old visual-theme preferences',()=>{
  const values=new Map([['issuelint.design-theme.v2','neobrutalist']]);
  const storage={
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,value),
  };
  assert.equal(readAppearance(storage,false),'light');
  assert.equal(readAppearance(storage,true),'dark');
  assert.equal(values.get('issuelint.design-theme.v2'),'neobrutalist');
  saveAppearance('light',storage);
  assert.equal(readAppearance(storage,true),'light');
  saveAppearance('dark',storage);
  assert.equal(readAppearance(storage,false),'dark');
  assert.equal(values.get(APPEARANCE_STORAGE_KEY),'dark');
  assert.equal(values.get('issuelint.design-theme.v2'),'neobrutalist');
});

test('appearance survives reload and works when browser storage is unavailable',()=>{
  const values=new Map();
  const storage={
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,value),
  };
  saveAppearance('dark',storage);
  assert.equal(readAppearance(storage,false),'dark');
  saveAppearance('light',storage);
  assert.equal(readAppearance(storage,true),'light');
  assert.deepEqual([...values.keys()],[APPEARANCE_STORAGE_KEY]);
  const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.equal(readAppearance(blocked,true),'dark');
  assert.equal(readAppearance(blocked,false),'light');
  assert.doesNotThrow(()=>saveAppearance('dark',blocked));
  assert.equal(readAppearance(undefined,false),'light');
});

test('default Light/Dark picker UI does not expose retired design modes',async()=>{
  const {readFile}=await import('node:fs/promises');
  const [home,admin]=await Promise.all([
    readFile(new URL('../src/index.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/components/AdminStation.tsx',import.meta.url),'utf8'),
  ]);
  for(const src of [home,admin]){
    assert.match(src,/data-design="minimalist"/);
    assert.match(src,/class="appearance-switcher"/);
    assert.match(src,/aria-pressed/);
    assert.match(src,/chooseAppearance\('light'\)/);
    assert.match(src,/chooseAppearance\('dark'\)/);
    assert.doesNotMatch(src,/class="design-switcher"/);
  }
  const archived=await readFile(new URL('../src/styles.neobrutalist.css',import.meta.url),'utf8');
  assert.ok(archived.length>1000);
  const legacy=await readFile(new URL('../src/design-theme.ts',import.meta.url),'utf8');
  assert.match(legacy,/constructivist.*neobrutalist.*minimalist/);
});

test('clarification-only draft is labeled instead of silently presented as improved copy', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ mode:'ai', analyzed:true, analysis:{
    ...analysis, rewriteStatus:'clarification_draft',
    suggestedRewrite:'Contact qualified leads on Friday. Open questions: Which leads qualify?'
  }}), {status:200});
  try {
    const result = await analyzeLive(validTask,'preview-code',new AbortController().signal);
    assert.equal(result.rewriteStatus,'clarification_draft');
    assert.match(result.suggestedRewrite, /Open questions/);
  } finally { globalThis.fetch = originalFetch; }
});

test('server may explicitly mark a rewrite as unavailable', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({mode:'ai', analyzed:true, analysis:{
    ...analysis, rewriteStatus:'unavailable', suggestedRewrite:''
  }}), {status:200});
  try {
    const result = await analyzeLive(validTask,'preview-code',new AbortController().signal);
    assert.equal(result.rewriteStatus,'unavailable');
    assert.equal(result.suggestedRewrite,'');
  } finally { globalThis.fetch = originalFetch; }
});

import { PREVIEW_ACCESS_STORAGE_KEY, readRememberedPreviewCode, rememberPreviewCode, forgetPreviewCode } from '../src/preview-access.ts';

test('preview code is prefilled on the same browser after manual entry, and can be forgotten', () => {
  const saved = new Map();
  const storage = {
    getItem: k => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, v),
    removeItem: k => saved.delete(k),
  };
  assert.equal(readRememberedPreviewCode(storage), '');
  rememberPreviewCode('  private-test-access-code-1234567890  ', storage);
  assert.equal(saved.get(PREVIEW_ACCESS_STORAGE_KEY), 'private-test-access-code-1234567890');
  assert.equal(readRememberedPreviewCode(storage), 'private-test-access-code-1234567890');
  forgetPreviewCode(storage);
  assert.equal(readRememberedPreviewCode(storage), '');
});

test('preview storage handles disabled storage, blank and oversized inputs without leaking secrets', () => {
  const blocked = {
    getItem: () => { throw Error('disabled'); },
    setItem: () => { throw Error('disabled'); },
    removeItem: () => { throw Error('disabled'); },
  };
  assert.equal(readRememberedPreviewCode(blocked), '');
  assert.doesNotThrow(() => rememberPreviewCode('token-123456789012345678901234', blocked));
  assert.doesNotThrow(() => forgetPreviewCode(blocked));
  const values = new Map();
  const storage = {
    getItem: k => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: k => values.delete(k),
  };
  rememberPreviewCode('example-valid-preview-token-12345678', storage);
  rememberPreviewCode(' '.repeat(3), storage);
  assert.equal(readRememberedPreviewCode(storage), '');
  rememberPreviewCode('x'.repeat(257), storage);
  assert.equal(readRememberedPreviewCode(storage), '');
  storage.setItem(PREVIEW_ACCESS_STORAGE_KEY, 'x'.repeat(257));
  assert.equal(readRememberedPreviewCode(storage), '');
});


import { reportClientFailure, safeRequestId, newRequestId } from '../src/diagnostics.ts';

test('browser diagnostics send only allowlisted metadata with the current correlation id', async () => {
  const previousFetch=globalThis.fetch;
  const previousWarn=console.warn;
  const logs=[];
  let capture;
  globalThis.fetch=async (url,init)=>{capture={url,init};return new Response(JSON.stringify({ok:true}),{status:200});};
  console.warn=(...args)=>logs.push(args);
  const secret='test-private-preview-secret-not-for-logging';
  try {
    assert.match(newRequestId(),/^[a-zA-Z0-9_-]{8,64}$/);
    assert.equal(safeRequestId('request-12345'),'request-12345');
    assert.equal(safeRequestId('bad token\n'),undefined);
    reportClientFailure('review_failed','http',secret,'frontend-error-001',502,442.7);
    assert.equal(capture.url,'/api/client-events');
    assert.equal(capture.init.headers.Authorization,'Bearer '+secret);
    assert.equal(capture.init.headers['X-Request-ID'],'frontend-error-001');
    assert.deepEqual(JSON.parse(capture.init.body),{
      event:'review_failed',category:'http',status:502,durationMs:443,
    });
    assert.doesNotMatch(JSON.stringify(logs),/test-private-preview-secret-not-for-logging/);
  }finally{globalThis.fetch=previousFetch;console.warn=previousWarn;}
});

test('client errors preserve the server correlation id without displaying the bearer code', async () => {
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'AI_UNAVAILABLE',message:'down'}),{
    status:502,headers:{'X-Request-ID':'server-trace-001'}
  });
  try {
    await assert.rejects(
      ()=>analyzeLive(validTask,'another-secret-private-code',new AbortController().signal,'frontend-trace-001'),
      e=>e instanceof ApiError && e.status===502 && e.requestId==='server-trace-001' &&
        !e.message.includes('another-secret-private-code'),
    );
  }finally{globalThis.fetch=previousFetch;}
});


test('Decision v2 frontend sends task to separate endpoint and validates eleven gate responses',async()=>{
  const previousFetch=globalThis.fetch;
  const dimensions=['contradictions','actionability','scope','granularity','behavior',
    'completion','outcome','references','dependencies','clarity','feasibility'];
  let captured;
  globalThis.fetch=async(url,init)=>{
    captured={url,init};
    return new Response(JSON.stringify({mode:'decision',analyzed:true,decision:{
      model:'gemini-decision-1',checked:11,durationMs:310,
      gates:dimensions.map(dimension=>({dimension,assessment:dimension==='scope'?'gap':'clear',
        confidence:dimension==='scope'?.87:.9,
        probabilities:dimension==='scope'?
          {clear:.1,gap:.87,not_applicable:.03} : {clear:.9,gap:.07,not_applicable:.03}})),
      audit:{
        status:'complete',model:'@cf/openai/gpt-oss-120b',threshold:.85,
        selected:['scope'],unverified:[],durationMs:720,
        checks:[{dimension:'scope',assessment:'clear',
          reason:'The task specifies a single, coherent set of changes to review.',
          kind:'suggestion',severity:'suggestion',title:'',evidence:[],question:''}],
        findings:[]
      }
    }}),{status:200,headers:{'X-Request-ID':'decision-test-001'}});
  };
  try {
    const out=await analyzeDecisionLive(validTask,'private-preview-code',new AbortController().signal,'decision-test-001');
    assert.equal(captured.url,'/api/analyze-v2');
    assert.equal(captured.init.headers.Authorization,'Bearer private-preview-code');
    assert.equal(captured.init.headers['X-Request-ID'],'decision-test-001');
    assert.equal(out.checked,11);
    assert.equal(out.gates.find(g=>g.dimension==='scope').assessment,'gap');
    assert.equal(out.audit.checks[0].assessment,'clear');
    assert.deepEqual(out.audit.selected,['scope']);
  }finally{globalThis.fetch=previousFetch;}
});

test('Decision v2 frontend rejects missing or malformed gates and does not fabricate results',async()=>{
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({mode:'decision',analyzed:true,decision:{
    model:'gemini-decision-1',checked:11,durationMs:20,gates:[]
  }}),{status:200});
  try {
    await assert.rejects(
      ()=>analyzeDecisionLive(validTask,'code',new AbortController().signal),
      e=>e instanceof ApiError&&e.code==='INVALID_RESPONSE');
  }finally{globalThis.fetch=previousFetch;}
});

test('Decision v2 shows actionable configuration error while health keeps V1 available',async()=>{
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'DECISION_NOT_CONFIGURED'}),{status:503});
  try {
    await assert.rejects(()=>analyzeDecisionLive(validTask,'code',new AbortController().signal),
      e=>e instanceof ApiError&&e.code==='DECISION_NOT_CONFIGURED'&&/GEMINI_API_KEY/.test(e.message));
  }finally{globalThis.fetch=previousFetch;}
});


test('Decision client rejects missing reviewer state and mismatched routing rather than hiding the failure',async()=>{
  const saved=globalThis.fetch;
  const dimensions=['contradictions','actionability','scope','granularity','behavior',
    'completion','outcome','references','dependencies','clarity','feasibility'];
  const base={
    mode:'decision',analyzed:true,decision:{
      model:'gemini-decision-1',checked:11,durationMs:100,
      gates:dimensions.map(dimension=>({dimension,assessment:'clear',confidence:.9,
        probabilities:{clear:.9,gap:.08,not_applicable:.02}})),
    },
  };
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify(base),{status:200});
    await assert.rejects(()=>analyzeDecisionLive(validTask,'token',new AbortController().signal),
      e=>e instanceof ApiError&&e.code==='INVALID_RESPONSE');
    const mismatch=structuredClone(base);
    mismatch.decision.audit={
      status:'complete',model:'@cf/openai/gpt-oss-120b',threshold:.85,
      selected:['scope'],unverified:[],checks:[],findings:[],durationMs:4,
    };
    globalThis.fetch=async()=>new Response(JSON.stringify(mismatch),{status:200});
    await assert.rejects(()=>analyzeDecisionLive(validTask,'token',new AbortController().signal),
      e=>e instanceof ApiError&&e.code==='INVALID_RESPONSE');
  }finally{globalThis.fetch=saved;}
});

test('Decision client preserves unavailable audit warning without inventing reviewer results',async()=>{
  const saved=globalThis.fetch;
  const dimensions=['contradictions','actionability','scope','granularity','behavior',
    'completion','outcome','references','dependencies','clarity','feasibility'];
  globalThis.fetch=async()=>new Response(JSON.stringify({mode:'decision',analyzed:true,decision:{
    model:'gemini-decision-1',checked:11,durationMs:100,
    gates:dimensions.map(dimension=>({
      dimension,assessment:'clear',confidence:dimension==='scope'?.82:.9,
      probabilities:dimension==='scope'?
        {clear:.82,gap:.15,not_applicable:.03}:{clear:.9,gap:.08,not_applicable:.02},
    })),
    audit:{status:'unavailable',model:'@cf/openai/gpt-oss-120b',threshold:.85,
      selected:['scope'],unverified:['scope'],checks:[],findings:[],durationMs:120,errorCategory:'upstream'},
  }}),{status:200});
  try {
    const result=await analyzeDecisionLive(validTask,'token',new AbortController().signal);
    assert.equal(result.audit.status,'unavailable');
    assert.deepEqual(result.audit.selected,['scope']);
    assert.deepEqual(result.audit.findings,[]);
  }finally{globalThis.fetch=saved;}
});


test('Decision client accepts source-validated partial audit and highlights unverified gates',async()=>{
  const saved=globalThis.fetch;
  const dims=['contradictions','actionability','scope','granularity','behavior',
    'completion','outcome','references','dependencies','clarity','feasibility'];
  const response={mode:'decision',analyzed:true,decision:{
    model:'gemini-decision-1',checked:11,durationMs:210,
    gates:dims.map(dimension=>({dimension,assessment:'clear',confidence:.9,
      probabilities:['scope','behavior'].includes(dimension)?
        {clear:.6,gap:.35,not_applicable:.05}:{clear:.9,gap:.08,not_applicable:.02}})),
    audit:{status:'partial',model:'@cf/openai/gpt-oss-120b',threshold:.85,
      selected:['scope','behavior'],unverified:['scope'],durationMs:18000,
      checks:[{dimension:'behavior',assessment:'gap',reason:'The theme preference is not specified for the requested feature.',severity:'important',kind:'ambiguity',title:'Unspecified dark mode activation',
        evidence:['dark mode on web and mobile'],question:'Should dark mode follow the system preference?'}],
      findings:[{kind:'ambiguity',severity:'important',title:'Unspecified dark mode activation',
        detail:'The theme preference is not specified for the requested feature.',
        evidence:['dark mode on web and mobile'],question:'Should dark mode follow the system preference?'}]
    }
  }};
  globalThis.fetch=async()=>new Response(JSON.stringify(response),{status:200});
  try {
    const out=await analyzeDecisionLive(validTask,'token',new AbortController().signal);
    assert.equal(out.audit.status,'partial');
    assert.deepEqual(out.audit.unverified,['scope']);
    assert.deepEqual(out.audit.checks.map(c=>c.dimension),['behavior']);
    assert.equal(out.audit.findings.length,1);
  }finally {globalThis.fetch=saved;}
});

test('Decision client rejects partial audit with secretly omitted dimensions',async()=>{
  const saved=globalThis.fetch;
  const dims=['contradictions','actionability','scope','granularity','behavior',
    'completion','outcome','references','dependencies','clarity','feasibility'];
  globalThis.fetch=async()=>new Response(JSON.stringify({mode:'decision',analyzed:true,decision:{
    model:'gemini-decision-1',checked:11,durationMs:100,
    gates:dims.map(dimension=>({dimension,assessment:'clear',confidence:.9,
      probabilities:dimension==='scope'?{clear:.6,gap:.35,not_applicable:.05}:{clear:.9,gap:.08,not_applicable:.02}})),
    audit:{status:'partial',model:'@cf/openai/gpt-oss-120b',threshold:.85,
      selected:['scope'],unverified:[],checks:[],findings:[],durationMs:10}
  }}),{status:200});
  try{
    await assert.rejects(()=>analyzeDecisionLive(validTask,'token',new AbortController().signal),
      e=>e instanceof ApiError&&e.code==='INVALID_RESPONSE');
  }finally{globalThis.fetch=saved;}
});


test("supplied IssueLint artwork is present in both appearance modes", async () => {
  const { readFile } = await import("node:fs/promises");
  const home = await readFile(new URL("../src/index.tsx", import.meta.url), "utf8");
  const admin = await readFile(new URL("../src/components/AdminStation.tsx", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const component of [home, admin]) {
    assert.match(component, /\/brand\/logo-light\.webp/);
    assert.match(component, /\/brand\/logo-dark\.webp/);
    assert.match(component, /class="brand-logo"/);
  }
  assert.match(html, /\/brand\/favicon\.png/);
  for (const asset of ["logo-light.webp", "logo-dark.webp", "icon-light.webp", "icon-dark.webp", "favicon.png"]) {
    const bytes = await readFile(new URL("../public/brand/" + asset, import.meta.url));
    assert.ok(bytes.byteLength > 500, asset + " must not be empty");
  }
});

import { presentDecisionGate } from '../src/decision-presentation.ts';

test('compact status uses audited GPT-OSS verdict over Gemini score',()=>{
  const g=(p,assessment='clear')=>({dimension:'scope',assessment,confidence:p,probabilities:{clear:p,gap:1-p,not_applicable:0}});
  const a={threshold:.85,selected:['scope'],checks:[],status:'complete',unverified:[],findings:[],durationMs:5,model:'@cf/openai/gpt-oss-120b'};
  const check=assessment=>({dimension:'scope',assessment,reason:'test',title:'',question:'',evidence:[],severity:'suggestion',kind:'suggestion'});
  assert.deepEqual(presentDecisionGate(g(.52),{...a,checks:[check('clear')]}),{mark:'pass',source:'gpt-oss'});
  assert.deepEqual(presentDecisionGate(g(.63,'gap'),{...a,checks:[check('gap')]}),{mark:'issue',source:'gpt-oss'});
  assert.deepEqual(presentDecisionGate(g(.52),a),{mark:'unverified',source:'unverified'});
  assert.deepEqual(presentDecisionGate(g(.9),{...a,selected:[]}),{mark:'pass',source:'gemini'});
  assert.deepEqual(presentDecisionGate(g(.2,'not_applicable'),{...a,checks:[check('not_applicable')]}),{mark:'not_applicable',source:'gpt-oss'});
});

test('paste-first form exposes title outside extra details, keeps both modes optional',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../src/index.tsx',import.meta.url),'utf8');
  const paste=source.slice(source.indexOf('<Show when={entryMode() === \'paste\'} fallback='),source.indexOf('<div class="counter"'));
  assert.match(paste,/Task, ticket, to-do or brief title/);
  assert.match(paste,/placeholder="Optional — first line used if left blank"/);
  assert.equal((paste.match(/<input id="title"/g)||[]).length,2,'one visible title per mode');
  const expanded=source.slice(source.indexOf('<Show when={details()}>'),source.indexOf('class="privacy-note"'));
  assert.doesNotMatch(expanded,/<input id="title"/);
  assert.match(source,/Add type, area or context \(optional\)/);
});

test('Decision scorecard provides a keyboard-accessible explanatory tooltip',async()=>{
  const {readFile}=await import('node:fs/promises');
  const component=await readFile(new URL('../src/components/DecisionScorecard.tsx',import.meta.url),'utf8');
  const css=await readFile(new URL('../src/styles.decision-compact.css',import.meta.url),'utf8');
  assert.match(component,/class="decision-score-help"/);
  assert.match(component,/<summary aria-label="Explain percentages and status icons"/);
  assert.match(component,/Gemini's P\(Clear\), not a task grade/);
  assert.match(component,/GPT-OSS reviews independently/);
  assert.match(css,/\.decision-score-help > summary:focus-visible/);
});

import { analyzeQuickScanLive } from '../src/api.ts';

test('Quick Scan transport validates the exact Gemini-only checklist',async()=>{
  const dimensions=['contradictions','actionability','scope','granularity','behavior','completion',
    'outcome','references','dependencies','clarity','feasibility'];
  const scan={mode:'quick_scan',analyzed:true,scan:{model:'gemini-decision-1',checked:11,
    durationMs:200,gates:dimensions.map((dimension,i)=>({dimension,assessment:i===0?'gap':i===1?'not_applicable':'clear'}))}};
  const old=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async(url,opts)=>{
    calls++;
    assert.equal(url,'/api/quick-scan');
    assert.equal(opts.headers.Authorization,'Bearer test-preview');
    assert.deepEqual(JSON.parse(opts.body),validTask);
    return new Response(JSON.stringify(scan),{status:200});
  };
  try{
    const result=await analyzeQuickScanLive(validTask,'test-preview',new AbortController().signal);
    assert.equal(result.gates.length,11);
    assert.equal(result.gates[0].assessment,'gap');
    assert.equal(calls,1);
    const invalid=structuredClone(scan);
    invalid.scan.gates[2].dimension='contradictions';
    globalThis.fetch=async()=>new Response(JSON.stringify(invalid),{status:200});
    await assert.rejects(()=>analyzeQuickScanLive(validTask,'test-preview',new AbortController().signal),
      e=>e instanceof ApiError&&e.code==='INVALID_RESPONSE');
    const noAudit=structuredClone(scan);
    noAudit.scan.gates[0].probabilities={clear:.1,gap:.9,not_applicable:0};
    globalThis.fetch=async()=>new Response(JSON.stringify(noAudit),{status:200});
    await assert.rejects(()=>analyzeQuickScanLive(validTask,'test-preview',new AbortController().signal),
      e=>e instanceof ApiError&&e.code==='INVALID_RESPONSE');
  } finally {globalThis.fetch=old;}
});

test('Quick Scan homepage stays compact and full/original engines remain accessible',async()=>{
  const {readFile}=await import('node:fs/promises');
  const [app,quick,worker,admin]=await Promise.all([
    readFile(new URL('../src/index.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/components/QuickScanScorecard.tsx',import.meta.url),'utf8'),
    readFile(new URL('../worker/index.ts',import.meta.url),'utf8'),
    readFile(new URL('../src/components/AdminStation.tsx',import.meta.url),'utf8'),
  ]);
  assert.match(app,/void runQuickScan\(\)/);
  assert.match(app,/Quick Scan/);
  assert.match(app,/onClick=\{\(\) => void runDecision\(\)\}/);
  assert.match(app,/async function runAI\(/);
  assert.match(worker,/await runSelectiveAudit\(/);
  assert.match(worker,/await runAnalysis\(/);
  assert.match(worker,/\/api\/quick-scan/);
  assert.match(admin,/Send to Original AI/);
  assert.match(admin,/Send to Decision Model/);
  assert.doesNotMatch(quick,/<details|<summary|probabilities|\.reason|\.question|\.evidence|percent\(/);
  assert.match(quick,/class="quick-scan-row"/);
});

test('public About page is static, crawlable and has canonical metadata and real contact links',async()=>{
  const {readFile}=await import('node:fs/promises');
  const [about,home,footer,sitemap,robots]=await Promise.all([
    readFile(new URL('../public/about/index.html',import.meta.url),'utf8'),
    readFile(new URL('../index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/site-footer.css',import.meta.url),'utf8'),
    readFile(new URL('../public/sitemap.xml',import.meta.url),'utf8'),
    readFile(new URL('../public/robots.txt',import.meta.url),'utf8'),
  ]);
  assert.match(about,/<html lang="en"/);
  assert.match(about,/<title>About IssueLint/);
  assert.match(about,/rel="canonical" href="https:\/\/issuelint\.com\/about\/"/);
  assert.match(about,/type="application\/ld\+json"/);
  assert.match(about,/<h1 id="about-heading">/);
  assert.match(about,/What does IssueLint check\?/);
  assert.match(about,/Quick Scan/);
  assert.match(about,/Analyze v2/);
  assert.match(about,/not a substitute|not that the task is guaranteed correct/i);
  assert.match(about,/mailto:yorulmazyln@gmail\.com/);
  assert.match(about,/https:\/\/ylnyorulmaz\.com/);
  assert.match(about,/rel="noopener noreferrer"/);
  assert.match(about,/href="\/#analyze"/);
  assert.doesNotMatch(about,/GEMINI_API_KEY|PREVIEW_TOKEN|SAYGM_API_KEY/);
  assert.match(home,/rel="canonical" href="https:\/\/issuelint\.com\/"/);
  assert.match(home,/href="\/site-footer\.css"/);
  assert.match(footer,/\.site-footer-inner/);
  assert.match(sitemap,/<loc>https:\/\/issuelint\.com\/about\/</);
  assert.match(robots,/Disallow: \/admin/);
});

test('homepage header and footer link to About and the requested contacts without altering model routes',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../src/index.tsx',import.meta.url),'utf8');
  assert.match(source,/<a href="\/about\/">04 \/ About<\/a>/);
  assert.match(source,/class="site-footer"/);
  assert.match(source,/href="mailto:yorulmazyln@gmail\.com"/);
  assert.match(source,/href="https:\/\/ylnyorulmaz\.com"/);
  assert.match(source,/onClick=\{\(\) => void runDecision\(\)\}/);
  assert.match(source,/void runQuickScan\(\)/);
  assert.match(source,/async function runAI\(/);
});


test('static SEO guide and public page metadata are crawlable, unique and linked',async()=>{
  const {readFile}=await import('node:fs/promises');
  const [home,about,guide,site,sitemap,robots]=await Promise.all([
    readFile(new URL('../index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/about/index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/guides/how-to-write-a-clear-task/index.html',import.meta.url),'utf8'),
    readFile(new URL('../src/index.tsx',import.meta.url),'utf8'),
    readFile(new URL('../public/sitemap.xml',import.meta.url),'utf8'),
    readFile(new URL('../public/robots.txt',import.meta.url),'utf8')
  ]);
  const pages=[
    ['https://issuelint.com/',home],
    ['https://issuelint.com/about/',about],
    ['https://issuelint.com/guides/how-to-write-a-clear-task/',guide]
  ];
  const titles=[];
  for (const [url,content] of pages) {
    assert.match(content,/<html lang="en">/);
    assert.match(content,/<meta name="description" content="[^"]{60,200}"/);
    assert.match(content,/<meta name="robots" content="index,follow,max-image-preview:large"/);
    assert.equal((content.match(/rel="canonical"/g)||[]).length,1);
    assert.ok(content.includes('rel="canonical" href="'+url+'"'));
    assert.ok(sitemap.includes('<loc>'+url+'</loc>'));
    const title=content.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.ok(title);
    titles.push(title);
    const ld=content.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(ld);
    assert.equal(JSON.parse(ld)['@context'],'https://schema.org');
  }
  assert.equal(new Set(titles).size,3,'unique public titles');
  assert.equal((sitemap.match(/<loc>/g)||[]).length,3);
  assert.match(robots,/Disallow: \/admin/);
  assert.doesNotMatch(sitemap,/\/admin|\/api\//);
  assert.match(guide,/<article class="guide-article">/);
  assert.match(guide,/Six questions before handoff/);
  assert.match(guide,/A lightweight task template/);
  assert.match(guide,/It is not a guarantee/);
  assert.match(guide,/mailto:yorulmazyln@gmail.com/);
  assert.match(guide,/href="\/#analyze"/);
  assert.match(about,/href="\/guides\/how-to-write-a-clear-task\/"/);
  assert.match(site,/href="\/guides\/how-to-write-a-clear-task\/"/);
  assert.match(home,/<noscript>[\s\S]*task-writing guide/);
  assert.match(home,/<meta name="twitter:description"/);
});


test('public pages share the exact homepage navigation, header layout and appearance controls', async()=>{
  const {readFile}=await import('node:fs/promises');
  const [app,home,about,guide,css,appearance]=await Promise.all([
    readFile(new URL('../src/index.tsx',import.meta.url),'utf8'),
    readFile(new URL('../index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/about/index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/guides/how-to-write-a-clear-task/index.html',import.meta.url),'utf8'),
    readFile(new URL('../public/site-header.css',import.meta.url),'utf8'),
    readFile(new URL('../public/about/appearance.js',import.meta.url),'utf8')
  ]);
  const nav=src=>src.match(/<nav class="site-header-nav" aria-label="Primary">([\s\S]*?)<\/nav>/)?.[1];
  const items=src=>(nav(src)?.match(/>(0[1-4] \/ [^<]+)<\/a>/g)||[]).map(item=>item.replace(/^>/,'').replace(/<\/a>$/,''));
  const expected=['01 / Analyze','02 / Examples','03 / Process','04 / About'];
  assert.deepEqual(items(app),expected);
  assert.deepEqual(items(about),expected);
  assert.deepEqual(items(guide),expected);
  for(const src of [app,about,guide]) {
    assert.match(src,/class="(?:header )?site-header"/);
    assert.match(src,/class="(?:header-inner )?site-header-inner"/);
    assert.match(src,/class="(?:brand )?site-header-brand"/);
    assert.match(src,/class="(?:header-right )?site-header-right"/);
    assert.match(src,/class="appearance-switcher"/);
    assert.match(src,/class="appearance-switcher-caption"/);
    assert.match(src,/class="appearance-option"/);
    assert.match(src,/href="\/#analyze"/);
    assert.match(src,/href="\/#examples"/);
    assert.match(src,/href="\/#guide"/);
    assert.match(src,/href="\/about\/"/);
  }
  assert.match(app,/class="header site-header"/);
  assert.match(app,/class="header-inner site-header-inner"/);
  assert.match(app,/class="brand-logo"/);
  assert.match(app,/onClick=\{\(\) => chooseAppearance\('dark'\)\}/);
  assert.match(about,/aria-current="page">04 \/ About/);
  assert.match(about,/data-appearance="dark"/);
  assert.match(guide,/data-appearance="dark"/);
  assert.match(appearance,/localStorage\.setItem\(KEY, next\)/);
  assert.match(css,/max-width: 1220px/);
  assert.match(css,/min-height: 72px/);
  assert.match(css,/@media \(max-width: 650px\)/);
  assert.match(css,/html\[data-theme="dark"\]/);
  for(const page of [home,about,guide]) {
    assert.match(page,/href="\/site-header\.css"/);
  }
});
