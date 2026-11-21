import { For } from 'solid-js';
import type { ApiQuickScanResult, DecisionDimension } from '../api';

const LABELS: Record<DecisionDimension,string> = {
  contradictions:'Contradictions',
  actionability:'Actionability',
  scope:'Scope',
  granularity:'Granularity',
  behavior:'Behavior',
  completion:'Completion',
  outcome:'Outcome',
  references:'References',
  dependencies:'Dependencies',
  clarity:'Clarity',
  feasibility:'Feasibility',
};

/** Short Gemini-only screen. Not an independently audited full review. */
export function QuickScanScorecard(props: {data:ApiQuickScanResult}) {
  const flagged=()=>props.data.gates.filter(g=>g.assessment==='gap').length;
  return <section class="quick-scorecard" aria-label="Quick Scan result">
    <div class="result-top">
      <div>
        <span class="kicker">QUICK SCAN · GEMINI</span>
        <h2>11 quality checks</h2>
        <p>{flagged()===0 ? 'No issues flagged in this quick screen.' :
          flagged()+' dimension'+(flagged()===1?'':'s')+' flagged for attention.'}</p>
      </div>
      <span class="pill">Quick Scan</span>
    </div>
    <ol class="quick-scan-list" aria-label="Gemini screening checklist">
      <For each={props.data.gates}>{(gate,index)=>
        <li class="quick-scan-row">
          <span class="quick-scan-index">{String(index()+1).padStart(2,'0')}</span>
          <strong>{LABELS[gate.dimension]}</strong>
          <span class={'quick-scan-mark '+(gate.assessment==='gap'?'issue':'pass')}
            role="img" aria-label={gate.assessment==='gap'?'Potential issue':
              gate.assessment==='not_applicable'?'Not applicable — no issue flagged':'No issue flagged'}>
            {gate.assessment==='gap'?'✕':'✓'}
          </span>
        </li>
      }</For>
    </ol>
    <p class="quick-scan-note">Preliminary Gemini-only screening, not an independent audit. ✓ means no issue flagged or not applicable; ✕ means a potential issue. Use Analyze v2 for evidence and explanations.</p>
  </section>;
}
