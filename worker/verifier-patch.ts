import { parseVerifierVerdict, type VerifierVerdict } from "./feedback-verifier.ts";
import { parseReviewV2, type ReviewCheck } from "./review-v2.ts";
import type { Task } from "./schema.ts";

/**
 * Apply a verified, atomic patch to the full eleven-dimensional assessment.
 * Final findings, severity, summary and status are ALWAYS derived by parseReviewV2.
 */
export function applyVerifierVerdict(task: Task, checks: readonly ReviewCheck[], verdict: VerifierVerdict): ReviewCheck[] {
  const verified = parseVerifierVerdict(verdict, task, checks);
  const next = checks.map(c => ({ ...c, evidence: [...c.evidence] }));
  for (const patch of verified.verdicts) {
    const c = next.find(x => x.dimension === patch.dimension);
    if (!c) throw Error("Missing check");
    switch (patch.action) {
      case "KEEP": break;
      case "SUPPRESS":
        c.assessment = "clear";
        c.title = ""; c.detail = ""; c.question = ""; c.evidence = [];
        break;
      case "DOWNGRADE":
        c.severity = "suggestion";
        break;
      case "REVISE":
        c.title = patch.title!;
        c.detail = patch.detail!;
        c.question = patch.question!;
        c.evidence = [...patch.evidence!];
        break;
      case "ADD":
        // A newly inferred contradiction is not independently proven by one
        // verifier; it cannot bypass the existing two-excerpt contradiction guard.
        c.assessment = "gap";
        c.kind = "ambiguity";
        c.severity = patch.severity!;
        c.title = patch.title!;
        c.detail = patch.detail!;
        c.question = patch.question!;
        c.evidence = [...patch.evidence!];
        break;
    }
  }
  return next;
}

/** Reuse the same authoritative parser used by the primary model. */
export function verifyPatchedReview(
  original: Record<string, unknown>, task: Task, checks: readonly ReviewCheck[], verdict: VerifierVerdict,
) {
  const next = applyVerifierVerdict(task, checks, verdict);
  return parseReviewV2({ ...original, checks: next }, task);
}
