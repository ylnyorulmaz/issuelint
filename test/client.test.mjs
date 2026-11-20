import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeLive, ApiError, getHealth } from '../src/api.ts';

const validTask = { title:'Check sales task', description:'Contact qualified leads on Friday.', type:'General', domain:'Sales', criteria:'', context:'' };
const analysis = { status:'ready', summary:'Clear task', findings:[], suggestedRewrite:'Contact qualified leads on Friday.' };
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
