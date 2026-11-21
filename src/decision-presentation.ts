import type { ApiDecisionAudit, DecisionGate } from './api';

export type GateMark = 'pass' | 'issue' | 'unverified' | 'not_applicable';
export type GatePresentation = { mark: GateMark; source: 'gpt-oss' | 'gemini' | 'unverified' };

/** GPT-OSS source-validated results take priority; P(Clear) is only a routing signal. */
export function presentDecisionGate(gate: DecisionGate, audit: ApiDecisionAudit): GatePresentation {
  const reviewed = audit.checks.find(c => c.dimension === gate.dimension);
  if (reviewed) return {
    mark: reviewed.assessment === 'gap' ? 'issue' :
      reviewed.assessment === 'clear' ? 'pass' : 'not_applicable',
    source: 'gpt-oss',
  };
  if (audit.selected.includes(gate.dimension)) return { mark: 'unverified', source: 'unverified' };
  if (gate.assessment === 'not_applicable') return { mark: 'not_applicable', source: 'gemini' };
  if (gate.assessment === 'clear' && gate.probabilities.clear >= audit.threshold)
    return { mark: 'pass', source: 'gemini' };
  return { mark: 'unverified', source: 'unverified' };
}
