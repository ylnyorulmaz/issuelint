# IssueLint

**IssueLint** reviews work requests, tickets and briefs for execution readiness. It provides source-grounded findings, clarification questions and a copy-ready rewrite when the input supports one. It is **platform-independent**: users can paste Jira issues, GitHub tickets or plain text; there is no Jira integration in this repository.

**Stack:** SolidJS, TypeScript, Vite, Cloudflare Workers, Cloudflare Workers AI (GPT-OSS 120B), with an optional independent DeepSeek verifier via SayGM.

- Site: https://issuelint.com
- Preview Worker: https://issuelint-dev.yorulmazyln.workers.dev
- Source of truth: this repository's `main` branch.
- **Code version:** Review Engine **2.5** (see `worker/index.ts`). A merge does not prove that Cloudflare is serving that version; verify the live health endpoint and deployment separately.
- **Release stage:** private AI preview, **not** an authenticated, rate-limited public API or a production-quality-verified release.

## What the app does

- **Paste existing task:** paste a work request; the first nonempty line supplies the API title when none is entered.
- **Build a task:** supply description, title, domain/type, scope/audience, expected outcome, references, completion criteria and constraints; optional fields stay optional in the browser.
- **Eleven-dimensional audit:** contradictions, actionability, scope, granularity, behavior, completion, outcome, references, dependencies, clarity and feasibility. Every dimension must receive a model assessment; **eleven findings are not required**.
- **Prioritized feedback:** up to five actionable findings, deduplicated by underlying issue. Critical source-verifiable contradictions take precedence. Status is recomputed from the final findings: `ready`, `needs_clarification` or `blocked`.
- **Grounded rewrite:** outputs `rewritten`, `clarification_draft` or `unavailable`. Blocked contradictions use a clarification draft; the system must not silently choose a conflicting instruction, fabricate references or present the original task as a new rewrite.
- **Running review:** animated loading/skeleton and elapsed time; the four focus labels are illustrative, **not** real streaming pipeline stages. Cancel aborts the browser request.
- **Visuals:** Minimalist (default), Constructivist and Neobrutalism, with a separate light/dark toggle. Theme preference is persisted under `issuelint.design-theme.v2`. **For private testing**, a code manually typed into Private AI access code is also saved in that browser's `localStorage` (`issuelint.preview-access.v1`) and prefilled on later visits to the same origin. Use **Forget code** to clear it; do not use this on shared devices. The code is never hardcoded or served by the Worker. This browser-only convenience is **not** an authentication bypass.
- **Fallback:** demo/basic structural review without Workers AI; it must not be represented as full AI analysis.
- **Optional analytics:** GA4 and Microsoft Clarity are disabled without build-time public IDs. When configured, scripts are loaded only after opt-in; analytics events are allowlisted and contain no task text or access codes.

The app currently has no user accounts, database, third-party task-platform synchronization or persistent storage of submitted task text in its own application code.

## Iteration 1 — Gemini Decision 1 (experimental)

**Two independent analysis buttons:** the existing **Analyze with AI** is unchanged (GPT-OSS 120B → optional DeepSeek verifier). The adjacent **Analyze v2 · Decision** calls the separate protected `POST /api/analyze-v2` endpoint. Both accept the same validated task including optional title, scope, outcome, references, criteria and context. V2 never calls GPT-OSS or SayGM in this iteration.

- `worker/decision.ts` sends **one** Google Gemini Decisions API `POST https://generativelanguage.googleapis.com/v1beta/decisions` request using `gemini-decision-1`, shared `input`, and **eleven independent `choice` questions** keyed by the existing dimensions: `contradictions`, `actionability`, `scope`, `granularity`, `behavior`, `completion`, `outcome`, `references`, `dependencies`, `clarity`, `feasibility`. Choices: `clear`, `gap`, `not_applicable`.
- The response is **strictly validated**: exactly 11 known dimensions, one per gate; expected option IDs, bounded probabilities and confidence, complete 3-option distribution. Invalid or incomplete provider output returns a clean error; **no invented scores**.
- The new **11 Gate Scorecard** displays per-gate outcome, probability distribution, model confidence and provider latency. It is a **classification-only experiment**, not human-verified evidence, a justification, or a Suggested Draft. Explanations, citations and rewrite generation are explicitly **Iteration 2**, not part of this release.
- **Privacy/security:** V2 uses the same `PREVIEW_TOKEN` Bearer gate, JSON input validator, 8,000-character task limit and request ID. It never returns or logs `GEMINI_API_KEY`, task content, Google response bodies or raw exceptions. Cloudflare logs `issuelint.decision_started`, 11 `issuelint.decision_gate` entries (fixed gate/outcome/confidence only), and `issuelint.decision_result` with counts, latency and known failure category.
- **Secret:** add your own **`GEMINI_API_KEY`** to Cloudflare **Workers & Pages → `issuelint-dev` → Settings → Variables and Secrets** as a secret, from Google AI Studio. The Worker reads it as a runtime secret and **never ships it to the frontend**. The existing production secret is declared as `bindings.secret()` in production configuration; branch previews do not require a key. `GET /api/health` returns `decisionConfigured: false` and disables the experimental button until it is configured. The existing V1 remains usable. Google AI Studio no-cost tier has usage limits; this release does not hardcode keys or substitute a paid provider.
- **API response:** `{mode:"decision",analyzed:true,decision:{model:"gemini-decision-1",gates:[{dimension,assessment,confidence,probabilities:{clear,gap,not_applicable}}],checked:11,durationMs}}`.
- **Future:** No binary acceptance threshold or automatically blocking tickets. We will benchmark/calibrate on labeled examples before using decision scores to control the user verdict. V2 presently makes no grounding claims; original V1 validation remains unchanged.

## Decision Engine — Iteration 2 (selective independent audit)

**Live V2 sequence:** `POST /api/analyze-v2` (private Bearer) → Google `gemini-decision-1` returns all 11 Gate probabilities → Cloudflare Worker selects **only** Gate IDs where `P(clear) < 0.85` → **one** native Workers AI `@cf/openai/gpt-oss-120b` call with `reasoning_effort: "high"` → strict source quote validation, de-duplication and separate scorecard explanation.

- **Blind reviewer:** The GPT-OSS prompt includes the validated original task and only the selected Gate questions/rubrics. It does **not** include Gemini probabilities, verdicts, confidence, the 0.85 threshold or an indication that the Gate was flagged. Reviewing a Gate does **not** imply it is deficient.
- **All three outcomes accepted:** For each Gate GPT independently returns `clear`, `gap` or `not_applicable` and a concise specific explanation. A `gap` must include source-grounded direct quotation(s), a focused title, an actionable question and materiality. Clear/N/A must include a reason but no fabricated issue.
- **Synchronous, single GPT call:** 1 Google request plus 0 or 1 GPT-OSS request (0 when no Gate falls below threshold). There is no per-Gate GPT loop, no DeepSeek verifier and no rewrite in the V2 route. V1 remains unchanged.
- **Grounded output:** `worker/decision-audit.ts` validates every reviewed Gate and answer, source quotations (allowing whitespace normalization and stripping purely decorative wrapping quote marks **only when the unwrapped quote literally matches the source**), bounded text and contradictions (two source excerpts). Prioritized findings reuse `prioritizeChecks` for source-conscious root issue deduplication, generic-gap filtering and deterministic contradiction safeguards. Prompting cannot guarantee truth; user judgment remains necessary.
- **Safe failure and partial recovery:** If GPT-OSS is unavailable or truncated, Gemini's original scorecard still returns alongside `audit.status: "unavailable"`. A malformed or ungrounded **individual Gate** is excluded from findings and recorded in `audit.unverified`; other independently validated Gate checks survive under `audit.status: "partial"`. If none survive, the audit is `unavailable`. UI clearly marks each unverified Gate. No unsupported evidence, reviewer explanations or findings are fabricated. The client rejects inconsistent or omitted Gate IDs.
- **Observability:** `issuelint.decision_audit` logs fixed `routed/started/completed/partial/failed/gate_rejected` stages, selected/ignored/verified counts, latency, Gate ID and allowlisted rejection reason (e.g. `evidence_not_in_task`) with request ID. No user task text, prompts, response bodies, API keys or probability distributions are included.
- **Deployment:** The production Gemini secret is now provisioned in Cloudflare, and `cloudflare.config.ts` declares its existing binding for protected production deploys while branch previews do not require it. Do not overwrite/remove existing secrets. V2 is disabled without `GEMINI_API_KEY`; reviews require Workers AI `AI` binding to produce explanations.
- **Scoring caveat:** 0.85 is an *uncalibrated routing threshold*, **not** an assertion that any lower Clear probability is wrong. Gates above threshold are **skipped**, not independently verified. Evaluate false negatives/positives and threshold sensitivity on labeled real tasks before making any production quality promises.
- **Return contract:** `decision.audit` contains `status` (`complete` / `partial` / `unavailable`), `unverified` (Gate IDs), `model`, `threshold:0.85`, `selected`, `checks` (per-Gate assessment, reason, title, evidence, question, severity, kind), `findings` (deduplicated), `durationMs` and optional safe `errorCategory`. The original `decision.gates` always retains the complete Google probability table.

## Review Engine 2.5

### Inference pipeline

1. `worker/inference.ts` calls `@cf/openai/gpt-oss-120b` through the native Workers AI binding (low reasoning; 4,700 maximum output tokens) to produce the eleven checks and a grounded rewrite core.
2. `worker/review-v2.ts` validates all dimensions, quoted source evidence, contradictions, issue selection and final summaries/status.
3. When enabled, `worker/saygm.ts` sends the original task **and all eleven checks** to SayGM's `deepseek-v4.1-flash-1017` for an independent verdict.
4. In `on` mode only, `worker/feedback-verifier.ts` and `worker/verifier-patch.ts` validate and apply bounded patch actions (`KEEP`, `SUPPRESS`, `DOWNGRADE`, `REVISE`, `ADD`), then rerun deterministic review validation. The verifier cannot suppress or downgrade a critical finding, or invent source quotes.
5. `worker/inference.ts` optionally runs **one** low-reasoning Workers AI rewrite repair for an invalid/unchanged draft or an accepted verifier request for repair. No recursive verifier/repair conversation is implemented. If the repair fails, a valid earlier rewrite is retained when possible.

The prior conditional GPT-OSS quality gate (`worker/quality-gate.ts`) is used when the independent verifier is **not** in `on` mode. It is **replaced, not stacked**, in `on` mode. Verifier failures preserve the validated primary result and do **not** imply that the original quality gate is rerun in that mode.

| `FEEDBACK_VERIFIER_MODE` | Effect |
| --- | --- |
| `off` (default) | No SayGM request; original conditional GPT-OSS quality gate can run. |
| `shadow` | SayGM runs and reports coarse telemetry, but its verdict does **not** change visible findings; original gate remains active. |
| `on` | Apply valid independent patches, recompute and optionally repair; original conditional gate is skipped. |

If `SAYGM_API_KEY` is absent, the effective mode is `off` regardless of the flag. An invalid mode also resolves to `off`. The SayGM verifier request has **no application-level timeout** or abort timer. It still makes one attempt with no retry; provider/Cloudflare execution limits and the browser’s separate 180-second analysis timeout may end requests. `on` affects **all** AI requests to this Worker; no percentage or per-user rollout exists.

**Limits of the implementation:** literal-evidence validation and deterministic guards reduce hallucinations, but do not prove all semantic judgments correct. Do not claim quality improvements without representative live model evaluation. See [the full 2.5 design and rollout record](docs/feedback-quality-engine-2.5.md).

## API and access

`GET /api/health` is public and returns an object shaped like:

```json
{
  "status": "ok",
  "service": "issuelint",
  "iteration": 5,
  "reviewEngineVersion": "2.5",
  "aiBindingConfigured": true,
  "aiEnabled": true,
  "feedbackVerifierMode": "off",
  "feedbackVerifierConfigured": false
}
```

The example shows the **shape, not measured live settings**. Confirm actual values at https://issuelint.com/api/health or the Worker URL. Health indicates configuration, **not** that a provider call succeeded.

`POST /api/analyze` requires `Content-Type: application/json` and a private `Authorization: Bearer <token>` header. The Worker rejects missing/incorrect tokens; configured `PREVIEW_TOKEN` must be **at least 24 characters**. A short code such as `yalin` does not pass the current implementation. The token is not a public login system.

```json
{
  "title": "Add dark mode",
  "description": "Users want dark mode on web and mobile. Use the referenced Figma design.",
  "type": "Feature",
  "domain": "Software",
  "criteria": "",
  "context": "",
  "scope": "",
  "outcome": "",
  "references": ""
}
```

All nine fields are accepted; `scope`, `outcome` and `references` may be omitted for backward compatibility. The API requires a title and description, even though the browser derives a title for paste-first input. Total submitted text is limited to **8,000 characters**, with individual field limits in `worker/schema.ts`. Request bodies are limited to 32,768 bytes.

A successful response contains `mode: "ai"`, `analyzed: true` and `analysis` with `status`, `summary`, `findings`, `suggestedRewrite`, `rewriteStatus`, `reviewContext`, `reviewCoverage`, `findingDimensions` and Workers AI `modelUsage`. `modelUsage` is **not** a consolidated SayGM bill. Failed requests can return `PREVIEW_AUTH_REQUIRED` (401), `INVALID_TASK` (422), `AI_DISABLED` (503), or `AI_TRUNCATED` / `AI_INVALID_RESPONSE` / `AI_UNAVAILABLE` (502).

## Local development

Requires Node.js **>= 22.23.0**. The repository has no committed package-lock; CI installs with `npm install` rather than `npm ci`.

```bash
npm install
npm run check
npm run dev
```

`npm run check` runs strict Worker type checking, Worker unit/integration tests, client tests and the production Vite build. Other useful scripts:

```bash
npm run test:worker
npm run test:client
npm run build
npm run eval:live
```

The live golden-set evaluator makes **real, billable model calls**, is intentionally excluded from default CI, and requires a private token:

```bash
ISSUELINT_EVAL_TOKEN='<private-preview-token>' npm run eval:live -- --base https://issuelint.com --repeat 2
```

Do not commit or print tokens, and do not treat mocked unit tests or subjective golden labels as evidence of production accuracy.

## Cloudflare deployment

The Worker is named `issuelint-dev` and is configured in `cloudflare.config.ts` with Workers AI, static assets, observability, and environment bindings:

| Binding | Purpose |
| --- | --- |
| `AI` | Native Workers AI binding |
| `ASSETS` | Built SPA assets |
| `AI_MODEL` | `@cf/openai/gpt-oss-120b` (model allowlist is in `worker/inference.ts`) |
| `ANALYZE_ENABLED` | `true` for protected production builds; `false` for local development/branch previews |
| `PREVIEW_TOKEN` | **Secret** used by the private Bearer gate; preserve on deployments |
| `SAYGM_API_KEY` | **Secret** for optional external verifier |
| `FEEDBACK_VERIFIER_MODE` | `on` on protected production builds; `off` for local development/branch previews. Runtime mode can still be changed via Dashboard after deployment, but a new production build restores `on`. |

Cloudflare **Workers Builds** watches GitHub `ylnyorulmaz/issuelint` on production branch `main`, with build command `npx cf build`, deploy command `npx cf deploy --prebuilt --force` and root `/`. The force flag is required to migrate the legacy Dashboard/API-uploaded Worker to native Static Assets with source-controlled configuration; the same command will override Dashboard variable edits on later pushes. **Do not run with `--force` against other workers or before verifying expected binding values.** A push to `main` triggers the build, but a successful deploy and live health response must still be verified. For local, authorized deployment, use `npm run deploy` (`cf deploy`) after understanding the configuration delta.

Cloudflare dashboard variable/secret changes can create a new Worker **version without updating its code**. Always distinguish repository commit, build execution, deployed version and live response. Check that `ANALYZE_ENABLED`, both secrets and verifier mode survived a new deployment. Do not assume that the repository's default flags match dashboard overrides.

Other workflows: `.github/workflows/ci.yml` runs `npm run check` on PRs and main; `export-build.yml` generates an older compatibility release bundle on main; `smoke.yml` is **manual** (`workflow_dispatch`) because GitHub push workflows can race the asynchronous Cloudflare deployment. The smoke checks a deployed 2.5 native-assets page, `on` mode configuration and unauthenticated 401; it does **not** exercise the authenticated external verifier. A passing source build is not proof the live site updated.

## Diagnostics and troubleshooting

**Backend (Cloudflare Workers Observability):** API analyses emit structured events with one `X-Request-ID` for the full request. Search by that ID in Workers Logs:

| Event | What it records |
| --- | --- |
| `issuelint.request_started` / `issuelint.request_finished` | Correlation ID, endpoint category, HTTP status and total elapsed milliseconds |
| `issuelint.inference_stage` | Primary invocation/validation, verifier patch, optional quality gate or rewrite-repair transitions; fixed stage labels only |
| `issuelint.verifier_started` / `issuelint.verifier_result` | Independent verifier mode, 11-check count, success flag, latency, bounded failure category, safe HTTP status and token usage |
| `issuelint.analysis_result` / `issuelint.inference_failed` | Final status, finding count, inference calls/latency, rewrite status or coarse error category |
| `issuelint.unhandled_request_error` | Unexpected Worker boundary failure; no raw error or stack |
| `issuelint.client_event` | Sanitized frontend failure from an authenticated browser, with the same correlation ID |

**Verifier patch rejection diagnostics:** Cloudflare `issuelint.verifier_result` now carries both `category: "invalid_patch"` and a fixed, privacy-safe `validationCode` (e.g. `evidence_not_in_task`, `forbidden_action_field`, `invalid_dimension`, `invalid_action`, `critical_locked`, `invalid_evidence_format`, `add_over_gap`, `invalid_reason`, `duplicate_question`). Filter by `requestId` and `validationCode` to identify the rejected rule. Never store the model's patch JSON, evidence text, raw exception messages, task content or credentials. The SayGM system prompt now specifies each action's **exact allowed fields**, mandatory lengths, permissible assessment transitions, literal evidence and small valid JSON examples. All original guardrails and atomic fallback behavior remain in place; this change does not guarantee every model response will pass validation.

**SayGM error categories:** `output_truncated` (finish reason limit), `empty_content`, `invalid_json`, `invalid_shape`, `invalid_patch`, `response_too_large`, `timeout`, `http` (plus status), `network`, `config`. Failed verifier calls fall back to validated GPT-OSS output; the failure **must not** be presented as an independently verified review. This change improves diagnosis; it does not guarantee that SayGM will return a valid patch. No retries were added. The SayGM request **omits `max_tokens` entirely**, allowing the model/provider to use its own completion default and maximum. This is **not unlimited provider output**. The gateway response is read incrementally with a 1 MiB transport-body safety cap (previously 30 KB); the final verifier patch contract remains limited to 11 validated decisions and protects against fabricated evidence.

**Frontend:** browser DevTools Console contains `issuelint.client` records for health, request lifecycle, cancellation and failure. API responses include `X-Request-ID`; browser and Worker events can be correlated with it. To find the relevant failure, filter Cloudflare Workers Observability by `issuelint.verifier_result` or `issuelint.client_event`, then by the returned request ID.

`POST /api/client-events` accepts **only** an authenticated Bearer request with `event`, `category`, `status`, `durationMs` (each strictly allowlisted and bounded; body capped at 1 KiB). The browser sends failure reports best-effort and stops after eight reports per page load. Missing/incorrect tokens mean frontend logs remain local only; this endpoint must **not** be opened to unauthenticated Internet clients without abuse protection.

**Privacy rule:** Neither frontend nor Worker logs contain raw tasks, prompts, rewrite text, model response bodies, API keys, browser token, arbitrary exception messages, stack traces, URLs/query strings or user identifiers. Keep diagnostic fields enumerated; never dump error objects or request headers. These logs support investigation but do not prove a provider was successful unless `issuelint.verifier_result` says `ok:true`.

## Privacy and production-readiness checks

- `shadow` and `on` send user-supplied task text and AI audit results to **SayGM**, a third-party provider. Review its data-processing terms and disclose this before inviting external users. No provider-side retention guarantee is made here.
- App logs capture bounded request/phase/client outcomes and verifier failure codes without raw task content, credentials, prompts, findings, messages, or provider bodies. See **Diagnostics and troubleshooting** above.
- The app has no public API rate limiter, metering quota, user authentication or abuse controls beyond the private token. Add these and review cost limits before opening public AI access.
- A safe release requires green CI, confirmed 2.5 live health, one successful real review with a verifier success log in `on` mode, and human-reviewed golden comparisons. If quality/cost/latency degrades, switch `FEEDBACK_VERIFIER_MODE` to `off`.

## Code map

| Area | Files |
| --- | --- |
| User interface, themes, loading, analytics | `src/index.tsx`, `src/style.css`, `src/styles.*.css`, `src/components/ReviewLoading.tsx`, `src/design-theme.ts`, `src/analytics.ts` |
| Client task normalization, API and diagnostics | `src/review-task.ts`, `src/api.ts`, `src/diagnostics.ts`, `src/analyzer.ts` |
| HTTP, auth, health, structured request/client-event logging | `worker/index.ts` |
| Primary inference, conditional repair | `worker/inference.ts`, `worker/prompt.ts`, `worker/usage.ts` |
| Audit, deterministic evidence and quality gate | `worker/schema.ts`, `worker/review-v2.ts`, `worker/quality-gate.ts` |
| Independent verifier | `worker/saygm.ts`, `worker/feedback-verifier.ts`, `worker/verifier-patch.ts` |
| Regression and quality evaluation | `test/`, `eval/golden.json`, `scripts/eval-review.mjs` |
| Deployment and CI | `cloudflare.config.ts`, `.github/workflows/` |

For agent contribution rules, read [AGENTS.md](AGENTS.md). For Claude-specific guidance, read [CLAUDE.md](CLAUDE.md).
