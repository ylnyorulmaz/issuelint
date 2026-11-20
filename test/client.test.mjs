import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeLive, ApiError, getHealth } from '../src/api.ts';

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

test('Minimal Constructivism stays the default, including unknown preferences', () => {
  assert.equal(DEFAULT_DESIGN_THEME, 'constructivist');
  assert.equal(normalizeDesignTheme(null), 'constructivist');
  assert.equal(normalizeDesignTheme('not-a-design'), 'constructivist');
  assert.equal(normalizeDesignTheme('neobrutalist'), 'neobrutalist');
  assert.equal(normalizeDesignTheme('zen'), 'zen');
});

test('design theme preference survives a reload via storage', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readDesignTheme(storage), 'constructivist');
  saveDesignTheme('neobrutalist', storage);
  assert.equal(values.get(DESIGN_THEME_STORAGE_KEY), 'neobrutalist');
  assert.equal(readDesignTheme(storage), 'neobrutalist');
  saveDesignTheme('zen', storage);
  assert.equal(readDesignTheme(storage), 'zen');
  saveDesignTheme('constructivist', storage);
  assert.equal(readDesignTheme(storage), 'constructivist');
  assert.equal(values.size, 1);
});

test('blocked or unavailable localStorage does not break the analyzer', () => {
  const inaccessible = {
    getItem: () => { throw Error('Blocked'); },
    setItem: () => { throw Error('Blocked'); },
  };
  assert.equal(readDesignTheme(inaccessible), 'constructivist');
  assert.doesNotThrow(() => saveDesignTheme('neobrutalist', inaccessible));
  assert.equal(readDesignTheme(), 'constructivist');
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
