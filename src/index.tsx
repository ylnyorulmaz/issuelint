import {createSignal,For,Show} from 'solid-js';
import {render} from 'solid-js/web';
import {analyze,blank,examples,type Analysis,type Task,type Domain,type TaskType} from './analyzer';
import './style.css';
const types:TaskType[]=['General','Bug','Feature','Improvement','Request'];
const domains:Domain[]=['Software','Marketing','Sales','Operations','Other'];
function App(){
 const [task,setTask]=createSignal<Task>(blank());
 const [result,setResult]=createSignal<Analysis|null>(null);
 const [details,setDetails]=createSignal(false);
 const [tab,setTab]=createSignal<'findings'|'draft'>('findings');
 const [selected,setSelected]=createSignal<string|null>(null);
 const [copied,setCopied]=createSignal(false);
 const [dark,setDark]=createSignal(window.matchMedia?.('(prefers-color-scheme: dark)').matches??false);
 const edit=<K extends keyof Task>(key:K,value:Task[K])=>{setTask(t=>({...t,[key]:value}));setResult(null);setSelected(null);setCopied(false)};
 const load=(id:string)=>{const example=examples.find(e=>e.id===id);if(!example)return;setTask({...example.task});setResult(null);setTab('findings');setSelected(id);setCopied(false);document.getElementById('analyze')?.scrollIntoView({behavior:'smooth',block:'start'})};
 const reset=()=>{setTask(blank());setResult(null);setSelected(null);setDetails(false);setCopied(false)};
 const copy=async()=>{if(!result())return;try{await navigator.clipboard.writeText(result()!.draft);setCopied(true)}catch{setCopied(false)}};
 return <div class="app" data-theme={dark()?'dark':'light'}>
 <header class="header"><div class="header-inner"><a class="brand" href="#top"><span class="logo">✓</span><span>Issue<b>Lint</b></span></a><nav aria-label="Primary"><a href="#analyze" class="nav-current">Analyze</a><a href="#examples">Examples</a><a href="#guide">How it works</a></nav><div class="header-right"><span class="version">v0.1 prototype</span><button class="theme" type="button" onClick={()=>setDark(!dark())} aria-label={dark()?'Switch to light mode':'Switch to dark mode'}>{dark()?'☀':'☾'}</button></div></div></header>
 <main id="top"><section class="hero"><div class="eyebrow"><span class="dot"/> CLEAR WORK STARTS HERE</div><h1>Make every task <em>clear.</em></h1><p>Turn vague requests into actionable work. Spot what's missing, unclear, or contradictory before anyone gets started.</p><div class="hero-meta">Any team <span>·</span> Any task <span>·</span> No integrations</div></section>
 <section id="analyze" class="workspace" aria-label="Task analyzer">
 <div class="card input-card"><div class="card-intro"><span class="intro-icon">✎</span><div><h2>Describe your task</h2><p>A few details are enough to get started.</p></div></div>
 <form onSubmit={e=>{e.preventDefault();setResult(analyze(task()));setTab('findings');setCopied(false)}}>
 <label for="title">Task title <span class="req">*</span></label><input id="title" value={task().title} required maxlength="180" placeholder="What needs to be done?" onInput={e=>edit('title',e.currentTarget.value)}/>
 <label for="description">Description <span class="req">*</span></label><textarea id="description" required rows="7" placeholder="Describe the problem, goal, or requested work. It doesn't need to be perfect." value={task().description} onInput={e=>edit('description',e.currentTarget.value)}/>
 <div class="form-grid"><div><label for="type">Task type</label><select id="type" value={task().type} onChange={e=>edit('type',e.currentTarget.value as TaskType)}><For each={types}>{t=><option>{t}</option>}</For></select></div><div><label for="domain">Area</label><select id="domain" value={task().domain} onChange={e=>edit('domain',e.currentTarget.value as Domain)}><For each={domains}>{d=><option>{d}</option>}</For></select></div></div>
 <button type="button" class="disclosure" aria-expanded={details()} onClick={()=>setDetails(!details())}><span><b>Additional details</b><small>Optional completion criteria and context</small></span><span class="plus">{details()?'−':'+'}</span></button>
 <Show when={details()}><div class="extra"><label for="criteria">Completion / acceptance criteria</label><textarea id="criteria" rows="3" placeholder="How will someone know this task is done?" value={task().criteria} onInput={e=>edit('criteria',e.currentTarget.value)}/><label for="context">Constraints and context</label><textarea id="context" rows="3" placeholder="Dependencies, deadlines, or other relevant information..." value={task().context} onInput={e=>edit('context',e.currentTarget.value)}/></div></Show>
 <div class="actions"><button class="primary" type="submit" disabled={!task().title.trim()||!task().description.trim()}>✦ &nbsp; Analyze task <span>→</span></button><button class="reset" type="button" onClick={reset} aria-label="Clear task">↺</button></div>
 </form></div>
 <div class="card result-card" aria-live="polite"><Show when={result()} fallback={<div class="empty"><div class="empty-icon">✦</div><h2>Clarity starts here.</h2><p>Write a task or load an example, then analyze it to see what needs attention.</p><div class="empty-features"><div><i class="red"/> Missing details</div><div><i class="amber"/> Unclear requirements</div><div><i class="purple"/> Contradictions & next steps</div></div><span class="note">Frontend prototype — no AI connected</span></div>}>
 {a=><><div class="result-top"><div><span class="kicker">ANALYSIS RESULTS</span><h2>{a().score===null?'Structural review':'Needs clarification'}</h2><p>{a().summary}</p></div><span class="pill">{a().mode==='demo'?'Demo scenario':'Basic checks'}</span></div>
 <div class="score-box"><div class={a().score===null?'no-score':'score'}>{a().score===null?'—':<><b>{a().score}</b><small>/100</small></>}</div><div><strong>{a().findings.length} finding{a().findings.length===1?'':'s'}</strong><p>{a().mode==='demo'?'Prewritten example — not live AI feedback':'No AI or semantic analysis performed'}</p></div></div>
 <div class="tabs" role="tablist" aria-label="Result views"><button type="button" role="tab" aria-selected={tab()==='findings'} class={tab()==='findings'?'active':''} onClick={()=>setTab('findings')}>Findings</button><button type="button" role="tab" aria-selected={tab()==='draft'} class={tab()==='draft'?'active':''} onClick={()=>setTab('draft')}>Suggested draft</button></div>
 <Show when={tab()==='findings'} fallback={<div class="draft"><div class="draft-head"><strong>{a().mode==='demo'?'Illustrative rewrite':'Structured copy of your input'}</strong><button type="button" onClick={copy}>{copied()?'✓ Copied':'▢ Copy'}</button></div><pre>{a().draft}</pre><p>{a().mode==='demo'?'Unknown details are left as open questions.':'This is not an AI rewrite. Your text is preserved.'}</p></div>}>
 <div class="findings"><For each={a().findings}>{f=><article class="finding"><div class={'finding-icon '+f.kind}>{f.kind==='contradiction'?'↯':f.kind==='ambiguity'?'?':f.kind==='missing'?'!':'i'}</div><div class="finding-content"><span class={'kind '+f.kind}>{f.kind}</span><h3>{f.title}</h3><p>{f.detail}</p><Show when={f.question}><div class="question"><b>Clarify:</b> {f.question}</div></Show></div></article>}</For></div><button type="button" class="draft-link" onClick={()=>setTab('draft')}>View suggested draft →</button></Show>
 <p class="disclaimer">{a().mode==='demo'?'This example is prewritten. Editing it switches to basic checks.':'Simple pattern checks cannot detect real contradictions or judge task quality.'}</p></>}
 </Show></div></section>
 <section id="examples" class="examples"><span class="kicker">SEE IT IN ACTION</span><h2>Try an example</h2><p class="section-sub">Explore the experience with three different types of work.</p><div class="example-grid"><For each={examples}>{(ex,i)=><button type="button" onClick={()=>load(ex.id)} class={'example '+(selected()===ex.id?'selected':'')}><span class="example-number">0{i()+1}</span><strong>{ex.label}</strong><p>{ex.task.description}</p><span class="example-link">Load example →</span></button>}</For></div></section>
 <section id="guide" class="guide"><span class="kicker">HOW IT WORKS</span><h2>Clarity in three steps.</h2><div class="steps"><div><span>01</span><h3>Describe</h3><p>Enter a title, description, and task type. Add context if useful.</p></div><div><span>02</span><h3>Inspect</h3><p>Find the questions that matter before starting work.</p></div><div><span>03</span><h3>Refine</h3><p>Copy your draft to whichever platform your team uses.</p></div></div><p class="disclaimer">Prototype only: demo evaluations are prewritten, and arbitrary input gets basic structural checks. Semantic AI review is not implemented.</p></section></main>
 <footer><div><b>IssueLint</b><span>Clear work starts with clear thinking.</span></div><span>Static frontend · No account · No data sent</span></footer>
 </div>;
}
render(()=><App/>,document.getElementById('root')!);
