# IssueLint

Platform-independent AI review of work requests. **SolidJS + TypeScript + Cloudflare Workers + Workers AI**.

## Current preview

- Frontend: **Minimalist by default**, paste-first task review, optional detail fields, findings and validated rewrite.
- Backend: `POST /api/analyze` → native Workers AI binding → validated structured response.
- Default AI model: **`@cf/openai/gpt-oss-120b`**, **medium** reasoning effort, 4,000 max output tokens for the eight-dimension review.
- A private preview token is required for model inference. This is **not** a public AI API.
- Demo examples and basic structural checks work without AI.
- No auth accounts, database, platform integration, or stored task text.

## Local development

Requires Node.js >= 22.23.0.

```bash
npm install
npm run check
npm run dev
```

`npm run check` runs TypeScript, API/inference unit tests, client tests and Vite production build.

## Request

`POST /api/analyze` with JSON:

```json
{
  "title": "Add dark mode",
  "description": "Users want dark mode on web and mobile. Use the approved Figma design.",
  "type": "Feature",
  "domain": "Software",
  "criteria": "",
  "context": ""
}
```

The server enforces an 8,000-character input limit and checks the model response against the JSON contract. The output contains `status`, `summary`, `findings` (severity, source evidence and clarifying questions) and `suggestedRewrite`. Contradictions require two literal source quotes. The model never receives a hidden prompt from the frontend.

## Deployment

Cloudflare Worker: `issuelint-dev` at `https://issuelint-dev.yorulmazyln.workers.dev/`.

`cloudflare.config.ts` defines the Worker, AI and static asset bindings. The development config deliberately keeps `ANALYZE_ENABLED=false` until private staging is explicitly enabled. The deployed preview has `ANALYZE_ENABLED=true` but requires `PREVIEW_TOKEN` stored as a **Worker secret**, never in code.

The connected Cloudflare asset-upload route is currently incompatible with direct Static Assets JWT uploads. The preview uses a reproducible fallback: the CI build produces `worker/inline.js` via `scripts/create-inline-worker.mjs`, embedding the built SolidJS HTML/JS/CSS into the Worker. Prefer native Workers Static Assets via `cf deploy` when available.

All production updates must preserve the existing `PREVIEW_TOKEN` binding. Do not publish it in GitHub Actions logs or the repository.

## Inference failures and observability

Initial Gemma 4 tests exhausted `max_completion_tokens=1500` in reasoning, returning `finish_reason=length` and `content=null`. We switched first to GPT-OSS 20B low reasoning, then permanently to GPT-OSS **120B medium reasoning** for Review Engine 2.1.

The API now distinguishes:
- `AI_TRUNCATED` — model exceeded output budget
- `AI_INVALID_RESPONSE` — output failed schema/source verification
- `AI_UNAVAILABLE` — provider invocation failed

The Worker logs **only failure category and model label**, never raw task content, prompt, access codes or provider error bodies. Cloudflare Workers Logs are enabled for preview with query-string redaction and traces at partial sampling. Historical errors before observability was enabled are not retrievable.

A conditional second model call repairs empty or identical rewrites only. Add rate limiting and a usage budget before public launch.

## Design

Minimal Constructivism: structural grid, off-white/ink/red tokens, restrained diagonals, high-contrast type, single-screen task → analysis flow. No UI kit, external fonts or image requests.

## CI

GitHub Actions runs unit tests, TypeScript/Vite build, release bundle export and public smoke checks for the page and unauthorized API response.

## Selectable visual themes

IssueLint has two **frontend-only** design systems with one shared SolidJS task/review implementation:

- **Minimal Constructivism (default):** existing restrained off-white / ink / red look. Its original rules remain in `src/style.css`.
- **Neobrutalism:** vibrant pink, yellow, blue and lilac accents, bold outlines, offset shadows and asymmetric poster geometry. Rules are scoped to `.app[data-design="neobrutalist"]` in `src/styles.neobrutalist.css`.

The header switcher changes `data-design` without remounting the application or losing the task, result or private-preview access code. `src/design-theme.ts` persists only the design name in `localStorage` under `issuelint.design-theme.v1`, with a safe Constructivist fallback when storage is blocked. The separate light/dark control remains independent. Layouts are responsive and no font/image/UI packages are loaded.

Test the switcher on desktop and mobile in both color modes, including switching while a result is visible and reloading to verify selection persistence. `test/client.test.mjs` verifies preference normalization, storage and restricted-storage behavior.


## Rewrite integrity

IssueLint checks whether an AI-produced suggested rewrite is merely a copy of the source. For empty/unchanged rewrites:

1. It makes **at most one** additional, narrowly scoped Workers AI request for a proper copy-ready rewritten ticket. This happens only when the primary response is not a genuine rewrite.
2. If the repair is still missing, it keeps the validated findings and shows a **Clarification checklist**, with source text and unresolved questions. The UI explicitly labels this as a structured checklist, **not an AI rewrite**.
3. If there are no questions to add, it returns `rewriteStatus: "unavailable"` with an empty draft; the UI hides the Copy button. The client never presents the original text as a new rewrite.

The response includes `rewriteStatus` of `rewritten`, `clarification_draft`, or `unavailable`. Conditional rewriting may incur a second inference charge. No unconditional retries.

## Minimalist Zen (third visual theme)

The design selector offers **Minimalist (default)**, **Constructivist**, and **Neobrutalism**, independent of light/dark mode. The former Zen design is renamed and refined as Minimalist in `src/styles.minimalist.css`. Existing themes remain unchanged. The selected style name alone is persisted; task data and preview code are never stored.

## Paste-first onboarding (November 2026)

The entry screen intentionally has no oversized marketing hero. A short headline, one large textarea and **Analyze with AI** are immediately visible. Visitors can paste Jira issues, GitHub tickets, briefs, meeting notes or plain-text requests without any integration.

**Only task text is required in the UI.** The task title is derived from the first nonempty source line (at most 120 characters) when the optional title field is blank. Type, area, title, acceptance criteria and context are editable under *Add title, type or criteria (optional)*. The default classification is `General / Other`. The existing API retains its required `title` field; no server contract change. Derived text counts toward the 8,000-character API limit.

Minimalist is the new initial/default design, including in existing browsers through `issuelint.design-theme.v2`. The other two themes remain selectable and persistent.

## Optional Google Analytics 4 + Microsoft Clarity (prepared, not activated)

The codebase has zero tracking identifiers and makes **no analytics requests by default**.

1. Populate `VITE_GA4_MEASUREMENT_ID=G-...` and/or `VITE_CLARITY_PROJECT_ID=...` in your build environment. See `.env.example`. These are public Vite **build-time** IDs, not secrets; redeploy after setting them. Never place API keys, preview tokens or customer text in Vite environment variables.
2. When a valid ID is present, IssueLint displays a simple opt-in banner. Before acceptance, no GA4/Clarity script is loaded. Declining keeps tracking off; the user can later change this from the footer. Granting consent initializes each configured service.
3. Tracking is limited to allowlisted, payload-free UI events: `review_started`, `review_completed`, `review_failed`, `example_loaded`, `theme_changed`. There is no text, title, findings, auth code, domain/category or user identifier in custom event payloads. `data-clarity-mask="true"` covers all task-form and results content.
4. Revoking consent disables future event calls and reloads to remove the scripts from the current page; external analytics records already sent are not retroactively erased.

Google's basic consent-mode pattern loads tags only after opt-in. Clarity receives explicit `consentv2` grant. Configure Clarity project masking settings appropriately and review regional privacy requirements before activation.

Docs: https://developers.google.com/tag-platform/security/guides/consent and https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking .


## Review Engine v2

IssueLint now uses a structured **Understand → Inspect → Prioritize → Explain → Rewrite** workflow.

1. **Understand:** Infer domain and task type from text. `General` / `Other` are UI placeholders, not confirmed classifications. Explicitly selected fields remain authoritative. A duplicate, auto-derived title is not treated as a defect.
2. **Inspect:** The model must audit **scope, behavior, completion criteria, dependencies, references, clarity, contradictions, and feasibility**. The Worker rejects incomplete or duplicate audit dimensions and validates every quoted source excerpt.
3. **Prioritize:** The Worker ranks genuinely actionable, independent gaps by severity and returns **at most five**. A vague, redundant “rewrite this task” finding is filtered out; zero findings is allowed.
4. **Explain:** Findings contain task-specific impact, an actionable question and literal evidence when available. Contradictions require two verbatim source excerpts. The server derives ready/needs_clarification/blocked from selected findings.
5. **Rewrite:** The model supplies an objective using confirmed facts only; the Worker appends **only questions already present in selected findings**. Empty/unchanged/obviously unsupported drafts are repaired once or honestly labeled `clarification_draft`/`unavailable`.

Code: `worker/prompt.ts` (rubric), `worker/review-v2.ts` (audit schema, validation, ranking, context hints), `worker/inference.ts` (Workers AI + aligned rewrite).

The public API still returns `status`, `summary`, `findings`, `suggestedRewrite` and `rewriteStatus`, plus `reviewContext` (inferred domain/type) and `reviewCoverage` (checked/gaps/reported counts). The UI shows which work context the review used. The 8-dimensional audit increases inference output tokens, and therefore Neuron usage; private preview remains rate-protected only by its access token, not by a public-facing limiter.

**Scope of guarantees:** the backend guarantees schema completeness, quoted-source validity and question alignment, not that a model can detect every semantic problem or independently prove every claim in a rewrite. The rule-based audit and targeted fixtures reduce omissions but are not a replacement for qualitative model evaluation.

Golden task fixtures: software dark-mode scope/behavior/Figma checks, sales approval contradiction, marketing no-forced-AC case, falsified evidence, duplicate/missing audit dimensions.


## Review Engine 2.1 — quality gate, domain priorities, evaluation

**Permanent model**: `@cf/openai/gpt-oss-120b` (Cloudflare Workers AI), medium reasoning for the primary audit and low reasoning for the narrower optional quality gate. The inference allowlist no longer silently falls back to 20B or Gemma. Both `cloudflare.config.ts` and the live Worker `AI_MODEL` binding must agree.

**Contextual completeness gate**: after the first eight-dimension audit, `worker/quality-gate.ts` identifies important dimensions that the first pass marked clear on a short, underspecified task (software feature: scope and behavior; other domains: context-specific dimensions). It makes **one conditional independent 120B call** for at most two such dimensions. The server accepts a gap only when it has a specific explanation/question, nonduplicate content and authentic source quotes if provided. A failed optional gate preserves the validated initial analysis. No gate call is needed for a confirmed critical contradiction. Some additional inferences can run for low-detail tasks, increasing cost.

**Priorities**: `worker/review-v2.ts` ranks meaningful, verified findings by severity and domain. For software, scope/behavior outrank generic delivery dates or completion boilerplate at the same severity; contradictions remain first. The existing literal-evidence and contradiction guards stay active.

**Evaluation and telemetry**: `worker/usage.ts` provides non-sensitive per-review metadata (`modelUsage`: calls, latency, reported prompt/completion tokens and Neurons). `findingDimensions` aligns one-for-one with findings to make evaluation reproducible. Neither task text, raw prompts, credentials, nor responses are logged.

The **14 human-labeled golden tasks** in `eval/golden.json` span software, sales, marketing, operations and Turkish. To evaluate the **deployed** private Worker with real model calls:

```bash
ISSUELINT_EVAL_TOKEN='<private-access-code>' npm run eval:live
ISSUELINT_EVAL_TOKEN='<private-access-code>' npm run eval:live -- --repeat 2
ISSUELINT_EVAL_TOKEN='<private-access-code>' npm run eval:live -- --case software-dark-mode-vague
```

The script prints expected vs. detected dimensions, missed critical questions, findings outside the human-allowed set, status accuracy, per-request wall-clock latency, reported Neurons and estimated USD based on the 120B token rates. Repeats measure dimension-level consistency. **Golden labels are subjective**, not absolute truth; this is a quality regression instrument, not a guarantee of full semantic recall. Live evaluation is **opt-in**, does not run as part of CI and consumes paid Workers AI inference. Unit tests for the scoring logic do run in CI. No secret is stored in GitHub.

The 120B published rates when this was configured: $0.35 per million input tokens and $0.75 per million output tokens. Verify current Cloudflare pricing before estimating monthly use.
