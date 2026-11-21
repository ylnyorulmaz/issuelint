import { For, Show } from 'solid-js';
import type { ApiDecisionResult, DecisionDimension } from '../api';
import { presentDecisionGate, type GateMark } from '../decision-presentation';

const GATE_INFO: Record<DecisionDimension, { title: string; description: string }> = {
  contradictions: {title:'Contradictions',description:'Conflicting instructions or requirements'},
  actionability: {title:'Actionability',description:'Can the assignee start without critical unanswered decisions?'},
  scope: {title:'Scope',description:'Are affected boundaries and deliverables defined?'},
  granularity: {title:'Granularity',description:'Is this one cohesive, manageable piece of work?'},
  behavior: {title:'Behavior',description:'Is the expected behavior clear?'},
  completion: {title:'Completion',description:'Can you recognize when the task is done?'},
  outcome: {title:'Outcome',description:'Is the desired result clear?'},
  references: {title:'References',description:'Are required referenced artifacts locatable?'},
  dependencies: {title:'Dependencies',description:'Are relevant prerequisites workable?'},
  clarity: {title:'Clarity',description:'Can the task be interpreted without material ambiguity?'},
  feasibility: {title:'Feasibility',description:'Are there independent feasibility blockers?'},
};
const SYMBOLS: Record<GateMark,string>={pass:'✓',issue:'✕',unverified:'?',not_applicable:'—'};
const NAMES: Record<GateMark,string>={
  pass:'No material issue identified',
  issue:'Needs attention',
  unverified:'Independent review unavailable',
  not_applicable:'Not applicable',
};
const percent=(p:number)=>Math.round(p*100)+'%';

export function DecisionScorecard(props: { data: ApiDecisionResult }) {
  const issueCount=()=>props.data.audit.checks.filter(x=>x.assessment==='gap').length;
  return <section class="decision-scorecard decision-compact" aria-label="Decision model review scorecard">
    <div class="result-top">
      <div>
        <span class="kicker">DECISION ENGINE · EXPERIMENTAL</span>
        <div class="decision-score-heading">
          <h2>11 quality checks</h2>
          <details class="decision-score-help">
            <summary aria-label="Explain percentages and status icons" title="How to read the score">?</summary>
            <div class="decision-score-tooltip" role="note">
              <p><strong>%</strong> Gemini's P(Clear), not a task grade.</p>
              <p><strong>✓ / ✕</strong> No issue / issue found. Below 85%, GPT-OSS reviews independently and may disagree with Gemini (e.g. 63% ✓). At 85% or above, ✓ reflects Gemini screening only.</p>
              <p><strong>? / —</strong> Not verified / not applicable.</p>
            </div>
          </details>
        </div>
        <p>Gemini screens each dimension. GPT-OSS independently audits those below 85% Clear probability. Expand any row for its explanation.</p>
      </div>
      <span class="pill">Decision v2</span>
    </div>
    <div class="decision-compact-meta">
      <span>{props.data.checked} checks · {(props.data.durationMs/1000).toFixed(2)}s Gemini</span>
      <span>{props.data.audit.selected.length} GPT-OSS selected · {(props.data.audit.durationMs/1000).toFixed(1)}s audit</span>
      <Show when={issueCount()>0}><strong>{issueCount()} issue gate(s)</strong></Show>
    </div>
    <div class="decision-compact-list" aria-label="Eleven review dimensions">
      <For each={props.data.gates}>{(gate,idx)=>{
        const review=props.data.audit.checks.find(c=>c.dimension===gate.dimension);
        const result=presentDecisionGate(gate,props.data.audit);
        const info=GATE_INFO[gate.dimension];
        return <details class={'decision-compact-gate decision-compact-'+result.mark}>
          <summary class="decision-compact-row">
            <span class="decision-compact-index">{String(idx()+1).padStart(2,'0')}</span>
            <span class="decision-compact-name">
              <strong>{info.title}</strong>
              <Show when={result.mark==='issue' && review?.title}>
                <span class="decision-compact-snippet">{review?.title}</span>
              </Show>
              <Show when={result.mark==='unverified'}>
                <span class="decision-compact-snippet">Review could not be verified</span>
              </Show>
            </span>
            <span class="decision-compact-percent" title="Gemini Clear probability, not a correctness score">{percent(gate.probabilities.clear)}</span>
            <span class={'decision-compact-mark '+result.mark} role="img"
              aria-label={NAMES[result.mark]} title={NAMES[result.mark]+(result.source==='gemini'?' · Gemini screening only':result.source==='gpt-oss'?' · GPT-OSS audited':'')}>{SYMBOLS[result.mark]}</span>
            <span class="decision-compact-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="decision-compact-detail">
            <p class="decision-compact-description">{info.description}</p>
            <Show when={review} fallback={<p>{result.mark==='unverified'
              ? 'The independent GPT-OSS audit was selected but could not be verified. This dimension is not marked clear.'
              : 'Gemini screening only. No independent GPT-OSS review was performed for this dimension.'}</p>}>
              {checked=><>
                <p class="decision-compact-source">GPT-OSS independent review</p>
                <p>{checked().reason}</p>
                <Show when={checked().evidence.length}>
                  <div class="decision-audit-evidence"><b>Source evidence</b>
                    <For each={checked().evidence}>{quote=><q>{quote}</q>}</For>
                  </div>
                </Show>
                <Show when={checked().question}><p class="decision-audit-question"><b>Clarify:</b> {checked().question}</p></Show>
              </>}
            </Show>
          </div>
        </details>;
      }}</For>
    </div>
    <Show when={props.data.audit.findings.length>0}>
      <details class="decision-compact-prioritized">
        <summary>Prioritized issues ({props.data.audit.findings.length}) <span aria-hidden="true">⌄</span></summary>
        <For each={props.data.audit.findings}>{finding=>
          <div class="decision-prioritized-item">
            <strong>{finding.title}</strong><span>{finding.severity}</span>
            <p>{finding.detail}</p>
            <Show when={finding.question}><p><b>Clarify:</b> {finding.question}</p></Show>
          </div>
        }</For>
      </details>
    </Show>
    <Show when={props.data.audit.status!=='complete'}>
      <p class="decision-compact-warning" role="status">Some GPT-OSS checks were not verified. A question mark is not a pass; retry for complete results.</p>
    </Show>
    <p class="decision-compact-note">✓ No issue found · ✕ Needs attention · ? Not verified · — Not applicable. The percentage is Gemini P(Clear), not verified confidence or an overall quality score. Gemini-only screening is not independently audited.</p>
  </section>;
}
