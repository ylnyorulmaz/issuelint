# Claude instructions — IssueLint

This file supplements [AGENTS.md](AGENTS.md). **Read AGENTS.md first**; it is the repository-wide agent contract. See [README.md](README.md) for current architecture, live-versus-source status, API, scripts and Cloudflare deployment.

## Before editing

- Work from the current `main` tree; do not trust prior conversation summaries or an old deployed Worker as a substitute for reading code.
- Identify which interface or invariant a proposed change touches, then read its implementation **and relevant tests**.
- Prefer focused changes and explain their effect on privacy, cost, false positives, latency and backward compatibility.
- Preserve the paste-first task flow, optional structured input, three themes and the private preview gate unless explicitly tasked otherwise.

## Implementation rules

- Use SolidJS/TypeScript for the UI, native Cloudflare Workers AI and the existing `cf` CLI/configuration.
- Keep the **eleven-dimensional** audit and source-grounded contradictions. The output is task-specific and must not impose arbitrary acceptance criteria or numeric success metrics on simple tasks.
- The verifier has three modes: `off`, `shadow`, `on`. Do not apply shadow patches, stack the old quality gate in on mode, bypass atomic patch validation, or add recursive model-call loops.
- Never invent task facts, confirmed references or approval. An unresolved conflict must remain unresolved in the suggested rewrite.
- A provider failure must not destroy an otherwise valid primary review. Test fallbacks with mocked providers, not live tokens.
- No hardcoded secrets, API keys, preview PINs, new browser persistence of task content, or sensitive logging. The existing test-only `src/preview-access.ts` can remember a code **entered locally by that browser user**, not provision or reveal a server secret; retain the Forget code option. Do not weaken `PREVIEW_TOKEN` verification: current code requires at least **24 characters**.
- Do not promote UI loading phase labels as real progress telemetry.

## Decision Engine iteration 1

The experimental Analyze v2 button invokes only `worker/decision.ts` via `POST /api/analyze-v2`; the legacy V1 pipeline is unchanged. The provider requires a Cloudflare secret named `GEMINI_API_KEY`, which must not be hardcoded or placed in browser code. Validate **all eleven** `choice` answers and 3 probability values per gate; scorecard outcomes are not justified findings or source evidence. Tests mock the provider and verify one call, Bearer rejection, no-key fail-closed behavior, sanitized logs and strict response parsing. Keep the responsive two-button layout in `src/styles.decision.css`, without changing the three visual themes.

## Diagnostic development

Maintain bounded, privacy-safe logs in `worker/index.ts` and `src/diagnostics.ts`, correlated through `X-Request-ID`. Keep phase events low-cardinality and never log raw exceptions, user tasks, secret values or model output. `/api/client-events` is an authenticated, bounded error-event collector; retain its allowlist. An `invalid_patch` SayGM failure must not break validated primary output. Primary GPT-OSS uses `reasoning_effort: "low"`; SayGM has no app-level timeout, but the browser still has a 180-second overall analysis timer. SayGM requests omit `max_tokens`; provider defaults and model caps still apply. Retain the 1 MiB streaming response safety cap and strict JSON patch validation. Cover success/failure/timeout/invalid JSON, large safe provider envelopes, and no-secret assertions in tests.

## DeepSeek patch failure diagnosis

`worker/feedback-verifier.ts` emits fixed `VerifierContractError.code` values. `worker/saygm.ts` propagates them as `SaygmError.validationCode`; `worker/index.ts` logs the code next to `invalid_patch` and `requestId`. Never expose model response objects, evidence text or free-form provider exceptions in logs. Keep the DeepSeek system prompt's action-specific field rules and source-quote examples consistent with this validator; do not relax atomic patch validation to hide bad model responses.

## Validation and delivery

```bash
npm install
npm run check
```

Node.js **>=22.23.0** is required. `npm run check` includes Worker typecheck, Worker and client tests, and production build. Run additional targeted tests for changed behavior. `npm run eval:live` makes billable provider calls and is **not** part of CI.

Create a scoped PR, report what really ran, and merge only when appropriate. After merge, check the Cloudflare build logs, current deployment and `/api/health`; **code merged is not code deployed**. When the verifier is enabled, only a real authorized task and an `issuelint.verifier_result` log confirm a successful external call.

For more detail on the independently reviewed pipeline and rollout constraints, see `docs/feedback-quality-engine-2.5.md`. Do not treat its historical iteration-by-iteration notes as proof that the live environment has been validated.
