# IssueLint

**The second opinion for every task.** IssueLint is a lightweight, platform-independent AI review tool for tasks, tickets, to-dos, user stories, and work briefs. Paste a request, identify potential execution problems in a fast checklist, and run a deeper evidence-oriented review when clarification is needed.

**Live site:** https://issuelint.com  
**About page:** https://issuelint.com/about/ — static, crawlable product introduction.  
**Task-writing guide:** https://issuelint.com/guides/how-to-write-a-clear-task/ — static, crawlable checklist and examples.  
**Contact:** yorulmazyln@gmail.com · https://ylnyorulmaz.com  
**Source of truth:** [`main`](https://github.com/ylnyorulmaz/issuelint/tree/main)  
**Stage:** private AI preview / pre-public-beta evaluation. **Not** a generally available, rate-limited, multi-user production service.  
**Product strategy and ICP:** [PRODUCT.md](PRODUCT.md)  
**Contributor/agent instructions:** [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md)

IssueLint works with text copied from Jira, GitHub Issues, Linear, email, documents, and meetings. **There are no native Jira/Linear/GitHub ticket integrations in this codebase** (no API connection, sync or write-back). The UI currently uses one active Minimalist theme with Light/Dark appearance.

Two **companion clients** live in this repository as separate packages and call the same protected Worker routes (see [section 5](#5-companion-clients-extension-and-mcp)):

- [`extension/`](extension/README.md): **IssueLint Clipper**, a Chrome (Manifest V3) side-panel extension that clips clean Markdown from the open page and runs Quick Scan or Analyze v2 on it.
- [`mcp/`](mcp/README.md): **issuelint-mcp**, a local stdio MCP server so AI coding agents can run an Analyze v2 pre-flight check before writing code.

## 1. The experience today

### The two public-facing analysis actions

| UI action | Backend | Models | What the user receives | Intended use |
| --- | --- | --- | --- | --- |
| **Quick Scan** (primary) | `POST /api/quick-scan` | Google `gemini-decision-1` | Eleven non-expandable rows with a green ✓ or red ✕. No scores, percentages, evidence, model explanations, or rewritten ticket. | Fast initial screening. |
| **Analyze v2 · Decision** (secondary) | `POST /api/analyze-v2` | Google `gemini-decision-1`, then selectively Cloudflare Workers AI `@cf/openai/gpt-oss-120b` | Compact, expandable eleven-gate scorecard with Gemini `P(Clear)`, GPT-OSS reasoning when audited, verified source excerpts, clarification questions, and prioritized findings. | Deeper examination of possible issues. |

Both buttons use the **same validated task input**. The full review is not the old Original AI pipeline: its first stage is Gemini, followed by a separately prompted GPT-OSS audit of selected gates.

**Legacy capability retained, not removed:** `POST /api/analyze` runs the **Original AI** review (GPT-OSS 120B at low reasoning with the optional independent SayGM/DeepSeek verifier and guarded rewrite logic). It is **not** the primary homepage button. It remains callable through the API and the private `/admin` test station for controlled comparisons. Do not merge these three paths conceptually or in code.

A local **demo review** is also available when requested. Demo output is illustrative/structural, **not** a semantic AI assessment.

### Input modes

- **Paste existing task:** Paste one paragraph or a complete ticket into the description field. The title is visible and **optional**; if blank, the client derives a title from the first nonempty description line (up to 120 characters) before submitting to the API. All further details are optional.
- **Build a task:** Compose a title, description, type/domain, and optionally scope, intended outcome, references, completion criteria and context. Do not demand unnecessary ceremony for small tasks.
- **Example tasks:** Predefined examples help users explore behavior; loading one does not automatically call an AI provider.
- **Private preview code:** A visitor must supply the valid `PREVIEW_TOKEN` to use live AI. A manually entered code can be remembered in that browser (see Security). No self-service public signup exists.

A submitted task is evaluated across **11 dimensions**:

| Dimension | Question being screened |
| --- | --- |
| Contradictions | Are material instructions or constraints incompatible? |
| Actionability | Can meaningful work begin without an execution-critical unanswered decision? |
| Scope | Are relevant boundaries, platforms, audiences and deliverables specified? |
| Granularity | Is this one cohesive, manageable unit of work? |
| Behavior | Are required interactions and rules sufficiently clear? |
| Completion | Can an assignee tell when the work is done? |
| Outcome | Is the intended changed state or result understandable? |
| References | Are required artifacts such as a Figma design or specification locatable? |
| Dependencies | Are material prerequisites and sequencing constraints workable? |
| Clarity | Can the task be interpreted without material ambiguity? |
| Feasibility | Is there a separately identifiable, source-supported implementation obstacle? |

The classifier's underlying outcomes are `clear`, `gap` and `not_applicable`. A **gap** is a potential material issue—not a definitive judgement. An optional field being empty is **not automatically a gap**.

### Quick Scan semantics

Quick Scan makes **one Gemini Decisions API request** containing all eleven independent choice questions. It returns **only the dimension and assessment** for each gate; detailed provider probabilities and text are deliberately excluded from the response.

- **Green ✓:** Gemini found no material problem **or** rated the dimension `not_applicable`. The compact UI combines both states; green is **not a guarantee of correctness or readiness**.
- **Red ✕:** Gemini flagged `gap`, which may warrant closer review.
- **No percentages and no expandable explanations** in this mode.
- **No GPT-OSS, SayGM, rewrite, or audit call** is performed.
- Quick Scan is usually intended to be fast. Its runtime depends on Google/network conditions; observed subsecond runs are **not an SLA or benchmark**.

Implementation: `worker/decision.ts`, `worker/index.ts`, `src/api.ts`, `src/components/QuickScanScorecard.tsx`, `src/styles.quick-scan.css`.

### Analyze v2 semantics

The full Decision route uses the same Gemini 11-choice result, then applies the **experimental routing rule** `P(clear) < 0.85`. A gate with exactly `0.85` is not selected. **One** independent high-reasoning GPT-OSS call audits all selected gates together; no call occurs when none are selected.

- The GPT-OSS prompt sees the **task and selected gate rubrics**, but **not** Gemini choices, probabilities, confidence, or threshold. It can independently report `clear`, `gap` or `not_applicable`.
- Each reviewed gate has a bounded reason; a `gap` requires literal, checked task excerpts and a focused clarification question. Unsupported individual gate outputs are quarantined.
- The compact UI shows Gemini **`P(Clear)`**, **not** a task score or calibrated probability of correctness. A green ✓ beside, for example, `63%` means GPT-OSS independently cleared that gate. A result not independently audited above the routing threshold is labeled as Gemini-only screening in the expandable view.
- Icons include ✓ (no issue identified), ✕ (needs attention), ? (selected but not verified), and — (not applicable).
- Explanations, quotations and clarification questions appear **only when a row is expanded**. Prioritized issues are separately collapsible.
- `audit.status` can be `complete`, `partial` or `unavailable`. A model failure must not be disguised as a successful independent verification.
- This full Decision v2 route does **not** generate a rewritten ticket and does **not** call the SayGM/DeepSeek verifier.

Implementation: `worker/decision.ts`, `worker/decision-audit.ts`, `src/decision-presentation.ts`, `src/components/DecisionScorecard.tsx`.

### Original AI / Review Engine 2.5

The retained `POST /api/analyze` mechanism is a separate, fuller text-review and rewriting pipeline:

1. Workers AI `@cf/openai/gpt-oss-120b` (primary, low reasoning) creates an eleven-dimension structured review and rewrite core.
2. `worker/review-v2.ts`, `worker/schema.ts` and deterministic guards validate source evidence, prevent fabricated critical contradictions and prioritize **up to five** distinct actionable findings.
3. If enabled, SayGM `deepseek-v4.1-flash-1017` independently reviews all eleven checks and returns a strictly validated, bounded patch verdict. `off`, `shadow` and `on` modes are supported.
4. In `on`, only validated patch actions are applied; the old conditional quality gate is skipped, **not stacked**. When not in `on`, the earlier conditional quality gate may run.
5. At most **one** targeted low-reasoning rewrite repair can be attempted. No recursive judge/rewrite debate exists.
6. A rewrite is marked `rewritten`, `clarification_draft` or `unavailable`; unresolved contradictions must not be silently “fixed” by inventing a decision.

The resulting task status is `ready`, `needs_clarification` or `blocked`, computed from final validated findings. A failed optional verifier must not discard a valid primary result. Further historical details: [Review Engine 2.5 notes](docs/feedback-quality-engine-2.5.md).

## 2. Waiting, appearance and browser behavior

- Quick Scan has a lightweight logo-based animated loading state; the full Decision flow has the same brand animation and explanatory waiting instructions.
- The full review may take around **1–2 minutes** depending on provider load, though runs can be shorter or longer. These are informational estimates, **not guaranteed latency**.
- Switching tabs or minimizing a window normally preserves an in-flight browser request. **Do not refresh, close, or navigate away**: analysis is currently tied to the active page and not recoverable from a server-side job.
- On cancellation, the frontend aborts the request; this does **not guarantee** an upstream provider has stopped work or charges.
- The only active design is **Minimalist**. Light/Dark selection is saved as `issuelint.appearance.v1` and defaults to the OS setting before a manual choice. Retired design assets remain in source control; their selector is hidden.
- Logo files are in `public/brand/`. New CSS respects responsive widths and prefers-reduced-motion settings.
- Static, crawlable pages are served from `public/` by Workers Static Assets: `/about/` and `/guides/how-to-write-a-clear-task/`. They share `public/site-header.css` and `public/site-footer.css` with the SPA header/footer. `public/robots.txt` disallows `/admin`; `public/sitemap.xml` lists `/`, `/about/` and the guide. `index.html` carries SEO metadata and a no-JavaScript fallback with links to both pages.
- GA4/Clarity scripts, when their optional **public** Vite IDs are configured, are consent-gated. Task text, model output and access codes must not be sent as analytics events.

## 3. Private benchmark station — `/admin`

Visit https://issuelint.com/admin using the same private preview code. This is a **testing interface, not an admin-role authorization system**.

Protected `GET /api/admin/test-cases?source=...` supports:

| Source | File | Cases |
| --- | --- | ---: |
| `chatgpt` | `test/fixtures/task-review-control-v1.json` | 12 |
| `gemini` | `test/fixtures/task-review-gemini-v1.json` | 12 |
| `paste` | `test/fixtures/task-review-paste-only-v1.json` | 4 |

The paste-only controls contain three deliberately obvious problems and one clean case; the fixture title and extra fields are blank. Admin derives a request title the same way the homepage does when running them.

For every case, testers can inspect the exact task, optionally reveal **author expectations**, and independently send **only the task object** to **Original AI** or **Decision Model**. The oracle, quality label and dataset source must **never** be passed to the model. Results appear side by side; requests are initiated manually. Labels are *evaluation hypotheses*, not automatically graded ground truth, and no server-side run history is stored.

**Access warning:** the shared `PREVIEW_TOKEN` also protects the fixture endpoint. It does **not** separate test visitors from admin access. Introduce a separate admin identity/access policy before distributing widely.

## 4. HTTP API and safety contract

The Worker serves the SPA and the following routes:

| Method and route | Purpose | Auth |
| --- | --- | --- |
| `GET /api/health` | Safe configuration/feature status (`iteration: 5`, `reviewEngineVersion: "2.5"`) | Public |
| `POST /api/quick-scan` | Gemini-only eleven-gate screening | Preview Bearer |
| `POST /api/analyze-v2` | Gemini screening + selected independent GPT-OSS audit | Preview Bearer |
| `POST /api/analyze` | Original GPT-OSS + optional SayGM verifier + rewrite pipeline | Preview Bearer |
| `GET /api/admin/test-cases?source=chatgpt|gemini|paste` | Benchmark datasets and author expectations | Preview Bearer |
| `POST /api/client-events` | Strictly bounded, privacy-safe client failure events | Preview Bearer |

All POST analysis routes expect `Content-Type: application/json` and `Authorization: Bearer <PREVIEW_TOKEN>`. The Worker enforces the preview token (24–256 characters, nonwhitespace), a **32,768-byte** body cap, and typed task validation. Server failures are sanitized; credentials, provider bodies and task content must not be logged.

A minimal compatible API request is:

```json
{
  "title": "Add dark mode",
  "description": "Support a dark color theme on web and mobile.",
  "type": "Feature",
  "domain": "Software",
  "criteria": "",
  "context": ""
}
```

Optionally include `scope`, `outcome` and `references`; the UI can also populate criteria and context. Types: `General`, `Bug`, `Feature`, `Improvement`, `Request`. Domains: `Software`, `Marketing`, `Sales`, `Operations`, `Other`. The API requires a nonempty `title`; the **browser** derives one when a user leaves it blank. Total task text is limited to **8,000 characters**; description is capped at **6,500**, title at **180**; see `worker/schema.ts` for per-field caps.

### Quick Scan response shape

```json
{
  "mode": "quick_scan",
  "analyzed": true,
  "scan": {
    "model": "gemini-decision-1",
    "checked": 11,
    "durationMs": 210,
    "gates": [
      { "dimension": "contradictions", "assessment": "clear" }
    ]
  }
}
```

**Illustrative partial JSON only**: a real successful response has **eleven** ordered gates, not one. `durationMs` is an example value, not an observed SLA. The Quick Scan API intentionally returns **no probabilities or audit**.

The full Decision result instead has `mode:"decision"` and `decision:{model,gates,checked,durationMs,audit}`, with probabilities and validated audit status. Original AI returns `mode:"ai"` and `analysis` with findings, suggested rewrite and review status. Client-side validation is in `src/api.ts`.

`GET /api/health` reports **configuration**, not evidence that an upstream inference succeeded. The API has no public identity, account-specific quota, server-side rate limiter, metered billing, or durable report storage. Do **not** expose the shared preview token as a production multi-tenant access mechanism.

## 5. Companion clients: extension and MCP

Both are **separate npm packages** with their own `package.json`, lockfile, tests and README. They do **not** add Worker routes, are **not** deployed by Cloudflare, and are **not** run by the root CI (`npm run check`). They use the existing private-preview Bearer gate; neither ships or embeds a token.

| | IssueLint Clipper (`extension/`) | issuelint-mcp (`mcp/`) |
| --- | --- | --- |
| Form | Chrome MV3 side panel, loaded unpacked from `extension/dist/` | Local stdio MCP server (`node mcp/dist/index.js`) |
| Users | People reviewing a ticket in a browser (Jira, Linear, GitHub, …) | AI coding agents (Claude Code, Cursor, Windsurf, Claude Desktop) |
| Routes | `POST /api/quick-scan` (default) or `POST /api/analyze-v2`; optional custom endpoint | `POST /api/analyze-v2` only |
| Request body | `{title, description, type:"General", domain:"Other"}` from the page title (or first Markdown line) + edited Markdown | `lint_task`: structured fields; `lint_markdown`: same mapping as the Clipper, `domain` default `Software` |
| Auth | Preview code entered by the user, stored in `chrome.storage.local` (not synced) | `ISSUELINT_API_KEY` env var |
| Output | Quick Scan ✓/✕ list or Decision gate list with quotes/questions | Agent-readable Markdown + `structuredContent` (`readiness`, counts, gaps, gates, audit) |
| Mock mode | Built-in sample data per backend shape (default on) | Tests use a local mock Worker |
| Published | No (unpacked developer install) | No (not on npm; run by path or `npm link`) |

Shared rules: the source page URL is **not** injected into task text; text over the Worker's 6,500-character description cap is rejected client-side, not truncated; Decision gate marks mirror `presentDecisionGate` (`src/decision-presentation.ts`), so an unverified gate is never shown as clear. **If `worker/schema.ts` limits/enums or the Quick Scan/Decision response shapes change, update `extension/src/lib/issuelint.ts`, `extension/src/lib/scorecard.ts`, `mcp/src/task.ts`, `mcp/src/formatter.ts` and their tests in the same PR.**

**Clipper details** (`extension/README.md`): extraction priority is selection → largest visible open dialog → Defuddle full-page cleanup, converted with Turndown + GFM. Permissions are `activeTab`, `scripting`, `sidePanel`, `storage`; host access is optional and requested per origin at runtime. The content script is injected on demand, makes no network requests and does not modify the page.

**MCP details** (`mcp/README.md`): tools `lint_task` and `lint_markdown`, prompt `preflight_check`. stdout carries JSON-RPC only; logs go to stderr without task text or the key. Default timeout 120 s (`ISSUELINT_TIMEOUT_MS`); missing key, 401/403/429, timeout and invalid input return tool errors stating that the task was **not** checked.

```bash
cd extension && npm install && npm run check   # typecheck, build, unit + Chromium extraction tests
cd mcp && npm install && npm run smoke-test     # build + stdio smoke tests against a mock Worker
```

## 6. Local development and tests

**Node.js >= 22.23.0**. The root app intentionally has no committed package lock; CI uses `npm install`, not `npm ci`. (`extension/` and `mcp/` are separate packages and do commit their own lockfiles.)

```bash
npm install
npm run dev
npm run check
```

Useful commands:

| Command | Behavior |
| --- | --- |
| `npm run check` | Strict Worker typecheck, Worker/client test suites, production build |
| `npm run check:worker` | Strict Worker typecheck only |
| `npm run test:worker` | Worker tests including auth, schema, verifier and Quick Scan |
| `npm run test:client` | Client contracts and input-mode regression tests |
| `npm run build` | TypeScript no-emit + Vite production build |
| `npm run eval:live` | Live provider-backed golden-set evaluation (**external calls; not CI**) |
| `npm run deploy` | Cloudflare `cf deploy` via repo configuration; use only when authorized |

Additional focused tests live in `test/decision.test.mjs`, `test/decision-audit.test.mjs`, `test/admin.test.mjs` and `test/fixtures/`. Note that `npm run test:worker` does **not** explicitly enumerate `test/decision.test.mjs` and `test/decision-audit.test.mjs`; run them separately when changing Decision behavior:

```bash
node --experimental-strip-types --test test/decision.test.mjs test/decision-audit.test.mjs
```

Mocked tests prove contracts—not actual model correctness or deployed behavior. The golden evaluator in `scripts/eval-review.mjs` makes real provider requests; do not run it without authorization and cost awareness.

## 7. Cloudflare configuration and delivery

- **Worker:** `issuelint-dev` (Cloudflare Workers + static SPA assets).
- **Production domain:** https://issuelint.com
- **Worker URL:** https://issuelint-dev.yorulmazyln.workers.dev
- **Config source:** `cloudflare.config.ts`; compatibility date currently `2026-11-20`.
- **Workers Builds:** GitHub `main`, build `npx cf build`, deploy `npx cf deploy --prebuilt --force`. This is **Cloudflare's `cf` toolchain**, not Wrangler.
- **Branch previews/local:** `ANALYZE_ENABLED=false` by default; protected production builds set it to `true` and set `FEEDBACK_VERIFIER_MODE=on`. Dashboard overrides can be replaced by later deploys; inspect actual live bindings without displaying their values.

| Binding | Type / use |
| --- | --- |
| `AI` | Cloudflare Workers AI binding |
| `ASSETS` | Static assets binding |
| `AI_MODEL` | Default `@cf/openai/gpt-oss-120b` |
| `ANALYZE_ENABLED` | Explicit private inference switch |
| `PREVIEW_TOKEN` | Server-side secret for protected endpoints |
| `GEMINI_API_KEY` | Server-side secret for Google Decisions; required for Quick Scan and full v2 |
| `SAYGM_API_KEY` | Server-side secret for optional Original AI verifier |
| `FEEDBACK_VERIFIER_MODE` | `off` / `shadow` / `on` for Original AI only |

The `--force` deploy option applies source-controlled Worker configuration and may overwrite Dashboard changes; verify bindings/secrets/flags before and after any deployment.

**Release checklist:** create a scoped PR; run checks; merge only after tests; verify the resulting Cloudflare **build ID, outcome, commit, deployment version, traffic share and /api/health**. A merged commit is **not proof of a live deploy**. Every merge to `main` triggers a Workers Build, even when only `extension/`, `mcp/` or docs changed.

GitHub workflows:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | PRs and pushes to `main` | `npm install` + root `npm run check` (does **not** cover `extension/` or `mcp/`) |
| `export-build.yml` | Push to `main` | Runs `npm run check`, builds, and force-pushes the built Worker + site (plus a single-file inline Worker from `scripts/create-inline-worker.mjs`) to the `release-bundle` branch |
| `smoke.yml` | Manual | Checks the older 2.5/native-assets security gates on the live site, not every Quick Scan or v2 behavior; do not claim it exhaustively tests the newer paths |

### Diagnostics

Server-side fixed event names include `issuelint.decision_started`, `issuelint.decision_gate`, `issuelint.decision_result`, `issuelint.quick_scan_result`, `issuelint.decision_audit`, `issuelint.inference_stage`, `issuelint.verifier_result`, `issuelint.analysis_result` and boundary request events. The browser emits bounded `issuelint.client` logs with correlatable `X-Request-ID`. `/api/client-events` accepts only allowlisted failure telemetry.

**Never record** task titles/descriptions, prompts, generated drafts, source quotes, raw model outputs, Authorization headers, secrets, arbitrary error messages, stacks, or full URLs. Keep responses and failure categories bounded. A successful build or `/api/health` response does not prove SayGM or Gemini answered a real task successfully.

## 8. What is not built yet

IssueLint currently does **not** include user accounts, workspace/team management, native ticket integrations or write-back, server-side task/report history, job resumption after refresh, per-user credits, billing, or public rate/abuse protection. The Clipper extension and MCP server are unpublished developer installs that reuse the shared preview code; they are not a public distribution channel. Provider processing and retention must be assessed before opening external access. Accuracy, false-positive rates, latency distributions, cost per review, and user demand require representative evaluation; no performance guarantee is made by this README.

Product decisions, intended audiences, differentiators and explicitly undecided commercial sections live in [PRODUCT.md](PRODUCT.md). Implementation rules are in [AGENTS.md](AGENTS.md); Claude-specific working instructions are in [CLAUDE.md](CLAUDE.md).
