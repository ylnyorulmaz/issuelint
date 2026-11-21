import { taskSource, type Task } from "./schema.ts";
import { REVIEW_DIMENSIONS, type ReviewDimension, type ReviewCheck } from "./review-v2.ts";

/**
 * IssueLint 2.5, Iteration 1: verifier contract only.
 * This module deliberately does not invoke an LLM or mutate primary review output.
 */
export const VERIFIER_ACTIONS = ["KEEP", "SUPPRESS", "DOWNGRADE", "REVISE", "ADD"] as const;
export type VerifierAction = typeof VERIFIER_ACTIONS[number];
export type VerifierPatch = {
  dimension: ReviewDimension;
  action: VerifierAction;
  reason: string;
  severity?: "important" | "suggestion";
  title?: string;
  detail?: string;
  question?: string;
  evidence?: string[];
};
export type VerifierVerdict = { verdicts: VerifierPatch[]; repair_needed: boolean };

export const FEEDBACK_VERIFIER_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    verdicts: {
      type: "array", maxItems: 11,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          dimension: { type: "string", enum: REVIEW_DIMENSIONS },
          action: { type: "string", enum: VERIFIER_ACTIONS },
          reason: { type: "string" },
          severity: { type: "string", enum: ["important", "suggestion"] },
          title: { type: "string" },
          detail: { type: "string" },
          question: { type: "string" },
          evidence: { type: "array", maxItems: 2, items: { type: "string" } },
        },
        required: ["dimension", "action", "reason"],
      },
    },
    repair_needed: { type: "boolean" },
  },
  required: ["verdicts", "repair_needed"],
} as const;

export class VerifierContractError extends Error {
  constructor(message: string) { super(message); this.name = "VerifierContractError"; }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
}
function literalEvidence(task: Task, quote: string): boolean {
  const source = taskSource(task).replace(/\s+/g, " ").toLocaleLowerCase();
  return source.includes(quote.replace(/\s+/g, " ").toLocaleLowerCase().trim());
}
function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max)
    throw new VerifierContractError("Invalid " + field);
  return value.trim();
}

/**
 * Fail closed on malformed or unauthorized patches. Validation is atomic:
 * callers must never apply a partially validated response.
 * A later iteration will implement safe patch application and final recomputation.
 */
export function parseVerifierVerdict(raw: unknown, task: Task, checks: readonly ReviewCheck[]): VerifierVerdict {
  if (!object(raw) || Object.keys(raw).some(k => !["verdicts", "repair_needed"].includes(k)) ||
      !Array.isArray(raw.verdicts) || raw.verdicts.length > 11 || typeof raw.repair_needed !== "boolean")
    throw new VerifierContractError("Invalid verifier response");
  const seen = new Set<string>();
  const existingQuestions = new Set(checks.filter(c => c.assessment === "gap").map(c => normalized(c.question)).filter(Boolean));
  const verdicts: VerifierPatch[] = [];
  for (const value of raw.verdicts) {
    if (!object(value) || Object.keys(value).some(k => !["dimension","action","reason","severity","title","detail","question","evidence"].includes(k)))
      throw new VerifierContractError("Unexpected patch field");
    if (!REVIEW_DIMENSIONS.includes(value.dimension as ReviewDimension) ||
        !VERIFIER_ACTIONS.includes(value.action as VerifierAction))
      throw new VerifierContractError("Invalid dimension or action");
    const dimension = value.dimension as ReviewDimension;
    const action = value.action as VerifierAction;
    if (seen.has(dimension)) throw new VerifierContractError("Multiple patches for one dimension");
    seen.add(dimension);
    const check = checks.find(c => c.dimension === dimension);
    if (!check) throw new VerifierContractError("Unknown primary check");
    const reason = boundedText(value.reason, "reason", 12, 600);
    const patch: VerifierPatch = { dimension, action, reason };
    if (action === "SUPPRESS" || action === "DOWNGRADE" || action === "REVISE") {
      if (check.assessment !== "gap") throw new VerifierContractError("Cannot change an absent finding");
      if (check.severity === "critical" && (action === "SUPPRESS" || action === "DOWNGRADE" || action === "REVISE"))
        throw new VerifierContractError("Critical finding cannot be modified by verifier");
    }
    if (action === "ADD" && check.assessment === "gap")
      throw new VerifierContractError("ADD cannot overwrite an existing gap");
    if (action === "DOWNGRADE") {
      if (value.severity !== "suggestion" || check.severity !== "important")
        throw new VerifierContractError("Only important to suggestion downgrade is allowed");
      patch.severity = "suggestion";
    }
    if (action === "ADD" || action === "REVISE") {
      patch.title = boundedText(value.title, "title", 8, 160);
      patch.detail = boundedText(value.detail, "detail", 25, 800);
      patch.question = boundedText(value.question, "question", 12, 300);
      if (!Array.isArray(value.evidence) || value.evidence.length > 2 ||
          value.evidence.some(q => typeof q !== "string" || !q.trim() || q.length > 260 || !literalEvidence(task, q)))
        throw new VerifierContractError("Invalid or fabricated evidence");
      patch.evidence = [...value.evidence] as string[];
      if (action === "ADD") {
        if (value.severity !== "important" && value.severity !== "suggestion")
          throw new VerifierContractError("New finding requires noncritical severity");
        patch.severity = value.severity;
        const q = normalized(patch.question);
        if (existingQuestions.has(q)) throw new VerifierContractError("Duplicate clarification question");
        existingQuestions.add(q);
      } else if (value.severity !== undefined) {
        throw new VerifierContractError("REVISE cannot change severity");
      }
    }
    const permitted = action === "DOWNGRADE" ? ["dimension","action","reason","severity"] :
      action === "ADD" ? ["dimension","action","reason","severity","title","detail","question","evidence"] :
      action === "REVISE" ? ["dimension","action","reason","title","detail","question","evidence"] :
      ["dimension","action","reason"];
    if (Object.keys(value).some(k => !permitted.includes(k)))
      throw new VerifierContractError("Fields not permitted for action " + action);
    verdicts.push(patch);
  }
  return { verdicts, repair_needed: raw.repair_needed };
}
