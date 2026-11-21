import { createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import { render } from 'solid-js/web';
import { analyze, blank, examples, type Task, type TaskType, type Domain } from './analyzer';
import { analyzeLive, analyzeDecisionLive, getHealth, ApiError, type ApiAnalysis, type ApiDecisionResult, type ApiFinding } from './api';
import './style.css';
// Archived design preserved in src/styles.neobrutalist.css; inactive during minimalist-only beta.
import './styles.minimalist.css';
// Legacy visual theme choices are retained in src/design-theme.ts; no longer shown or applied.
import { readAppearance, saveAppearance, type Appearance } from './appearance';
import { BrandEmblem, SectionIndex, FindingMark, ScreenLabel } from './components/Constructivist';
import { prepareReviewTask, reviewTextLength, reviewInputValid } from './review-task';
import { analyticsConfigured, readAnalyticsConsent, saveAnalyticsConsent, enableAnalytics, trackAnalyticsEvent, type AnalyticsConsent } from './analytics';
import './styles.entry.css';
import './styles.review-loading.css';
import { ReviewLoading } from './components/ReviewLoading';
import { DecisionScorecard } from './components/DecisionScorecard';
import { AdminStation } from './components/AdminStation';
import './styles.admin.css';
import './styles.appearance.css';
import './styles.decision.css';
import { readRememberedPreviewCode, rememberPreviewCode, forgetPreviewCode } from './preview-access';
import { logClient, newRequestId, reportClientFailure } from './diagnostics';

const types: TaskType[] = ['General', 'Bug', 'Feature', 'Improvement', 'Request'];
const domains: Domain[] = ['Software', 'Marketing', 'Sales', 'Operations', 'Other'];
type Mode = 'live' | 'demo' | 'basic';
type View = {
  mode: Mode;
  status: 'ready' | 'needs_clarification' | 'blocked' | 'not_scored';
  score: number | null;
  summary: string;
  findings: (ApiFinding | { kind: ApiFinding['kind']; title: string; detail: string; question?: string; evidence?: string[]; severity?: ApiFinding['severity'] })[];
  draft: string;
  rewriteStatus?: ApiAnalysis['rewriteStatus'];
  reviewContext?: ApiAnalysis['reviewContext'];
  reviewCoverage?: ApiAnalysis['reviewCoverage'];
};
function displayStatus(status: View['status']): string {
  return ({ ready: 'Ready to work', needs_clarification: 'Needs clarification', blocked: 'Blocked — resolve first', not_scored: 'Basic review' })[status];
}
function fromLive(a: ApiAnalysis): View {
  return { mode: 'live', score: null, status: a.status, summary: a.summary, findings: a.findings, draft: a.suggestedRewrite, rewriteStatus: a.rewriteStatus,
    reviewContext: a.reviewContext, reviewCoverage: a.reviewCoverage };
}
function fromDemo(task: Task): View {
  const a = analyze(task);
  return { mode: a.mode, score: a.score, status: 'not_scored', summary: a.summary, findings: a.findings, draft: a.draft };
}

function App() {
  const [task, setTask] = createSignal<Task>(blank());
  const [result, setResult] = createSignal<View | null>(null);
  const [decisionResult, setDecisionResult] = createSignal<ApiDecisionResult | null>(null);
  const [decisionConfigured, setDecisionConfigured] = createSignal(false);
  const [activePipeline, setActivePipeline] = createSignal<'ai'|'decision'>('ai');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [available, setAvailable] = createSignal<'checking' | 'private' | 'demo'>('checking');
  const [accessCode, setAccessCode] = createSignal(readRememberedPreviewCode());
  const [details, setDetails] = createSignal(false);
  const [entryMode, setEntryMode] = createSignal<'paste' | 'build'>('paste');
  const [tab, setTab] = createSignal<'findings' | 'draft'>('findings');
  const [selected, setSelected] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [dark, setDark] = createSignal(readAppearance() === 'dark');
  const [analyticsConsent, setAnalyticsConsent] = createSignal<AnalyticsConsent>(readAnalyticsConsent());
  const [showPrivacyChoices, setShowPrivacyChoices] = createSignal(false);
  let requestController: AbortController | undefined;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;
  let activeRequestId: string | undefined;

  onMount(() => {
    if (analyticsConfigured && analyticsConsent() === 'accepted') enableAnalytics();
    let active = true;
    const onError = () => reportClientFailure('ui_error','client',accessCode().trim(),newRequestId());
    const onRejection = () => reportClientFailure('unhandled_rejection','client',accessCode().trim(),newRequestId());
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    getHealth().then(health => {
      if (active) {
        setAvailable(health.aiEnabled && health.aiBindingConfigured ? 'private' : 'demo');
        setDecisionConfigured(health.decisionConfigured);
        logClient('info', 'health_checked', {requestId:newRequestId(),status:200});
      }
    }).catch(() => {
      if (active) {
        setAvailable('demo');
        reportClientFailure('health_failed','network',accessCode().trim(),newRequestId());
      }
    });
    onCleanup(() => {
      active = false;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      requestController?.abort(); if (requestTimeout) clearTimeout(requestTimeout);
    });
  });

  function chooseAppearance(next: Appearance) {
    if (dark() === (next === 'dark')) return;
    setDark(next === 'dark');
    saveAppearance(next);
    trackAnalyticsEvent('theme_changed');
  }
  function chooseAnalyticsConsent(value: 'accepted' | 'declined') {
    const previouslyAccepted = analyticsConsent() === 'accepted';
    saveAnalyticsConsent(value);
    setAnalyticsConsent(value);
    setShowPrivacyChoices(false);
    if (value === 'accepted') enableAnalytics();
    else {
      // Scripts already loaded cannot be undone. Reload immediately with tracking disabled.
      const w = window as Window & { clarity?: (...args: unknown[]) => void };
      w.clarity?.('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
      if (previouslyAccepted) window.location.reload();
    }
  }

  function revealResults() {
    // The result panel is beneath the form on phones/tablets.
    if (window.matchMedia('(max-width: 900px)').matches) {
      window.setTimeout(() => document.getElementById('results')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      }), 80);
    }
  }
  function cancelRequest() {
    if (requestController && activeRequestId)
      logClient('info','review_cancelled',{requestId:activeRequestId});
    requestController?.abort();
    activeRequestId = undefined;
    requestController = undefined;
    if (requestTimeout) clearTimeout(requestTimeout);
    requestTimeout = undefined;
    setLoading(false);
  }
  function chooseEntryMode(mode: 'paste' | 'build') {
    if (entryMode() === mode || loading()) return;
    cancelRequest(); setEntryMode(mode); setDetails(false); setResult(null); setDecisionResult(null); setError(''); setCopied(false);
  }
  function edit<K extends keyof Task>(key: K, value: Task[K]) {
    cancelRequest();
    setTask(t => ({ ...t, [key]: value }));
    setResult(null); setDecisionResult(null); setError(''); setSelected(null); setCopied(false);
  }
  function load(id: string) {
    const example = examples.find(e => e.id === id);
    if (!example) return;
    cancelRequest();
    setTask({ ...example.task }); setEntryMode('paste'); setResult(null); setDecisionResult(null); setError('');
    setSelected(id); setTab('findings'); setCopied(false);
    trackAnalyticsEvent('example_loaded');
    document.getElementById('analyze')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function reset() {
    cancelRequest(); setTask(blank()); setResult(null); setDecisionResult(null); setError(''); setSelected(null);
    setDetails(false); setCopied(false);
  }
  function reviewDemo() {
    cancelRequest();
    setError(''); setTab('findings'); setCopied(false); setDecisionResult(null);
    setResult(fromDemo(prepareReviewTask(task())));
    trackAnalyticsEvent('review_completed');
    revealResults();
  }
  async function runAI() {
    if (loading() || !reviewInputValid(task())) return;
    if (available() !== 'private') {
      reviewDemo();
      return;
    }
    if (!accessCode().trim()) {
      setError('AI is in private preview. Enter your access code or use the demo review.');
      return;
    }
    setError(''); setResult(null); setDecisionResult(null); setActivePipeline('ai'); setLoading(true); setCopied(false);
    trackAnalyticsEvent('review_started');
    setTab('findings');
    revealResults();
    const controller = new AbortController();
    const requestId = newRequestId();
    const started = Date.now();
    activeRequestId = requestId;
    requestController = controller;
    requestTimeout = setTimeout(() => controller.abort(), 180000);
    try {
      const output = await analyzeLive(prepareReviewTask(task()), accessCode().trim(), controller.signal, requestId);
      if (requestController === controller) {
        setResult(fromLive(output));
        logClient('info','review_finished',{requestId,durationMs:Date.now()-started});
        trackAnalyticsEvent('review_completed');
        revealResults();
      }
    } catch (cause) {
      if (requestController !== controller) return;
      const message = cause instanceof ApiError ? cause.message :
        controller.signal.aborted ? 'Analysis timed out. Please retry.' : 'Network error. Check your connection and retry.';
      setError(message);
      const category = cause instanceof ApiError
        ? cause.status === 401 ? 'auth' : cause.status ? 'http' : cause.code === 'TIMEOUT' ? 'timeout' : 'network'
        : controller.signal.aborted ? 'timeout' : 'unknown';
      reportClientFailure('review_failed',category,accessCode().trim(),
        cause instanceof ApiError ? cause.requestId : requestId,
        cause instanceof ApiError ? cause.status : 0,Date.now()-started);
      trackAnalyticsEvent('review_failed');
      revealResults();
    } finally {
      if (requestController === controller) {
        requestController = undefined;
        activeRequestId = undefined;
        if (requestTimeout) clearTimeout(requestTimeout);
        requestTimeout = undefined;
        setLoading(false);
      }
    }
  }
  /** Iteration 1: score-only Decision pipeline, separate from V1. */
  async function runDecision() {
    if (loading() || !reviewInputValid(task()) || available() !== 'private') return;
    if (!decisionConfigured()) {
      setError('Gemini Decision 1 needs GEMINI_API_KEY in Cloudflare Worker secrets.');
      return;
    }
    if (!accessCode().trim()) {
      setError('Enter the private preview access code to use Decision v2.');
      return;
    }
    setError(''); setResult(null); setDecisionResult(null); setActivePipeline('decision');
    setLoading(true); setCopied(false); setTab('findings');
    revealResults();
    const controller = new AbortController();
    const requestId = newRequestId();
    const started = Date.now();
    requestController = controller;
    activeRequestId = requestId;
    logClient('info','decision_started',{requestId});
    try {
      const decision = await analyzeDecisionLive(
        prepareReviewTask(task()), accessCode().trim(), controller.signal, requestId);
      if (requestController === controller) {
        setDecisionResult(decision);
        logClient('info','decision_finished',{requestId,durationMs:Date.now()-started});
        revealResults();
      }
    } catch (cause) {
      if (requestController !== controller) return;
      const message = cause instanceof ApiError ? cause.message :
        'Decision review could not complete. Check your connection and retry.';
      setError(message);
      const category = cause instanceof ApiError ?
        cause.status===401?'auth':cause.status?'http':'network' :
        controller.signal.aborted?'timeout':'unknown';
      reportClientFailure('review_failed',category,accessCode().trim(),
        cause instanceof ApiError?cause.requestId:requestId,
        cause instanceof ApiError?cause.status:0,Date.now()-started);
      revealResults();
    } finally {
      if (requestController === controller) {
        requestController = undefined;
        activeRequestId = undefined;
        setLoading(false);
      }
    }
  }

  async function copy() {
    const output = result();
    if (!output) return;
    try { await navigator.clipboard.writeText(output.draft); setCopied(true); setError(''); }
    catch {
      setError('Clipboard access failed. Select the text in the draft panel to copy manually.');
      reportClientFailure('copy_failed','client',accessCode().trim(),newRequestId());
    }
  }
  const totalLength = () => reviewTextLength(task());
  const inputValid = () => reviewInputValid(task());

  return <div class="app" data-theme={dark() ? 'dark' : 'light'} data-design="minimalist">
    <header class="header"><div class="header-inner">
      <a class="brand" href="#top" aria-label="IssueLint home"><BrandEmblem/><span class="brand-word">ISSUE<strong>LINT</strong></span></a>
      <nav aria-label="Primary"><a href="#analyze" class="nav-current">01 / Analyze</a><a href="#examples">02 / Examples</a><a href="#guide">03 / Process</a></nav>
      <div class="header-right">
        <div class="appearance-switcher" role="group" aria-label="Choose light or dark appearance">
          <span class="appearance-switcher-caption" aria-hidden="true">MODE</span>
          <button class="appearance-option" type="button" aria-pressed={!dark()} onClick={() => chooseAppearance('light')}>Light</button>
          <button class="appearance-option" type="button" aria-pressed={dark()} onClick={() => chooseAppearance('dark')}>Dark</button>
        </div>
      </div>
    </div></header>

    <main id="top">
    <section class="entry-intro" aria-label="Start reviewing a task">
      <div>
        <span class="entry-eyebrow">THE SECOND OPINION FOR EVERY TASK</span>
        <h1>Paste or build a task. Make it clear.</h1>
        <p>Review an existing request or build one from scratch. Find gaps before work begins.</p>
      </div>
      <a class="entry-example-link" href="#examples">Need an example? <span aria-hidden="true">↗</span></a>
    </section>

    <section id="analyze" class="workspace" aria-label="Task analyzer">
      <div class="card input-card" data-clarity-mask="true">
        <div class="card-intro"><span class="intro-icon">01</span><div><h2>Review your task</h2><p>{entryMode() === 'paste' ? 'Paste any existing request for a second opinion.' : 'Create a clear task from a few useful details.'}</p></div><span class="panel-code">{entryMode() === 'paste' ? 'PASTE → REVIEW' : 'BUILD → REVIEW'}</span></div>
        <div class="availability" role="status">
          <span class={available() === 'private' ? 'status-dot active-dot' : 'status-dot'}/>
          <span>{available() === 'checking' ? 'Checking analysis availability…' :
            available() === 'private' ? 'AI review · private preview' : 'Demo review · AI not enabled'}</span>
        </div>
        <form onSubmit={e => { e.preventDefault(); void runAI(); }}>
          <div class="input-mode-switch" role="group" aria-label="Choose task input method">
            <button type="button" aria-pressed={entryMode() === 'paste'} class={entryMode() === 'paste' ? 'active' : ''} disabled={loading()} onClick={() => chooseEntryMode('paste')}>Paste existing task</button>
            <button type="button" aria-pressed={entryMode() === 'build'} class={entryMode() === 'build' ? 'active' : ''} disabled={loading()} onClick={() => chooseEntryMode('build')}>Build a task</button>
          </div>
          <Show when={entryMode() === 'paste'} fallback={<div class="build-input">
            <label for="title">Task title <span class="optional-field">(optional)</span></label>
            <input id="title" value={task().title} maxLength={180} disabled={loading()} placeholder="e.g. Add dark mode to web and mobile" onInput={e => edit('title', e.currentTarget.value)}/>
            <div class="form-grid"><div><label for="type">Task type</label><select id="type" value={task().type} disabled={loading()} onChange={e => edit('type', e.currentTarget.value as TaskType)}><For each={types}>{t => <option>{t}</option>}</For></select></div>
              <div><label for="domain">Area</label><select id="domain" value={task().domain} disabled={loading()} onChange={e => edit('domain', e.currentTarget.value as Domain)}><For each={domains}>{d => <option>{d}</option>}</For></select></div></div>
            <label for="description">What needs to be done? <span class="req">*</span></label>
            <textarea id="description" required rows={4} maxLength={6500} disabled={loading()} placeholder="Describe the requested work. A few sentences are enough." value={task().description} onInput={e => edit('description', e.currentTarget.value)}/>
            <label for="scope">Scope / target audience <span class="optional-field">(optional)</span></label>
            <textarea id="scope" rows={2} maxLength={1000} disabled={loading()} placeholder="Which screens, users, work areas or deliverables are included?" value={task().scope ?? ''} onInput={e => edit('scope', e.currentTarget.value)}/>
            <label for="outcome">Expected outcome <span class="optional-field">(optional)</span></label>
            <textarea id="outcome" rows={2} maxLength={1000} disabled={loading()} placeholder="What should be different when the task is complete?" value={task().outcome ?? ''} onInput={e => edit('outcome', e.currentTarget.value)}/>
            <label for="references">References <span class="optional-field">(optional)</span></label>
            <input id="references" maxLength={1000} disabled={loading()} placeholder="Figma, docs, ticket links or names" value={task().references ?? ''} onInput={e => edit('references', e.currentTarget.value)}/>
            <p class="build-hint">Only describe what you know. IssueLint will ask about missing decisions instead of inventing them.</p>
          </div>}>
            <label for="description">Paste your task, ticket or brief <span class="req">*</span></label>
            <textarea id="description" required rows={5} maxLength={6500} disabled={loading()} placeholder="Paste a Jira or GitHub ticket, meeting note, sales request, marketing brief… or describe the work in your own words." value={task().description} onInput={e => edit('description', e.currentTarget.value)}/>
            <div class="paste-helper"><span>Any team. Any tool. Plain text is enough.</span><span>Ctrl / ⌘ + V</span></div>
          </Show>
          <div class="counter" classList={{ 'over-budget': totalLength() > 8000 }}>{totalLength().toLocaleString()} / 8,000 characters</div>
          <Show when={available() === 'private'}>
            <div class="preview-code"><label for="preview-code">Private AI access code</label>
              <input id="preview-code" type="password" autocomplete="off" value={accessCode()} placeholder="Enter once — remembered on this browser" onInput={e => { const code = e.currentTarget.value; setAccessCode(code); rememberPreviewCode(code); setError(''); }}/>
              <div class="preview-code-footer">
                <p>{accessCode().trim() ? 'Code remembered in this browser for testing.' : 'Enter a code once; it will be prefilled next time.'}</p>
                <button type="button" disabled={!accessCode()} onClick={() => { forgetPreviewCode(); setAccessCode(''); setError(''); }}>Forget code</button>
              </div>
            </div>
          </Show>
          <Show when={error()}><div class="api-error" role="alert">{error()}</div></Show>
          <div class="actions primary-actions">
            <button class="primary" type="submit" disabled={!inputValid() || loading() || available() === 'checking'}>
              {loading() && activePipeline()==='ai' ? '◌  Analyzing…' : available() === 'private' ? '✦  Analyze with AI' : '✦  Review task'} <span>→</span>
            </button>
            <Show when={available() === 'private'}>
              <button class="decision-action" type="button" disabled={!inputValid() || loading() || !decisionConfigured()}
                title={decisionConfigured() ? 'Gemini Decision 1: 11-Gate classification' : 'Requires GEMINI_API_KEY in Cloudflare Worker secrets'}
                onClick={() => void runDecision()}>◇ Analyze v2 · Decision</button>
            </Show>
            <button class="reset" type="button" disabled={loading()} onClick={reset} aria-label="Clear task">↺</button>
          </div>
          <Show when={available() === 'private' && !decisionConfigured()}>
            <p class="decision-setup-note">Decision v2 is awaiting GEMINI_API_KEY in Cloudflare Worker secrets; the original AI review remains available.</p>
          </Show>
          <Show when={available() === 'private'}>
            <button class="secondary-action" type="button" disabled={!inputValid() || loading()} onClick={reviewDemo}>Run a demo review instead</button>
          </Show>
          <button type="button" class="disclosure details-disclosure" aria-expanded={details()} onClick={() => setDetails(!details())}>
            <span><b>{details() ? 'Hide additional fields' : entryMode() === 'paste' ? 'Add title, type or context (optional)' : 'Add acceptance criteria or constraints (optional)'}</b><small>Add known details only. Missing fields are not automatically failures.</small></span><span class="plus">{details() ? '−' : '+'}</span>
          </button>
          <Show when={details()}><div class="extra">
            <Show when={entryMode() === 'paste'}>
              <label for="title">Task title <span class="optional-field">(optional)</span></label>
              <input id="title" value={task().title} maxLength={180} disabled={loading()} placeholder="Derived from pasted task if left blank" onInput={e => edit('title', e.currentTarget.value)}/>
              <div class="form-grid"><div><label for="type">Task type</label><select id="type" value={task().type} disabled={loading()} onChange={e => edit('type', e.currentTarget.value as TaskType)}><For each={types}>{t => <option>{t}</option>}</For></select></div>
              <div><label for="domain">Area</label><select id="domain" value={task().domain} disabled={loading()} onChange={e => edit('domain', e.currentTarget.value as Domain)}><For each={domains}>{d => <option>{d}</option>}</For></select></div></div>
              <label for="scope">Scope / target audience <span class="optional-field">(optional)</span></label>
              <textarea id="scope" rows={2} maxLength={1000} disabled={loading()} value={task().scope ?? ''} onInput={e => edit('scope', e.currentTarget.value)}/>
              <label for="outcome">Expected outcome <span class="optional-field">(optional)</span></label>
              <textarea id="outcome" rows={2} maxLength={1000} disabled={loading()} value={task().outcome ?? ''} onInput={e => edit('outcome', e.currentTarget.value)}/>
              <label for="references">References <span class="optional-field">(optional)</span></label>
              <input id="references" maxLength={1000} disabled={loading()} placeholder="Related documents or links" value={task().references ?? ''} onInput={e => edit('references', e.currentTarget.value)}/>
            </Show>
            <label for="criteria">Completion / acceptance criteria</label><textarea id="criteria" rows={3} maxLength={1200} disabled={loading()} value={task().criteria} onInput={e => edit('criteria', e.currentTarget.value)}/>
            <label for="context">Constraints and context</label><textarea id="context" rows={3} maxLength={1200} disabled={loading()} value={task().context} onInput={e => edit('context', e.currentTarget.value)}/>
            <button class="optional-analyze" type="submit" disabled={!inputValid() || loading() || available() === 'checking'}>
              {loading() ? 'Analyzing…' : available() === 'private' ? 'Analyze with AI →' : 'Review task →'}
            </button>
          </div></Show>
          <p class="privacy-note">Analyze with AI uses Cloudflare Workers AI. Decision v2 sends task fields to Google Gemini Decisions and Cloudflare Workers AI via the Worker. Demo review runs in your browser.</p>
        </form>
      </div>

      <div class="card result-card" id="results" data-clarity-mask="true" aria-live="polite" aria-busy={loading()}>
        <div class="result-section-head"><ScreenLabel index="03">REVIEW / FINDINGS</ScreenLabel><span class="result-section-line" aria-hidden="true"/></div>
        <Show when={!loading()} fallback={activePipeline()==='decision'
          ? <div class="decision-loading" role="status"><span class="decision-loading-spinner" aria-hidden="true"/><h2>Checking 11 Gates…</h2><p>Gemini screens 11 gates, then GPT-OSS independently audits selected dimensions in one request.</p><button type="button" onClick={cancelRequest}>Cancel review</button></div>
          : <ReviewLoading onCancel={cancelRequest}/>}>
          <Show when={decisionResult()}>{d => <DecisionScorecard data={d()}/>}</Show>
          <Show when={!decisionResult()}>
          <Show when={result()} fallback={
            <Show when={error()} fallback={<div class="empty">
              <div class="empty-icon">↗</div><h2>AWAITING INPUT.</h2>
              <p>{available() === 'private' ? 'Enter your access code, then click “Analyze with AI” to see findings here. The code alone does not start a review.' : 'Fill in the task and press “Review task”. Your findings will appear here.'}</p>
              <button class="result-start" type="button" disabled={!inputValid() || loading() || available() === 'checking'} onClick={() => void runAI()}>
                {available() === 'private' ? 'Analyze with AI →' : 'Review task →'}
              </button>
              <div class="empty-features"><div><i class="red"/> Missing details</div><div><i class="amber"/> Unclear requirements</div><div><i class="purple"/> Contradictions & next steps</div></div>
              <span class="note">Not analyzed · {available() === 'private' ? 'Private AI enabled' : 'Demo mode'}</span>
            </div>}>
              <div class="result-failure" role="alert">
                <span class="failure-icon">!</span><h2>Review not completed</h2><p>{error()}</p>
                <button class="result-start" type="button" disabled={!inputValid() || loading()} onClick={() => void (activePipeline()==='decision'?runDecision():runAI())}>Try again →</button>
                <span>Nothing was analyzed successfully. Check the code and retry, or use demo review.</span>
              </div>
            </Show>
          }>
            {a => <>
              <div class="result-top"><div><span class="kicker">ANALYSIS RESULTS</span><h2>{displayStatus(a().status)}</h2><p>{a().summary}</p></div>
                <span class="pill">{a().mode === 'live' ? 'AI review' : a().mode === 'demo' ? 'Prewritten demo' : 'Basic checks'}</span>
              </div>
              <div class="score-box"><div class={a().score === null ? 'no-score' : 'score'}>{a().score === null ? '—' : <><b>{a().score}</b><small>/100</small></>}</div>
                <div><strong>{a().findings.length} finding{a().findings.length === 1 ? '' : 's'}</strong><p>{a().mode === 'live'
                    ? (a().reviewCoverage?.checked ? a().reviewCoverage?.checked + ' checks assessed' : 'AI review') + ' · ' +
                      (a().reviewContext ? a().reviewContext?.domain + ' / ' + a().reviewContext?.type +
                      (a().reviewContext?.inferred ? ' (inferred)' : '') : 'Review findings') :
                  a().mode === 'demo' ? 'Illustrative score and prewritten findings' : 'Simple structural checks, not an AI analysis'}</p></div>
              </div>
              <div class="tabs" role="tablist" aria-label="Result views">
                <button type="button" role="tab" aria-selected={tab() === 'findings'} class={tab() === 'findings' ? 'active' : ''} onClick={() => setTab('findings')}>Findings</button>
                <button type="button" role="tab" aria-selected={tab() === 'draft'} class={tab() === 'draft' ? 'active' : ''} onClick={() => setTab('draft')}>Suggested draft</button>
              </div>
              <Show when={tab() === 'findings'} fallback={<div class="draft">
                <div class="draft-head"><strong>{
                  a().mode !== 'live' ? (a().mode === 'basic' ? 'Structured input copy' : 'Illustrative draft') :
                  a().rewriteStatus === 'rewritten' ? 'Improved task draft' :
                  a().rewriteStatus === 'clarification_draft' ? 'Clarification checklist' : 'Rewrite unavailable'
                }</strong>
                  <Show when={a().draft.trim().length > 0}>
                    <button type="button" onClick={() => void copy()}>{copied() ? '✓ Copied' : '▢ Copy'}</button>
                  </Show>
                </div>
                <Show when={a().draft.trim().length > 0} fallback={<div class="rewrite-unavailable">
                  No improved draft was generated. Your original text has not been presented as a rewrite. Review the findings to refine the task.
                </div>}>
                  <pre>{a().draft}</pre>
                  <p>{
                    a().mode === 'live' && a().rewriteStatus === 'clarification_draft'
                      ? 'The original task is preserved with outstanding questions. This is not an AI rewrite; resolve questions before execution.'
                      : a().mode === 'live'
                      ? 'AI-generated rewrite. Verify all details against the source. Unresolved questions are not confirmed requirements.'
                      : 'Illustrative or structural output. Verify before using.'
                  }</p>
                </Show>
              </div>}>
                <div class="findings"><Show when={a().findings.length === 0}><div class="no-findings">No issues identified. Verify the task details yourself before proceeding.</div></Show>
                  <For each={a().findings}>{f => <article class="finding"><FindingMark kind={f.kind}/><div class="finding-content">
                    <span class={'kind ' + f.kind}>{f.kind}{f.severity ? ' · ' + f.severity : ''}</span>
                    <h3>{f.title}</h3><p>{f.detail}</p>
                    <Show when={f.evidence?.length}><div class="evidence"><b>Evidence:</b><For each={f.evidence}>{quote => <q>{quote}</q>}</For></div></Show>
                    <Show when={f.question}><div class="question"><b>Clarify:</b> {f.question}</div></Show>
                  </div></article>}</For>
                </div><button type="button" class="draft-link" onClick={() => setTab('draft')}>View suggested draft →</button>
              </Show>
              <p class="disclaimer">{a().mode === 'live' ? 'AI can make mistakes. Check every finding against your original task.' :
                a().mode === 'demo' ? 'Example findings are prewritten and illustrative, not from a model.' :
                'Basic checks cannot detect semantic ambiguity or contradictions.'}</p>
            </>}
          </Show>
          </Show>
        </Show>
      </div>
    </section>

    <section id="examples" class="examples">
      <div class="section-heading"><div><SectionIndex number="04" label="Field exercises"/><h2>TEST THE SYSTEM.</h2></div><p>Three cases. Three domains. One standard: the work must be clear.</p></div>
      <div class="example-grid"><For each={examples}>{(ex, i) =>
      <button type="button" onClick={() => load(ex.id)} class={'example ' + (selected() === ex.id ? 'selected' : '')}><span class="example-number">0{i() + 1}</span><strong>{ex.label}</strong><p>{ex.task.description}</p><span class="example-link">Load example →</span></button>
    }</For></div></section>

    <section id="guide" class="guide"><SectionIndex number="05" label="The method"/><h2>FROM NOISE TO ACTION.</h2><div class="steps"><div><span>01</span><h3>Describe</h3><p>Enter a title, description, and type. Add context if it matters.</p></div><div><span>02</span><h3>Inspect</h3><p>Review questions, missing details, and possible conflicts.</p></div><div><span>03</span><h3>Refine</h3><p>Copy your improved task into whatever tool your team uses.</p></div></div><p class="disclaimer">AI preview access is restricted. Demo reviews use examples or simple checks; they are not semantic AI analysis.</p></section>
    </main>
    <footer><div><b>ISSUE/LINT ↗</b><span>Clear work starts here.</span></div>
      <div class="footer-meta"><span>NO ACCOUNT · NO STORED TASKS · AI REVIEWS: CLOUDFLARE · DECISION V2: GOOGLE GEMINI + CLOUDFLARE AI</span>
        <Show when={analyticsConfigured}><button type="button" class="privacy-settings" onClick={() => setShowPrivacyChoices(true)}>Analytics preferences</button></Show>
      </div>
    </footer>
    <Show when={analyticsConfigured && (analyticsConsent() === 'unset' || showPrivacyChoices())}>
      <div class="consent-banner" role="region" aria-label="Optional analytics consent">
        <div><strong>Optional analytics</strong><p>Allow anonymous product usage metrics and masked Clarity session recordings? Your task text, results and access code are never sent as analytics events. No analytics scripts load unless you accept.</p></div>
        <div class="consent-actions">
          <button type="button" class="consent-decline" onClick={() => chooseAnalyticsConsent('declined')}>Decline</button>
          <button type="button" class="consent-accept" onClick={() => chooseAnalyticsConsent('accepted')}>Allow analytics</button>
        </div>
      </div>
    </Show>
  </div>;
}
// The admin test station is a separate private-data client view. Direct /admin
// navigation works via Cloudflare's SPA asset fallback, without touching V1/V2.
const isAdminRoute = /^\/admin\/?$/.test(window.location.pathname);
render(() => isAdminRoute ? <AdminStation/> : <App/>, document.getElementById('root')!);
