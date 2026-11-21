import { createSignal, For, Show, onCleanup } from 'solid-js';
import type { ApiAnalysis, ApiDecisionResult } from '../api';
import { analyzeLive, analyzeDecisionLive, ApiError, getHealth } from '../api';
import { loadAdminFixture, type AdminCase, type AdminSource, type AdminFixture } from '../admin-data';
import { readRememberedPreviewCode, rememberPreviewCode, forgetPreviewCode } from '../preview-access';
import { readDesignTheme } from '../design-theme';
import { DecisionScorecard } from './DecisionScorecard';

type Result<T> = { state:'done'; data:T; elapsedMs:number } |
  { state:'error'; message:string; elapsedMs:number };
type CaseRuns = { original?:Result<ApiAnalysis>; decision?:Result<ApiDecisionResult> };
type Engine = 'original' | 'decision';

const STATUS_LABELS = {
  ready:'Ready',needs_clarification:'Needs clarification',blocked:'Blocked',
} as const;
const TASK_FIELDS = [
  ['title','Title'],['description','Description'],['type','Task type'],['domain','Domain'],
  ['scope','Scope'],['outcome','Outcome'],['criteria','Completion criteria'],
  ['context','Context'],['references','References'],
] as const;

function OriginalDetails(props:{value:ApiAnalysis}) {
  return <div class="admin-original-output">
    <div class="admin-result-summary">
      <span class={'admin-status '+props.value.status}>{STATUS_LABELS[props.value.status]}</span>
      <span>{props.value.findings.length} findings</span>
      <span>Rewrite: {props.value.rewriteStatus.replaceAll('_',' ')}</span>
    </div>
    <p class="admin-review-summary">{props.value.summary}</p>
    <Show when={props.value.reviewCoverage}>
      {coverage=><p class="admin-meta">Gate coverage: {coverage().checked} checked · {coverage().gaps} gaps · {coverage().reported} reported</p>}
    </Show>
    <For each={props.value.findings}>{finding=>
      <section class="admin-finding">
        <div class="admin-finding-top"><strong>{finding.title}</strong><span class={'admin-severity '+finding.severity}>{finding.severity}</span></div>
        <p>{finding.detail}</p>
        <Show when={finding.evidence.length>0}>
          <div class="admin-quoted"><For each={finding.evidence}>{quote=><q>{quote}</q>}</For></div>
        </Show>
        <Show when={finding.question}><p><b>Clarification:</b> {finding.question}</p></Show>
      </section>
    }</For>
    <Show when={props.value.suggestedRewrite.trim()}>
      <details class="admin-draft">
        <summary>View suggested draft</summary>
        <pre>{props.value.suggestedRewrite}</pre>
      </details>
    </Show>
  </div>;
}

export function AdminStation() {
  const [code,setCode]=createSignal(readRememberedPreviewCode());
  const [fixture,setFixture]=createSignal<AdminFixture|null>(null);
  const [loadingSource,setLoadingSource]=createSignal<AdminSource|null>(null);
  const [loadingError,setLoadingError]=createSignal('');
  const [expanded,setExpanded]=createSignal<string|null>(null);
  const [oracleShown,setOracleShown]=createSignal<Record<string,boolean>>({});
  const [runs,setRuns]=createSignal<Record<string,CaseRuns>>({});
  const [busy,setBusy]=createSignal<string|null>(null);
  const [filter,setFilter]=createSignal<'All'|'Software'|'Marketing'|'Sales'>('All');
  const [dark,setDark]=createSignal(window.matchMedia?.('(prefers-color-scheme: dark)').matches??false);
  const [availability,setAvailability]=createSignal<'checking'|'ready'|'disabled'>('checking');
  let loadController:AbortController|undefined;
  let runController:AbortController|undefined;

  getHealth().then(h=>setAvailability(h.aiEnabled&&h.aiBindingConfigured?'ready':'disabled'))
    .catch(()=>setAvailability('disabled'));
  onCleanup(()=>{loadController?.abort();runController?.abort();});

  function setAccessCode(value:string) {
    setCode(value);
    rememberPreviewCode(value);
    setLoadingError('');
  }
  function cancelRun() {runController?.abort();}
  async function load(source:AdminSource) {
    if(loadingSource())return;
    if(!code().trim()){setLoadingError('Enter the private access code before loading test cases.');return;}
    runController?.abort();
    loadController?.abort();
    const controller=new AbortController();
    loadController=controller;
    setLoadingSource(source);setLoadingError('');
    try {
      const data=await loadAdminFixture(source,code(),controller.signal);
      if(loadController!==controller)return;
      setFixture(data);setExpanded(data.cases[0]?.id??null);setOracleShown({});setRuns({});setFilter('All');
    } catch(e) {
      if(loadController!==controller)return;
      setLoadingError(e instanceof ApiError?e.message:'Unable to load the test cases.');
    } finally {
      if(loadController===controller){loadController=undefined;setLoadingSource(null);}
    }
  }
  async function runTest(item:AdminCase,engine:Engine) {
    if(busy()||!code().trim())return;
    setExpanded(item.id);setLoadingError('');
    const controller=new AbortController();
    runController=controller;
    setBusy(item.id+':'+engine);
    const started=Date.now();
    try {
      // Task object ONLY. Never serialize the oracle, case ID, labels or other evaluation metadata.
      if(engine==='original') {
        const output=await analyzeLive(item.task,code().trim(),controller.signal);
        if(runController!==controller)return;
        const record:Result<ApiAnalysis>={state:'done',data:output,elapsedMs:Date.now()-started};
        setRuns(old=>({...old,[item.id]:{...old[item.id],original:record}}));
      } else {
        const output=await analyzeDecisionLive(item.task,code().trim(),controller.signal);
        if(runController!==controller)return;
        const record:Result<ApiDecisionResult>={state:'done',data:output,elapsedMs:Date.now()-started};
        setRuns(old=>({...old,[item.id]:{...old[item.id],decision:record}}));
      }
    } catch(e) {
      if(runController!==controller)return;
      const message=e instanceof ApiError?e.message:'Review failed; retry the individual test.';
      const record:Result<ApiAnalysis>={state:'error',message,elapsedMs:Date.now()-started};
      setRuns(old=>({...old,[item.id]:{...old[item.id],[engine]:record}}));
    } finally {
      if(runController===controller){runController=undefined;setBusy(null);}
    }
  }

  return <div class="app admin-app" data-theme={dark()?'dark':'light'} data-design={readDesignTheme()}>
    <header class="admin-header">
      <div class="admin-header-inner">
        <div class="admin-identity"><a href="/" class="admin-brand">ISSUE<span>/</span>LINT</a><span class="admin-label">TEST STATION / ADMIN</span></div>
        <div class="admin-header-links"><a href="/">← Back to app</a><button type="button" class="theme" onClick={()=>setDark(!dark())} aria-label="Toggle dark mode">{dark()?'☀':'☾'}</button></div>
      </div>
    </header>
    <main class="admin-main">
      <div class="admin-kicker">INTERNAL EVALUATION · EXPERIMENTAL</div>
      <div class="admin-title-row">
        <div><h1>TEST <em>STATION.</em></h1><p>Load a controlled benchmark. Inspect the task, then run either live analysis engine. Each execution is an actual model request.</p></div>
        <div class="admin-small-counter">{fixture()?.cases.length??'—'}<span>cases loaded</span></div>
      </div>
      <section class="admin-control card" aria-label="Test station access and datasets">
        <div class="admin-access">
          <label for="admin-code">Private AI access code</label>
          <div class="admin-code-input">
            <input id="admin-code" type="password" autocomplete="off" value={code()} placeholder="Same code as the main app" onInput={e=>setAccessCode(e.currentTarget.value)}/>
            <button type="button" onClick={()=>{forgetPreviewCode();setCode('');setLoadingError('');}}>Forget</button>
          </div>
          <p>Uses the same private preview authentication. Credentials are never bundled into this page or test datasets.</p>
        </div>
        <div class="admin-load-buttons">
          <button class="admin-load-button" type="button" disabled={!!loadingSource()||!!busy()||!code().trim()}
            onClick={()=>void load('chatgpt')}>
            <span>01 / CONTROL GROUP</span>
            <strong>{loadingSource()==='chatgpt'?'Loading…':'Load test cases from ChatGPT'}</strong>
            <small>12 tasks · Software / Marketing / Sales</small>
          </button>
          <button class="admin-load-button" type="button" disabled={!!loadingSource()||!!busy()||!code().trim()}
            onClick={()=>void load('gemini')}>
            <span>02 / INDEPENDENT SET</span>
            <strong>{loadingSource()==='gemini'?'Loading…':'Load test cases from Gemini'}</strong>
            <small>12 reviewed Gemini-origin tasks</small>
          </button>
        </div>
        <div class="admin-control-footer">
          <span class={'admin-service '+availability()}>{availability()==='ready'?'● Models enabled':availability()==='checking'?'○ Checking service…':'○ Model execution unavailable'}</span>
          <span>Test requests are individually triggered; no automatic batch runs.</span>
        </div>
        <Show when={loadingError()}><p class="admin-error" role="alert">{loadingError()}</p></Show>
      </section>

      <Show when={fixture()} fallback={
        <section class="admin-empty card"><strong>No dataset loaded</strong><p>Choose ChatGPT or Gemini above to inspect its 12 test cases. Existing reviews are never run automatically.</p></section>
      }>
        {dataset=><section class="admin-dataset" aria-label="Loaded test cases">
          <div class="admin-dataset-heading">
            <div><span class="admin-kicker">{dataset().source==='gemini'?'GEMINI · INDEPENDENT ORIGIN':'CHATGPT · CONTROL GROUP'}</span><h2>{dataset().dataset_id}</h2><p>Expected labels are author hypotheses, not ground truth. Only each task is sent to the models.</p></div>
            <div class="admin-filters" role="group" aria-label="Filter test cases by domain">
              <For each={(['All','Software','Marketing','Sales'] as const)}>{value=>
                <button type="button" class={filter()===value?'selected':''} aria-pressed={filter()===value} onClick={()=>setFilter(value)}>{value}</button>
              }</For>
            </div>
          </div>
          <div class="admin-cases">
            <For each={dataset().cases.filter(c=>filter()==='All'||c.domain===filter())}>{item=>
              <article class="admin-case card">
                <div class="admin-case-head">
                  <div class="admin-case-identity">
                    <span class="admin-case-id">{item.id} / {item.domain}</span>
                    <h3>{item.task.title}</h3>
                    <div class="admin-case-tags"><span>{item.task.type}</span><span class={item.quality==='well_specified_control'?'admin-clean':'admin-flawed'}>{item.quality==='well_specified_control'?'Well-defined control':'Deliberately flawed'}</span></div>
                  </div>
                  <div class="admin-case-actions">
                    <button type="button" class="admin-detail-toggle" aria-expanded={expanded()===item.id} onClick={()=>setExpanded(expanded()===item.id?null:item.id)}>{expanded()===item.id?'Hide details −':'View details +'}</button>
                    <button type="button" class="admin-run-original" disabled={!!busy()||!!loadingSource()||availability()!=='ready'} onClick={()=>void runTest(item,'original')}>
                      {busy()===item.id+':original'?'Running original…':'Send to Original AI'}
                    </button>
                    <button type="button" class="admin-run-decision" disabled={!!busy()||!!loadingSource()||availability()!=='ready'} onClick={()=>void runTest(item,'decision')}>
                      {busy()===item.id+':decision'?'Running decision…':'Send to Decision Model'}
                    </button>
                  </div>
                </div>
                <Show when={expanded()===item.id}>
                  <div class="admin-case-body">
                    <div class="admin-task-details">
                      <div class="admin-section-label">INPUT TASK · EXACT PAYLOAD</div>
                      <div class="admin-fields">
                        <For each={TASK_FIELDS}>{([field,label])=><div class="admin-field">
                          <span>{label}</span><p class={!item.task[field]?'admin-unset':''}>{item.task[field]||'(not specified)'}</p>
                        </div>}</For>
                      </div>
                      <button type="button" class="admin-oracle-toggle" aria-expanded={!!oracleShown()[item.id]}
                        onClick={()=>setOracleShown(old=>({...old,[item.id]:!old[item.id]}))}>
                        {oracleShown()[item.id]?'Hide expected labels −':'Show expected labels +'}
                      </button>
                      <Show when={oracleShown()[item.id]}>
                        <div class="admin-oracle">
                          <div class="admin-section-label">AUTHOR EXPECTATIONS · NOT MODEL INPUT</div>
                          <p><b>Expected V1 status:</b> {STATUS_LABELS[item.oracle.expected_status]}</p>
                          <Show when={!item.oracle.must_detect.length}><p>Clean control: no material gaps expected.</p></Show>
                          <For each={item.oracle.must_detect}>{issue=><div class="admin-expected-issue"><strong>{issue.dimension}</strong><p>{issue.issue}</p></div>}</For>
                          <Show when={item.oracle.bonus_detect?.length}><p class="admin-meta">Optional detections:</p>
                            <For each={item.oracle.bonus_detect}>{issue=><div class="admin-expected-issue"><strong>{issue.dimension}</strong><p>{issue.issue}</p></div>}</For>
                          </Show>
                          <Show when={item.oracle.must_not_invent?.length}><p class="admin-meta">Avoid fabricated findings:</p><For each={item.oracle.must_not_invent}>{text=><p>• {text}</p>}</For></Show>
                        </div>
                      </Show>
                    </div>
                    <Show when={busy()?.startsWith(item.id+':')}>
                      <div class="admin-executing" role="status"><span class="decision-loading-spinner" aria-hidden="true"/><span>{busy()?.endsWith(':original')?'Original GPT-OSS + optional SayGM verifier is running.':'Gemini Decision 1 + selected high-reasoning GPT-OSS audit is running.'}</span>
                        <button type="button" onClick={cancelRun}>Cancel</button></div>
                    </Show>
                    <Show when={runs()[item.id]?.original||runs()[item.id]?.decision}>
                      <section class="admin-results" aria-label={'Test results for '+item.id}>
                        <div class="admin-section-label">ACTUAL RESULTS · LIVE MODEL OUTPUT</div>
                        <div class="admin-result-grid">
                          <div class="admin-result-column">
                            <h4>Original AI <small>/api/analyze</small></h4>
                            <Show when={runs()[item.id]?.original} fallback={<p class="admin-awaiting">Not run yet. Use Send to Original AI.</p>} keyed>
                              {value=><><p class="admin-meta">{(value.elapsedMs/1000).toFixed(1)} s elapsed</p>
                                <Show when={value.state==='done'} fallback={<p class="admin-error">{value.state==='error'?value.message:''}</p>}>
                                  <OriginalDetails value={(value as {data:ApiAnalysis}).data}/>
                                </Show>
                              </>}
                            </Show>
                          </div>
                          <div class="admin-result-column">
                            <h4>Decision Model <small>/api/analyze-v2</small></h4>
                            <Show when={runs()[item.id]?.decision} fallback={<p class="admin-awaiting">Not run yet. Use Send to Decision Model.</p>} keyed>
                              {value=><><p class="admin-meta">{(value.elapsedMs/1000).toFixed(1)} s elapsed</p>
                                <Show when={value.state==='done'} fallback={<p class="admin-error">{value.state==='error'?value.message:''}</p>}>
                                  <DecisionScorecard data={(value as {data:ApiDecisionResult}).data}/>
                                </Show>
                              </>}
                            </Show>
                          </div>
                        </div>
                      </section>
                    </Show>
                  </div>
                </Show>
              </article>
            }</For>
          </div>
        </section>}
      </Show>
      <p class="admin-footnote">PRIVATE TEST STATION · Author labels are reference hypotheses. Run each task against the two real, unchanged production analysis paths. No test results are stored on the server.</p>
    </main>
  </div>;
}
