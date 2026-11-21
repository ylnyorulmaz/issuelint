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

## Review Engine 2.5

### Inference pipeline

1. `worker/inference.ts` calls `@cf/openai/gpt-oss-120b` through the native Workers AI binding (medium reasoning; 4,700 maximum output tokens) to produce the eleven checks and a grounded rewrite core.
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

If `SAYGM_API_KEY` is absent, the effective mode is `off` regardless of the flag. An invalid mode also resolves to `off`. The SayGM request has a 12-second default timeout (bounded to 1–30 seconds), one attempt and no retry. `on` affects **all** AI requests to this Worker; no percentage or per-user rollout exists.

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
| `ANALYZE_ENABLED` | Must be `true` for live inference; repository config defaults to `false` |
| `PREVIEW_TOKEN` | **Secret** used by the private Bearer gate; preserve on deployments |
| `SAYGM_API_KEY` | **Secret** for optional external verifier |
| `FEEDBACK_VERIFIER_MODE` | `off` / `shadow` / `on`; repository config defaults to `off` |

The Cloudflare **Workers Builds** dashboard has been connected to GitHub `ylnyorulmaz/issuelint` on production branch `main`, with build command `npx cf build`, deploy command `npx cf deploy --prebuilt` and root `/`. Its operation and first successful build must still be checked in Cloudflare build logs; repository connection by itself is not a successful deployment. A push to `main` is intended to trigger a build. For a local, authorized deployment, use `npm run deploy` (`cf deploy`), then verify the live Worker.

Cloudflare dashboard variable/secret changes can create a new Worker **version without updating its code**. Always distinguish repository commit, build execution, deployed version and live response. Check that `ANALYZE_ENABLED`, both secrets and verifier mode survived a new deployment. Do not assume that the repository's default flags match dashboard overrides.

Other workflows: `.github/workflows/ci.yml` runs `npm run check` on PRs and main; `export-build.yml` generates an older compatibility release bundle on main; `smoke.yml` probes a deployed site and unauthorized API access. **Known maintenance issue:** `smoke.yml` currently expects the 2.3/2.4-era health response and inline HTML; it must be updated to validate the 2.5/native-assets deployment before treating that job as a reliable release gate. A failing live smoke job is not proof that TypeScript/unit tests failed, and a passing source build is not proof the live site updated.

## Privacy and production-readiness checks

- `shadow` and `on` send user-supplied task text and AI audit results to **SayGM**, a third-party provider. Review its data-processing terms and disclose this before inviting external users. No provider-side retention guarantee is made here.
- App logs for verifier outcomes contain only `ok`, verdict count, latency, token counts or a coarse failure category under `issuelint.verifier_result`. They do not intentionally record raw submitted tasks, prompts, credentials, findings or upstream bodies.
- The app has no public API rate limiter, metering quota, user authentication or abuse controls beyond the private token. Add these and review cost limits before opening public AI access.
- A safe release requires green CI, confirmed 2.5 live health, one successful real review with a verifier success log in `on` mode, and human-reviewed golden comparisons. If quality/cost/latency degrades, switch `FEEDBACK_VERIFIER_MODE` to `off`.

## Code map

| Area | Files |
| --- | --- |
| User interface, themes, loading, analytics | `src/index.tsx`, `src/style.css`, `src/styles.*.css`, `src/components/ReviewLoading.tsx`, `src/design-theme.ts`, `src/analytics.ts` |
| Client task normalization and API | `src/review-task.ts`, `src/api.ts`, `src/analyzer.ts` |
| HTTP, auth, health, provider logs | `worker/index.ts` |
| Primary inference, conditional repair | `worker/inference.ts`, `worker/prompt.ts`, `worker/usage.ts` |
| Audit, deterministic evidence and quality gate | `worker/schema.ts`, `worker/review-v2.ts`, `worker/quality-gate.ts` |
| Independent verifier | `worker/saygm.ts`, `worker/feedback-verifier.ts`, `worker/verifier-patch.ts` |
| Regression and quality evaluation | `test/`, `eval/golden.json`, `scripts/eval-review.mjs` |
| Deployment and CI | `cloudflare.config.ts`, `.github/workflows/` |

For agent contribution rules, read [AGENTS.md](AGENTS.md). For Claude-specific guidance, read [CLAUDE.md](CLAUDE.md).
