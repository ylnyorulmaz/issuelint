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

## Iteration 2 — SayGM transport and shadow mode

- Verified SayGM OpenAI-compatible endpoint: `https://api.saygm.com/v1/chat/completions`.
- Model ID: `deepseek-v4.1-flash-1017`. Confirm catalog availability and account balance before live use.
- `SAYGM_API_KEY` is a Worker secret; never put it in `.env`, GitHub, plaintext variables, logs, or responses.
- `FEEDBACK_VERIFIER_MODE`: `off` (default), `shadow`, `on`. **In Iteration 2, `on` deliberately behaves as `shadow`**: patch application is not yet implemented.
- Shadow requests send the original task and the complete 11-dimension primary assessment to SayGM. No patch is applied to user-visible feedback.
- One request only, default timeout 12 seconds (clamped to 1–30 seconds), no retries, bounded response size, JSON validation using the Iteration 1 contract.
- Any verifier error is isolated from the primary review. The old 2.4 conditional quality gate remains active until Iteration 3 replaces it.
- Logs contain only success/failure category, patch count, latency, and token usage. No prompts, findings, or provider response bodies.
- The health endpoint exposes only configured/not configured and effective `off`/`shadow` mode, not secrets.
- The verifier adds third-party processing of task content. Do not enable shadow or on before updating the privacy disclosure and checking provider data handling terms.
- Run `npm run check:worker`, `npm run test:worker`, and `npm run check` before enabling shadow.

### Cloudflare setup
Set `SAYGM_API_KEY` using the Cloudflare secret manager / `cf` secret command for the `issuelint-dev` Worker, then explicitly set `FEEDBACK_VERIFIER_MODE=shadow` when ready. Leave `off` until a successful provider smoke test and privacy review. Do not switch to `on` expecting patches to affect output before Iteration 3.

### Deployment note
Merging code does not prove the Worker has been deployed. Verify the deployed version, bindings, health endpoint, and actual shadow request separately.

## Iteration 3 — Validated patch application

- `off`: original GPT-OSS 120B + conditional 2.4 gate, no SayGM request.
- `shadow`: SayGM receives task and all eleven primary checks; validated verdict is observed but does not affect user output. Existing 2.4 gate remains active.
- `on`: SayGM receives task and all eleven primary checks; the old conditional gate is **not run**. Only a fully valid verdict is applied. On SayGM error or invalid patch, the validated primary review is returned without a second opinion.
- Actions `KEEP`, `SUPPRESS`, `DOWNGRADE`, `REVISE`, `ADD` are applied atomically, then the existing `parseReviewV2` pipeline re-derives source grounding, deduplication, finding priority, status, summary, and coverage.
- The backend does not let the verifier introduce critical severity or remove/downgrade critical findings. Verifier-added gaps are classified as ambiguity, not independently proven contradiction.
- Rewrite text remains grounded in the primary task and final selected findings; broader editorial repair is Iteration 4.
- Provider response failures are isolated; only coarse usage and error-category telemetry is logged.
- `on` must not be enabled without provider secret, privacy review, and real golden-task comparisons.

### Operational prerequisite
The repository is not automatically linked to Cloudflare Workers Builds. Merging to main does not deploy. Use the repository's `cf deploy` from a checked-out build environment with Cloudflare credentials and installed dependencies; verify Worker settings and deployment ID afterwards. Keep `FEEDBACK_VERIFIER_MODE=off` by default.

## Iteration 4 — Bounded targeted rewrite repair

- When the independent verifier returns a valid, applied patch with `repair_needed=true`, the existing low-reasoning rewrite repair is invoked once, even if the primary rewrite core was otherwise acceptable.
- The repair receives the original task and **final selected findings**, never the verifier's untrusted prose as instructions.
- A repaired rewrite must pass the existing material-improvement and source-grounding checks.
- If the repair fails, a previously valid primary rewrite is retained and assembled with the **final** findings; otherwise the clarification draft is used.
- Blocked contradictions still take priority and produce a clarification draft rather than an ungrounded rewrite.
- No second verifier call or recursive model discussion is introduced. No forced number of findings.
- Rollout remains `off` by default. Shadow/on activation requires provider credentials, evaluation and privacy review.

## Iteration 5 — Evaluation and staged rollout

### Automated regression gates
Run `npm run check` (strict Worker typecheck, Worker unit/integration tests, client tests, frontend build) on every PR and main push through GitHub Actions. The suite now includes verifier contract, transport, patch, primary-review fallback, deterministic contradiction preservation and bounded repair cases. No live SayGM credentials are required for unit tests.

### Human-reviewed golden evaluation
Use `eval/golden.json` as the existing human-authored set. Run `npm run eval:live` against a preview environment using an authorized token and manually compare results in **off**, **shadow**, and **on**. Keep identical tasks and model parameters. Review false positives on atomic tasks, hidden contradiction recall, duplicate/root-cause findings, rewrite grounding, latency and per-call cost. Golden expected dimensions are guidance, not a forced finding quota.

### Rollout procedure
1. Keep `FEEDBACK_VERIFIER_MODE=off` until CI is green and the production Worker is deployed.
2. Provision `SAYGM_API_KEY` as a Worker secret; confirm provider model access and third-party data-processing disclosure.
3. Set `shadow` and sample representative reviews. Validate provider response rate, patch validity, token usage and added latency without changing visible output.
4. Compare reviewed outputs offline; only then enable `on` for a controlled, explicitly authorized pilot. **No percentage rollout is implemented yet**: `on` affects all requests to that Worker.
5. Roll back immediately to `off` for malformed responses, degraded quality, unexpectedly high costs or latency.

### Exit criteria
Do not claim a release is production-verified without green CI, real provider smoke test, documented golden comparison, deployment version confirmation and a successful end-to-end request. Unit tests alone do not establish semantic accuracy.
