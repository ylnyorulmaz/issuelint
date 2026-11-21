# IssueLint 2.5 — Iteration 1: Feedback verifier contract

## Scope
This iteration defines the **contract only**. It does not call SayGM, change the current 2.4 quality gate, alter user-visible feedback, or deploy a new Worker.

## Planned pipeline
Primary GPT-OSS 120B review → existing deterministic checks → independent DeepSeek V4.1 Flash 1017 verifier (SayGM) → validated patch → at most one targeted repair → final deterministic validation.

The old conditional quality gate will be replaced when the new pipeline is enabled, not stacked on top.

## Patch policy
- Exactly one action per review dimension, at most 11 actions; zero actions is valid.
- KEEP: preserve existing assessment.
- SUPPRESS: remove a noncritical gap only.
- DOWNGRADE: only important → suggestion; never critical.
- REVISE: revise wording/question/evidence of an existing gap without changing severity.
- ADD: introduce a noncritical gap only where the primary reviewer did not already report a gap.
- Evidence must be literal substrings of the submitted task; no invented source quotes.
- Reject malformed/unknown fields, duplicate dimensions and exact duplicate clarification questions.
- Validation is atomic. A malformed response is discarded rather than partially applied.
- This contract cannot prove semantic correctness of an inference; that requires independent evaluation and additional deterministic guards.
- Critical contradiction removal and downgrades are forbidden, including when the verifier disagrees.

## Next iterations
2. SayGM client, Worker secret, timeouts, feature flags off/shadow/on, and provider-failure fallback.
3. Independent verifier prompt, complete 11-dimension context, safe patch application, and replacement of old gate.
4. Targeted repair, final status/summary/rewrite recomputation, editorial polish.
5. Human-reviewed golden and adversarial evaluations, shadow comparison, controlled Cloudflare rollout.

## Verification
Run `npm run check:worker` and `npm run test:worker`. This iteration adds `test/feedback-verifier.test.mjs` to the worker test suite.

## Data protection
Task content is sensitive user-provided text. No third-party provider request is made by Iteration 1. Later iterations must disclose SayGM processing, store credentials as Cloudflare secrets, avoid logging task content, and enforce timeouts and fail-open-to-validated-primary behavior.
