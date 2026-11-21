# PRODUCT.md — IssueLint product definition

> **Document status:** Product direction and initial customer hypotheses, based on the implemented IssueLint experience as of November 2026. Business, pricing, distribution and commercialization decisions are intentionally **TBD**. This is **not** a market-research report, validated customer interview record, public launch commitment or financial forecast.
>
> Implementation source: [README.md](README.md). Agent change constraints: [AGENTS.md](AGENTS.md).

## 1. Product in one sentence

**IssueLint is a fast, tool-agnostic second opinion for work requests: paste a task, check whether it is clear enough to execute, and investigate material problems before the work starts.**

### The short product pitch

Teams lose time when a task is handed off with contradictory instructions, missing context, unclear behavior, inaccessible references or ambiguous completion conditions. IssueLint makes those problems more visible **before execution** without requiring a team to migrate project-management tools or complete a long template.

The intended default experience is **“paste → Quick Scan → proceed or investigate.”** A deeper review is available when a task warrants it. The product is an **assistant for judgment**, not an automated project manager or a claim that an AI model can certify requirements as correct.

### Working positioning statement (hypothesis)

For people who regularly **write, review, assign or implement tasks**, IssueLint offers a quick, independent task-quality check that works on plain text across tools. Unlike a rigid template or a manually executed readiness checklist, the experience gives a fast first pass and optional deeper source-grounded scrutiny.

*The differentiation above is a proposed positioning thesis; it has not been established through competitive research or measured customer preference.*

## 2. Problem and job-to-be-done

### Problem

Many tickets look actionable at first glance but contain issues that only become visible after coding, design or delivery starts. Examples:

- “Use strict FIFO ordering” combined with “skip an event and deliver newer events first.”
- “Follow the Figma design” without a locatable design file.
- “Improve the checkout” without defining what is wrong or which behavior must change.
- Unclear scope across mobile/web, missing decisions about interaction behavior, or incompatible deadlines.
- Multiple related issues repeatedly described as separate blockers.

Consequences may include avoidable clarification loops, rework, delayed handoff, time spent in meetings, or teams making guesses. These are **plausible pain points**, not quantified IssueLint customer outcomes.

### Core job-to-be-done

**When** I receive or write a task, ticket, to-do or brief and am unsure whether it can be executed as written,  
**I want** a quick, understandable second opinion with optional deeper evidence,  
**so that** I can proceed with more confidence or ask a specific clarification question before work begins.

### Supporting jobs

- **Author:** Check a ticket before assigning it.
- **Reviewer / manager:** Prioritize genuinely material questions rather than subjective wording preferences.
- **Assignee:** Detect blockers before investing implementation time.
- **Cross-functional collaborator:** Check marketing, sales or operations requests without learning a developer-only notation.
- **Team lead:** Use a consistent set of quality dimensions without forcing everyone into a mandatory template.

## 3. Ideal customer profile (ICP) — hypotheses, not validated

### Initial ICP hypothesis: small-to-mid-sized software/product teams

**Users:** Product Managers, Technical Product Managers, Engineering Managers, Tech Leads, senior engineers, QA leads and project/delivery managers.

**Situation:** Work passes through Jira, GitHub Issues, Linear or another ticket workflow; tasks are written by people with mixed levels of technical/product context; review and clarification happen frequently; the team can paste text into an independent tool.

**Likely triggers:** Backlog refinement, pre-sprint readiness, incoming requests from business stakeholders, ambiguous bug/feature tickets, or checking work before delegation to AI coding agents.

**Likely value to test:** Shorter “is this actionable?” conversations, better-specified handoffs, fewer obvious contradictions and more focused questions. **No impact is yet proven.**

**Why this is the first ICP hypothesis:** It maps directly to the currently implemented eleven-dimension review and the controlled software examples. This is a product-fit inference, not evidence of market size or willingness to pay.

### Secondary ICP hypotheses

| Segment | Example user | Representative task |
| --- | --- | --- |
| Agencies and outsourced delivery teams | Delivery lead / account PM | Review a client brief before handing it to implementation |
| QA / test engineering | QA lead / test author | Check whether expected behavior and completion conditions are testable |
| Independent builders / AI-assisted developers | Indie developer / agent operator | Screen a task before sending it to a coding agent (the MCP server exists to test this; no usage evidence yet) |
| Marketing and growth teams | Marketing manager / campaign lead | Clarify target audience, channels, deliverables and result |
| Sales and operations teams | Sales Ops / operations manager | Review handoffs, requests, follow-ups and process changes |

All secondary segments are **exploration hypotheses**; none has a confirmed acquisition channel, buyer, budget, or paid demand.

### User, buyer and administrator are different roles

- **End user:** Person reviewing a task; may or may not control budget.
- **Potential economic buyer:** Team lead, department manager, agency owner or organization owner — **TBD / needs discovery**.
- **Potential internal champion:** Someone currently responsible for ticket quality and handoff friction — **TBD / needs discovery**.
- **Site operator today:** Private tester with the shared preview code; this is **not** a productized admin role.

### Exclusions / poor-fit signals today

- Buyers who require native Jira/Linear/GitHub write-back or enterprise SSO from day one.
- Organizations unable to submit work text to external model providers.
- Strictly regulated workflows that need audited accuracy, explicit retention assurances, legal review or contractual SLAs.
- Teams seeking a full project-management suite, automatic sprint planning or an autonomous agent that executes the work.
- Public high-volume customers requiring user-based quotas and billing: those controls are **not implemented**.

## 4. Product principles

1. **Five-second comprehension.** The task input, two analysis choices and meaning of ✓/✕ should be obvious without training.
2. **Fast by default; deeper on demand.** Quick Scan screens all eleven dimensions with one lightweight decision-model request. Reserve longer reasoning for deliberate follow-up.
3. **Plain text first.** No integration or mandatory schema is required for a first review. A single description paragraph is valid.
4. **Ask, don't invent.** Identify missing decisions, quote task evidence when available, and never silently invent facts or acceptance criteria.
5. **Proportionate rigor.** Tiny, well-scoped tasks should not be penalized for missing enterprise-level bureaucracy.
6. **No fake certainty.** Green ticks are preliminary screening outcomes, not formal readiness certification; Gemini `P(Clear)` is not a validated reliability score.
7. **Minimal, readable interface.** One active Minimalist design, Light/Dark support, responsive font sizes, concise checklists, accessible expandable details where needed.
8. **Protect users' work.** Sensitive text is not logged as diagnostics or submitted to analytics. Review actual model-provider practices before opening broader beta.
9. **Keep meaningful controls separate.** Fast classifier, deeper independent audit and Original AI rewriting have distinct responsibilities; do not collapse them into an opaque “AI” label.

## 5. Current user journey (implemented)

1. Open https://issuelint.com (private AI preview).
2. Select **Paste existing task** or **Build a task**.
3. Optionally type a **Task / ticket / to-do / brief title**; enter a description. Optional scope, outcome, references, criteria, type/domain and context can be added.
4. Enter the private preview access code when live AI is enabled. No account creation.
5. Click **Quick Scan** (primary action) for eleven static ✓/✕ marks. This is a Gemini-only screening pass; no explanatory text.
6. If a dimension is red or the user wants independent scrutiny, click **Analyze v2 · Decision**. This returns a full expandable view, per-gate Gemini `P(Clear)` and GPT-OSS reason/source evidence for gates selected by the current routing policy.
7. Use clarifying questions or evidence to improve the underlying ticket **manually** in the current task tool. The current full Decision v2 path does not generate a rewritten ticket or write back to third-party systems.

**Other entry points (implemented, private, unpublished):**

- **Browser (IssueLint Clipper, `extension/`):** in Chrome, open the side panel on a ticket page, clip the selection, open modal or cleaned page as Markdown, edit it, and run Quick Scan or Analyze v2 without copy-pasting. It requires the same preview code and is installed unpacked by developers. There is no Chrome Web Store listing.
- **AI coding agents (issuelint-mcp, `mcp/`):** an agent calls `lint_task` / `lint_markdown` before writing code and is instructed to ask the user the returned clarification questions when gaps or contradictions are found. It uses Analyze v2 only, requires the preview code, and runs locally from the repository (not published to npm).

Both still leave the actual ticket edit to the user; neither writes back to Jira, Linear or GitHub.

**Separate internal evaluation:** `/admin` provides two full-engine comparison buttons: **Original AI** (`/api/analyze`; includes guarded rewrites) and **Decision Model** (`/api/analyze-v2`). It can load 12 ChatGPT-origin, 12 Gemini-origin and four description-only controls. It is not a customer admin product.

## 6. The eleven quality dimensions

| Dimension | User-facing meaning |
| --- | --- |
| Contradictions | Two requirements cannot both hold |
| Actionability | A critical implementation decision remains unresolved |
| Scope | The work boundary or audience is not sufficiently defined |
| Granularity | Several independently deliverable jobs have been bundled |
| Behavior | Required interactions/process rules are unspecified or conflicting |
| Completion | “Done” could be interpreted in materially different ways |
| Outcome | The result is not understandable |
| References | A necessary artifact is missing or cannot be located |
| Dependencies | Required access, approval, sequencing or prerequisite is blocked |
| Clarity | Wording has material ambiguity |
| Feasibility | A separate, supported implementation obstacle exists |

A single root problem can surface across dimensions. Future quality work should reduce duplicate *user-facing issues* without hiding independent clarification questions. It should also avoid treating a contradictory specification as a distinct feasibility problem **solely** because it cannot be implemented as written; the taxonomy boundary is a topic for continued evaluation, not a completed calibration.

### Result labels and interpretation

- **Clear:** No material issue identified for that dimension by the relevant model.
- **Gap:** Potential material missing, ambiguous, contradictory or otherwise unresolved aspect.
- **Not applicable:** The dimension is not relevant to this particular task.
- **Quick Scan ✓:** `clear` or `not_applicable`; this intentionally hides that distinction.
- **Quick Scan ✕:** `gap`.
- **Full Decision percentage:** Gemini `P(Clear)` only; not an overall task-quality score. A GPT-OSS-reviewed gate may be cleared even with a low Gemini probability.
- **Full Decision ? (unverified):** Independent audit failed or produced invalid evidence; never treat this as a green.
- **Original AI status (internal/legacy):** `ready`, `needs_clarification`, `blocked` based on validated findings, with a separate rewrite status.

## 7. Capabilities and boundaries — accurate today

### Already implemented

- One-paragraph paste-only flow, optional visible title and optional structured inputs.
- Protected Gemini-only Quick Scan; eleven simple, non-expandable statuses.
- Protected full Decision v2 with selective GPT-OSS 120B independent audit and expandable evidence/reasoning.
- Legacy Original AI with guarded findings, optional SayGM/DeepSeek second opinion and rewrite logic.
- Admin test station with 28 author-labeled task cases across three fixtures.
- Light/Dark Minimalist UI, responsive layout, branded loading states and basic privacy-safe diagnostics.
- Shared preview Bearer gate and consent-gated optional analytics.
- Static, crawlable About page and “How to write a clear task” guide with shared header/footer, sitemap and robots rules.
- **IssueLint Clipper** Chrome side-panel extension (`extension/`): selection / modal / full-page Markdown extraction, editable clip, Quick Scan or Analyze v2 results, Mock mode. Developer install only.
- **issuelint-mcp** local MCP server (`mcp/`): `lint_task`, `lint_markdown` and a `preflight_check` prompt for coding agents, backed by Analyze v2. Run locally only.

### Not implemented

- Public user signup/login, team workspaces, RBAC or separate admin permissions.
- Native integration (API connection/sync), webhooks or writes back to Jira/GitHub/Linear. The browser extension only reads the page the user has open.
- A published Chrome Web Store extension, a published npm MCP package, or per-user keys for either. Both clients reuse the shared preview code.
- Server-side report storage, saved histories or refresh-resumable background jobs.
- Public request rate limits, user quotas/credits, billing or payments.
- Automated model quality grading against human adjudicated ground truth.
- Guaranteed one-second response, uptime or accuracy SLA.
- A finished public privacy policy, provider terms review, enterprise security assurances or public beta authorization.

The list above reflects the repository; it is **not** a promise to build all items.

## 8. Product risks and assumptions to validate

| Hypothesis / risk | What would be needed to validate it |
| --- | --- |
| Quick Scan has useful precision and recall across realistic short tasks | Human-adjudicated representative examples, per-gate confusion matrix, false-positive/false-negative review |
| All-green screens help users make the right next decision | Observe users, test trust calibration and measure mistaken acceptance |
| The eleven dimensions are independently understandable | Usability sessions, taxonomy conflict review and labeled failure analysis |
| Deep review adds actionable value beyond quick screening | Blind human comparison of clarified decisions, duplicate root causes and execution readiness |
| Provider latency is acceptable to target users | Instrumented p50/p95 end-to-end measurements by route and input size |
| In-context entry points (browser clipper, agent pre-flight via MCP) increase repeat usage over the paste-in web app | Usage comparison across entry points with real testers; agent-side observation of whether returned questions are actually asked |
| Agents act correctly on the MCP result (stop on critical gaps, don't treat failures as passes) | Transcript review across several agent clients and task types |
| Third-party task processing is acceptable to customers | Data-processing review, provider policies and customer discovery |
| A target segment will pay | Real buyer interviews and purchase behavior, not inferred willingness to pay |
| The product can be operated safely at public scale | Rate/abuse limits, metering, user separation and incident controls |

Initial learning priority: **quality, trust and repeat usage** before a public promotional claim. A single subsecond screenshot or correct test case is not representative performance evidence.

## 9. Current stage and release posture

**Current stage: private AI preview.** The app is accessible on a public domain but actual model actions are restricted by a shared Bearer preview code. Do not equate this with a secure closed beta for unrelated customers or a public open beta. A controlled tester cohort may be feasible **after** review of shared `/admin` access and external data handling.

**Exit criteria for a broader beta are TBD**, but must at minimum address an appropriate auth/access boundary, real model-evaluation evidence, provider disclosure, data handling, rate/cost controls and operational monitoring. Do not invent a readiness percentage as a project requirement.

## 10. Future strategy decisions — deliberately TBD

The following sections are intentionally **headings and decisions to make later**, not finalized plans:

### Business model — TBD

*To be decided.*

### Pricing and packaging — TBD

*To be decided.*

### Free plan, credits and limits — TBD

*To be decided.*

### Buyer persona and purchasing process — TBD

*To be decided.*

### Go-to-market and distribution channels — TBD

*To be decided.*

### Positioning, competitive alternatives and differentiation validation — TBD

*To be decided.*

### Product-led growth and conversion funnel — TBD

*To be decided.*

### Customer acquisition cost, unit economics and cost-per-scan targets — TBD

*To be decided.*

### Revenue goals and financial model — TBD

*To be decided.*

### Public beta and launch date — TBD

*To be decided.*

### Integrations and extension strategy — TBD

*To be decided.* (Current implemented state only: a private browser clipper and a local MCP server exist, see §7. Whether to publish them, how to distribute them, and any native integration are undecided.)

### Collaboration, persistence and workspace features — TBD

*To be decided.*

### Localization and target geographies — TBD

*To be decided.*

### Product analytics, KPIs and success thresholds — TBD

*To be decided.*

### Customer research / pilot recruitment plan — TBD

*To be decided.*

### Roadmap, sequencing and release milestones — TBD

*To be decided.*

## 11. Decision register

| Subject | Current state | Basis |
| --- | --- | --- |
| Product category | Tool-agnostic AI task/ticket quality reviewer | Implemented product direction |
| Default experience | Paste or build → Quick Scan → optionally full v2 | Implemented |
| Active design | Minimalist Light/Dark | Implemented |
| Primary analysis path | Gemini-only eleven-dimension checklist | Implemented |
| Deeper analysis path | Gemini + selective GPT-OSS audit | Implemented |
| Original AI verifier/rewrite | Retained as separate internal comparison path | Implemented |
| Browser clipper (Chrome extension) | Private developer install calling Quick Scan / Analyze v2 | Implemented; not published, not in root CI |
| MCP server for coding agents | Local stdio server calling Analyze v2 | Implemented; not published, not in root CI |
| Initial ICP | Software/product delivery teams | **Hypothesis, not validated** |
| Secondary audiences | Agencies, QA, builders, marketing, sales and operations | **Hypothesis, not validated** |
| Public pricing/business model | **TBD** | No decision made |
| Distribution/launch strategy | **TBD** | No decision made |
| Commercial success metrics | **TBD** | No decision made |

**Maintenance rule:** When a commercial decision is made, replace the relevant `TBD` with the date, owner, decision, evidence and any open assumptions. Do not silently turn a proposed idea into an approved roadmap or claim of customer traction.
