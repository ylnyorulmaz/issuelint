import { For } from 'solid-js';
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
        <p>One Gemini Decision 1 call. Probability-based classifications only — no explanation or rewrite in Iteration 1.</p>
      </div>
      <span class="pill">Decision v2</span>
    </div>
    <div class="decision-overview">
      <div><strong>{count('gap')}</strong><small>Potential gaps</small></div>
      <div><strong>{count('clear')}</strong><small>Clear</small></div>
      <div><strong>{count('not_applicable')}</strong><small>Not applicable</small></div>
    </div>
    <p class="decision-meta">{props.data.checked} checks · {props.data.model} · {(props.data.durationMs / 1000).toFixed(2)} s provider call</p>
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
        </article>
      }</For>
    </div>
    <p class="decision-disclaimer">These are model classifications, not independently verified findings. The displayed probabilities are not evidence that a requirement is missing. Explanations, source quotations and Suggested Draft belong to Iteration 2.</p>
  </section>;
}
