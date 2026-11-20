import { createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import { render } from 'solid-js/web';
import { analyze, blank, examples, type Task, type TaskType, type Domain } from './analyzer';
import { analyzeLive, getHealth, ApiError, type ApiAnalysis, type ApiFinding } from './api';
import './style.css';
import './styles.iteration3.css';

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
};
function displayStatus(status: View['status']): string {
  return ({ ready: 'Ready to work', needs_clarification: 'Needs clarification', blocked: 'Blocked — resolve first', not_scored: 'Basic review' })[status];
}
function fromLive(a: ApiAnalysis): View {
  return { mode: 'live', score: null, status: a.status, summary: a.summary, findings: a.findings, draft: a.suggestedRewrite };
}
function fromDemo(task: Task): View {
  const a = analyze(task);
  return { mode: a.mode, score: a.score, status: 'not_scored', summary: a.summary, findings: a.findings, draft: a.draft };
}

function App() {
  const [task, setTask] = createSignal<Task>(blank());
  const [result, setResult] = createSignal<View | null>(null);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [available, setAvailable] = createSignal<'checking' | 'private' | 'demo'>('checking');
  const [accessCode, setAccessCode] = createSignal('');
  const [details, setDetails] = createSignal(false);
  const [tab, setTab] = createSignal<'findings' | 'draft'>('findings');
  const [selected, setSelected] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [dark, setDark] = createSignal(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  let requestController: AbortController | undefined;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    let active = true;
    getHealth().then(health => {
      if (active) setAvailable(health.aiEnabled && health.aiBindingConfigured ? 'private' : 'demo');
    }).catch(() => { if (active) setAvailable('demo'); });
    onCleanup(() => { active = false; requestController?.abort(); if (requestTimeout) clearTimeout(requestTimeout); });
  });

  function cancelRequest() {
    requestController?.abort();
    requestController = undefined;
    if (requestTimeout) clearTimeout(requestTimeout);
    requestTimeout = undefined;
    setLoading(false);
  }
  function edit<K extends keyof Task>(key: K, value: Task[K]) {
    cancelRequest();
    setTask(t => ({ ...t, [key]: value }));
    setResult(null); setError(''); setSelected(null); setCopied(false);
  }
  function load(id: string) {
    const example = examples.find(e => e.id === id);
    if (!example) return;
    cancelRequest();
    setTask({ ...example.task }); setResult(null); setError('');
    setSelected(id); setTab('findings'); setCopied(false);
    document.getElementById('analyze')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function reset() {
    cancelRequest(); setTask(blank()); setResult(null); setError(''); setSelected(null);
    setDetails(false); setCopied(false);
  }
  function reviewDemo() {
    cancelRequest();
    setError(''); setTab('findings'); setCopied(false);
    setResult(fromDemo(task()));
  }
  async function runAI() {
    if (loading()) return;
    if (available() !== 'private') {
      reviewDemo();
      return;
    }
    if (!accessCode().trim()) {
      setError('AI is in private preview. Enter your access code or use the demo review.');
      return;
    }
    setError(''); setResult(null); setLoading(true); setCopied(false);
    setTab('findings');
    const controller = new AbortController();
    requestController = controller;
    requestTimeout = setTimeout(() => controller.abort(), 45000);
    try {
      const output = await analyzeLive(task(), accessCode().trim(), controller.signal);
      if (requestController === controller) setResult(fromLive(output));
    } catch (cause) {
      if (requestController !== controller) return;
      const message = cause instanceof ApiError ? cause.message :
        controller.signal.aborted ? 'Analysis timed out. Please retry.' : 'Network error. Check your connection and retry.';
      setError(message);
    } finally {
      if (requestController === controller) {
        requestController = undefined;
        if (requestTimeout) clearTimeout(requestTimeout);
        requestTimeout = undefined;
        setLoading(false);
      }
    }
  }
  async function copy() {
    const output = result();
    if (!output) return;
    try { await navigator.clipboard.writeText(output.draft); setCopied(true); setError(''); }
    catch { setError('Clipboard access failed. Select the text in the draft panel to copy manually.'); }
  }
  const totalLength = () => task().title.length + task().description.length + task().criteria.length + task().context.length;
  const inputValid = () => !!task().title.trim() && !!task().description.trim() &&
    task().title.length <= 180 && task().description.length <= 6500 &&
    task().criteria.length <= 1200 && task().context.length <= 1200 && totalLength() <= 8000;

  return <div class="app" data-theme={dark() ? 'dark' : 'light'}>
    <header class="header"><div class="header-inner">
      <a class="brand" href="#top"><span class="logo">✓</span><span>Issue<b>Lint</b></span></a>
      <nav aria-label="Primary"><a href="#analyze" class="nav-current">Analyze</a><a href="#examples">Examples</a><a href="#guide">How it works</a></nav>
      <div class="header-right"><span class="version">v0.2 preview</span><button class="theme" type="button" onClick={() => setDark(!dark())} aria-label={dark() ? 'Switch to light mode' : 'Switch to dark mode'}>{dark() ? '☀' : '☾'}</button></div>
    </div></header>

    <main id="top"><section class="hero">
      <div class="eyebrow"><span class="dot"/> CLEAR WORK STARTS HERE</div>
      <h1>Make every task <em>clear.</em></h1>
      <p>Find missing details, vague requirements and contradictions before anyone starts work. No Jira or project management integration needed.</p>
      <div class="hero-meta">Any team <span>·</span> Any task <span>·</span> No account</div>
    </section>

    <section id="analyze" class="workspace" aria-label="Task analyzer">
      <div class="card input-card">
        <div class="card-intro"><span class="intro-icon">✎</span><div><h2>Describe your task</h2><p>Start with a title and description.</p></div></div>
        <div class="availability" role="status">
          <span class={available() === 'private' ? 'status-dot active-dot' : 'status-dot'}/>
          <span>{available() === 'checking' ? 'Checking analysis availability…' :
            available() === 'private' ? 'AI review · private preview' : 'Demo review · AI not enabled'}</span>
        </div>
        <form onSubmit={e => { e.preventDefault(); void runAI(); }}>
          <label for="title">Task title <span class="req">*</span></label>
          <input id="title" value={task().title} required maxLength={180} disabled={loading()} placeholder="What needs to be done?" onInput={e => edit('title', e.currentTarget.value)}/>
          <label for="description">Description <span class="req">*</span></label>
          <textarea id="description" required rows={7} maxLength={6500} disabled={loading()} placeholder="Describe the problem, goal, or requested work. It doesn't need to be perfect." value={task().description} onInput={e => edit('description', e.currentTarget.value)}/>
          <div class="form-grid"><div><label for="type">Task type</label><select id="type" value={task().type} disabled={loading()} onChange={e => edit('type', e.currentTarget.value as TaskType)}><For each={types}>{t => <option>{t}</option>}</For></select></div>
          <div><label for="domain">Area</label><select id="domain" value={task().domain} disabled={loading()} onChange={e => edit('domain', e.currentTarget.value as Domain)}><For each={domains}>{d => <option>{d}</option>}</For></select></div></div>
          <button type="button" class="disclosure" aria-expanded={details()} onClick={() => setDetails(!details())}><span><b>Additional details</b><small>Completion criteria and context (optional)</small></span><span class="plus">{details() ? '−' : '+'}</span></button>
          <Show when={details()}><div class="extra">
            <label for="criteria">Completion / acceptance criteria</label><textarea id="criteria" rows={3} maxLength={1200} value={task().criteria} onInput={e => edit('criteria', e.currentTarget.value)}/>
            <label for="context">Constraints and context</label><textarea id="context" rows={3} maxLength={1200} value={task().context} onInput={e => edit('context', e.currentTarget.value)}/>
          </div></Show>
          <div class="counter" classList={{ 'over-budget': totalLength() > 8000 }}>{totalLength().toLocaleString()} / 8,000 characters</div>
          <Show when={available() === 'private'}>
            <div class="preview-code"><label for="preview-code">Private preview access code</label>
              <input id="preview-code" type="password" autoComplete="off" value={accessCode()} placeholder="Enter access code" onInput={e => setAccessCode(e.currentTarget.value)}/>
              <p>Kept in this tab only, never saved. Required for private AI calls.</p>
            </div>
          </Show>
          <Show when={error()}><div class="api-error" role="alert">{error()}</div></Show>
          <div class="actions">
            <button class="primary" type="submit" disabled={!inputValid() || loading() || available() === 'checking'}>
              {loading() ? '◌  Analyzing…' : available() === 'private' ? '✦  Analyze with AI' : '✦  Review demo'} <span>→</span>
            </button>
            <button class="reset" type="button" disabled={loading()} onClick={reset} aria-label="Clear task">↺</button>
          </div>
          <Show when={available() === 'private'}>
            <button class="secondary-action" type="button" disabled={!inputValid() || loading()} onClick={reviewDemo}>Use demo review instead</button>
          </Show>
          <p class="privacy-note">Live AI review sends task text to Cloudflare Workers AI. Demo review is processed in your browser.</p>
        </form>
      </div>

      <div class="card result-card" aria-live="polite" aria-busy={loading()}>
        <Show when={!loading()} fallback={<div class="empty loading-state"><div class="empty-icon spin">✦</div><h2>Reviewing your task</h2><p>Checking for missing information, ambiguity and contradictions…</p><button class="secondary-action" type="button" onClick={cancelRequest}>Cancel</button></div>}>
          <Show when={result()} fallback={<div class="empty"><div class="empty-icon">✦</div><h2>Clarity starts here.</h2><p>Write a task or load an example. Review the findings and improve your description.</p><div class="empty-features"><div><i class="red"/> Missing details</div><div><i class="amber"/> Unclear requirements</div><div><i class="purple"/> Contradictions & next steps</div></div><span class="note">{available() === 'private' ? 'Private AI preview available' : 'Honest demo, no AI inference'}</span></div>}>
            {a => <>
              <div class="result-top"><div><span class="kicker">ANALYSIS RESULTS</span><h2>{displayStatus(a().status)}</h2><p>{a().summary}</p></div>
                <span class="pill">{a().mode === 'live' ? 'AI review' : a().mode === 'demo' ? 'Prewritten demo' : 'Basic checks'}</span>
              </div>
              <div class="score-box"><div class={a().score === null ? 'no-score' : 'score'}>{a().score === null ? '—' : <><b>{a().score}</b><small>/100</small></>}</div>
                <div><strong>{a().findings.length} finding{a().findings.length === 1 ? '' : 's'}</strong><p>{a().mode === 'live' ? 'Live model response · review findings before applying' :
                  a().mode === 'demo' ? 'Illustrative score and prewritten findings' : 'Simple structural checks, not an AI analysis'}</p></div>
              </div>
              <div class="tabs" role="tablist" aria-label="Result views">
                <button type="button" role="tab" aria-selected={tab() === 'findings'} class={tab() === 'findings' ? 'active' : ''} onClick={() => setTab('findings')}>Findings</button>
                <button type="button" role="tab" aria-selected={tab() === 'draft'} class={tab() === 'draft' ? 'active' : ''} onClick={() => setTab('draft')}>Suggested draft</button>
              </div>
              <Show when={tab() === 'findings'} fallback={<div class="draft"><div class="draft-head"><strong>{a().mode === 'basic' ? 'Structured copy of your input' : 'Suggested rewrite'}</strong><button type="button" onClick={() => void copy()}>{copied() ? '✓ Copied' : '▢ Copy'}</button></div><pre>{a().draft}</pre><p>Verify the rewrite before using it. Unconfirmed details should remain questions.</p></div>}>
                <div class="findings"><Show when={a().findings.length === 0}><div class="no-findings">No issues identified. Verify the task details yourself before proceeding.</div></Show>
                  <For each={a().findings}>{f => <article class="finding"><div class={'finding-icon ' + f.kind}>{f.kind === 'contradiction' ? '↯' : f.kind === 'ambiguity' ? '?' : f.kind === 'missing' ? '!' : 'i'}</div><div class="finding-content">
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
      </div>
    </section>

    <section id="examples" class="examples"><span class="kicker">SEE IT IN ACTION</span><h2>Try an example</h2><p class="section-sub">Start with software, marketing or sales tasks.</p><div class="example-grid"><For each={examples}>{(ex, i) =>
      <button type="button" onClick={() => load(ex.id)} class={'example ' + (selected() === ex.id ? 'selected' : '')}><span class="example-number">0{i() + 1}</span><strong>{ex.label}</strong><p>{ex.task.description}</p><span class="example-link">Load example →</span></button>
    }</For></div></section>

    <section id="guide" class="guide"><span class="kicker">HOW IT WORKS</span><h2>Clarity in three steps.</h2><div class="steps"><div><span>01</span><h3>Describe</h3><p>Enter a title, description, and type. Add context if it matters.</p></div><div><span>02</span><h3>Inspect</h3><p>Review questions, missing details, and possible conflicts.</p></div><div><span>03</span><h3>Refine</h3><p>Copy your improved task into whatever tool your team uses.</p></div></div><p class="disclaimer">AI preview access is restricted. Demo reviews use examples or simple checks; they are not semantic AI analysis.</p></section>
    </main>
    <footer><div><b>IssueLint</b><span>Clear work starts with clear thinking.</span></div><span>No account · No stored tasks · Live reviews processed by Cloudflare AI</span></footer>
  </div>;
}
render(() => <App/>, document.getElementById('root')!);
