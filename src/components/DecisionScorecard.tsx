import { For, Show } from 'solid-js';
import type { ApiDecisionResult, DecisionDimension, DecisionAssessment } from '../api';

const GATE_INFO: Record<DecisionDimension, {title:string; description:string}> = {
  contradictions: {title:'Contradictions',description:'Conflicting instructions, recipients or deadlines'},
  actionability: {title:'Actionability',description:'Can the assignee start without critical unanswered decisions?'},
  scope: {title:'Scope',description:'Are affected screens, platforms, users and deliverables defined?'},
  granularity: {title:'Granularity',description:'Is this one cohesive, manageable piece of work?'},
  behavior: {title:'Behavior',description:'Are required interactions and business rules understandable?'},
  completion: {title:'Completion',description:'Can completion be recognized without inventing extra criteria?'},
  outcome: {title:'Outcome',description:'Is the desired changed state or result clear?'},
  references: {title:'References',description:'Are required Figma files, docs and other artifacts accessible?'},
  dependencies: {title:'Dependencies',description:'Are approvals, sequencing and prerequisites workable?'},
  clarity: {title:'Clarity',description:'Can the task be interpreted without material ambiguity?'},
  feasibility: {title:'Feasibility',description:'Are there source-supported implementation blockers?'},
};
const labels: Record<DecisionAssessment,string> = {
  clear:'Clear',gap:'Gap',not_applicable:'N/A',
};
function percentage(p:number) { return Math.round(p*100) + '%'; }
export function DecisionScorecard(props: {data:ApiDecisionResult}) {
  const count = (value:DecisionAssessment) => props.data.gates.filter(x=>x.assessment===value).length;
  return <section class="decision-scorecard" aria-label="Gemini Decision 1 gate scorecard">
    <div class="result-top">
      <div>
        <span class="kicker">DECISION ENGINE · EXPERIMENTAL</span>
        <h2>11 Gate Scorecard</h2>
        <p>Gemini screens all 11 gates; GPT-OSS 120B independently explains only those with Clear probability below 85%. No Gemini scores reach the auditor.</p>
      </div>
      <span class="pill">Decision v2</span>
    </div>
    <div class="decision-overview">
      <div><strong>{count('gap')}</strong><small>Potential gaps</small></div>
      <div><strong>{count('clear')}</strong><small>Clear</small></div>
      <div><strong>{count('not_applicable')}</strong><small>Not applicable</small></div>
    </div>
    <p class="decision-meta">{props.data.checked} Gemini checks · {(props.data.durationMs / 1000).toFixed(2)} s Gemini call</p>
    <div class="decision-audit-overview" role="status">
      <strong>Independent GPT-OSS audit · P(Clear) below 85%</strong>
      <p>{props.data.audit.selected.length} of 11 gates selected · {props.data.audit.status==='complete'
        ? props.data.audit.selected.length===0
          ? 'No second call needed'
          : props.data.audit.findings.length+' prioritized issue(s) · '+(props.data.audit.durationMs/1000).toFixed(2)+' s'
        : 'Review unavailable — Gemini classification only'}</p>
      <Show when={props.data.audit.status==='unavailable'}>
        <p class="decision-audit-warning">GPT-OSS verification did not complete. The Gemini decisions below are unverified; please retry. No reviewer results have been fabricated.</p>
      </Show>
    </div>
    <div class="decision-gates">
      <For each={props.data.gates}>{(gate,idx) =>
        <article class="decision-gate">
          <div class="decision-gate-head">
            <div class="decision-gate-title">
              <span class="decision-gate-number">{String(idx()+1).padStart(2,'0')}</span>
              <strong>{GATE_INFO[gate.dimension].title}</strong>
            </div>
            <span class={'decision-gate-outcome '+gate.assessment}>{labels[gate.assessment]}</span>
          </div>
          <p>{GATE_INFO[gate.dimension].description}</p>
          <div class="decision-gate-confidence">
            <span>Chosen answer confidence</span>
            <strong>{percentage(gate.confidence)}</strong>
          </div>
          <div class="decision-probabilities" aria-label={'Probabilities for '+GATE_INFO[gate.dimension].title}>
            <For each={(['clear','gap','not_applicable'] as const)}>{option =>
              <div class="decision-probability">
                <span>{labels[option]}</span>
                <div class="decision-prob-track" aria-hidden="true">
                  <span class={'decision-prob-fill '+option} style={{width:percentage(gate.probabilities[option])}}/>
                </div>
                <span>{percentage(gate.probabilities[option])}</span>
              </div>
            }</For>
          </div>
          <Show when={props.data.audit.checks.find(c=>c.dimension===gate.dimension)} fallback={
            <Show when={props.data.audit.status==='complete'}>
              <p class="decision-skipped">No GPT-OSS review · P(Clear) ≥ 85%</p>
            </Show>
          }>
            {review=><section class="decision-reviewed" aria-label={'Independent audit: '+GATE_INFO[gate.dimension].title}>
              <div class="decision-reviewed-head">
                <strong>GPT-OSS independent review</strong>
                <span class={'decision-gate-outcome '+review().assessment}>{labels[review().assessment]}</span>
              </div>
              <p>{review().reason}</p>
              <Show when={review().evidence.length}>
                <div class="decision-audit-evidence"><b>Source evidence</b>
                  <For each={review().evidence}>{quote=><q>{quote}</q>}</For>
                </div>
              </Show>
              <Show when={review().question}>
                <div class="decision-audit-question"><b>Clarify:</b> {review().question}</div>
              </Show>
            </section>}
          </Show>
        </article>
      }</For>
    </div>
    <Show when={props.data.audit.findings.length>0}>
      <section class="decision-prioritized" aria-label="Prioritized findings">
        <h3>Prioritized findings ({props.data.audit.findings.length})</h3>
        <For each={props.data.audit.findings}>{finding=>
          <div class="decision-prioritized-item">
            <strong>{finding.title}</strong>
            <span>{finding.severity}</span>
            <p>{finding.detail}</p>
            <Show when={finding.question}><p><b>Clarify:</b> {finding.question}</p></Show>
          </div>
        }</For>
      </section>
    </Show>
    <p class="decision-disclaimer">Gemini probabilities are routing signals, not verified confidence or evidence. GPT-OSS never receives Gemini scores or assessments. Each audited result includes a model-generated reason; quotations are checked against submitted task text. Skipped gates were not independently reviewed. No suggested rewrite in this iteration.</p>
  </section>;
}
