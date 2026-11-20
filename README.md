# IssueLint

Platform-independent issue/task review — SolidJS + TypeScript + Cloudflare Workers.

## Iteration 2 — Real Workers AI integration (backend only)

**The frontend is unchanged.** It still runs the v0.1 demo analyzer until Iteration 3 connects `Analyze` to `/api/analyze`.

### What is implemented
- `POST /api/analyze`: validated task input → single native Workers AI invocation → strict validated result.
- Gemma 4 26B A4B default model. GPT-OSS 20B optional allowlisted model via `AI_MODEL`.
- Task validation: title, description, type, domain, optional criteria and context. 8,000-character limit; 32 KiB HTTP body limit, streamed.
- JSON schema requested from Workers AI **and validated independently** after inference. Invalid provider output is rejected (502); it never becomes an invented score.
- Output: `status`, `summary`, `findings` (max 5), `suggestedRewrite`. Contradiction evidence must contain two literal quotes from the user's task.
- Prompt enforces domain-specific assessment, no imagined requirements, no mandatory acceptance criteria, and same-language feedback.
- No inference retries, no logging task content, no database, no extra backend or AI SDK.
- API remains **disabled by default** and requires a server-side `PREVIEW_TOKEN` even when enabled.

### Run and verify

Node.js >= 22.23.0.

```bash
npm install
npm run check
npm run dev
```

`npm run check` runs Worker unit tests, TypeScript checks and the production Vite build.

Unprotected requests fail closed:

```bash
curl -i -X POST http://localhost:5173/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"title":"Example","description":"Some details","type":"General","domain":"Other"}'
```

Expected until explicitly enabled: `503 AI_DISABLED`.

For **private staging only**, configure `PREVIEW_TOKEN` as a **Cloudflare secret** (at least 24 characters) in the Worker environment and set `ANALYZE_ENABLED=true` through an environment setting. Do not commit or expose the token in SolidJS/Vite code. Then send the token in the `Authorization: Bearer <token>` header. Default `ANALYZE_ENABLED=false` in `cloudflare.config.ts`; do not enable the public endpoint before rate limits and usage controls are added in Iteration 4.

### Request

```json
{
  "title": "Follow up with leads",
  "description": "Only contact qualified leads after approval tomorrow.",
  "type": "General",
  "domain": "Sales",
  "criteria": "",
  "context": ""
}
```

### Success response

```json
{
  "mode": "ai",
  "analyzed": true,
  "analysis": {
    "status": "needs_clarification",
    "summary": "Some details are missing.",
    "findings": [
      {
        "kind": "missing",
        "severity": "important",
        "title": "Lead qualification is unspecified",
        "detail": "The qualifying criteria aren't described.",
        "evidence": [],
        "question": "What makes a lead qualified?"
      }
    ],
    "suggestedRewrite": "Follow up with qualified leads after approval tomorrow. Clarify how leads qualify."
  }
}
```

The response above illustrates the **schema**, not a guaranteed inference result.

### Contract and error codes

- `401 PREVIEW_AUTH_REQUIRED`
- `400 INVALID_JSON`
- `413 PAYLOAD_TOO_LARGE`
- `415 UNSUPPORTED_MEDIA_TYPE`
- `422 INVALID_TASK`
- `502 AI_INVALID_RESPONSE` / `AI_UNAVAILABLE`
- `503 AI_DISABLED` / `AI_UNAVAILABLE`

All API responses use `Cache-Control: no-store`. There is no permissive CORS policy.

### Files

- `cloudflare.config.ts` — static assets, API routing, native AI binding, default-off flag, preview-only secret.
- `worker/index.ts` — HTTP routing, authorization and bounded body reading.
- `worker/schema.ts` — task & analysis contracts and runtime validators.
- `worker/prompt.ts` — task review instructions.
- `worker/inference.ts` — Workers AI invocation and response extraction.
- `test/worker.test.mjs` — mock-backed HTTP, safety and model output tests.

### Deployment

Only the isolated development Worker `issuelint-dev` is targeted. **Do not deploy or merge into a public production domain yet.** The previous iteration's remote Worker may still be API-only; `npm run build` must produce both asset and Worker bundles, followed by a verified combined deployment.

**Iteration 3:** connect frontend to the live endpoint, loading/error states and privacy copy. **Iteration 4:** abuse/rate limiting, daily consumption controls, production launch.

## Iteration 3 — Frontend and Cloudflare preview

The SolidJS UI calls `/api/health` to detect whether live inference is enabled. When the server is in private-preview mode, users enter an access code (memory only; not stored) and `Analyze with AI` sends the task to `/api/analyze`. Demo reviews remain available and are clearly identified as demo/basic checks. Live reviews send task text to Cloudflare Workers AI; no task database is used.

**Cloudflare deployment note:** The initial direct Static Assets upload using the connected Cloudflare API returned HTTP 401 at the asset-content upload stage (JWT authorization). For the first accessible preview, the compiled JS and CSS were packed into a single HTML response in the same Worker; this keeps the API and UI together. This alternative is reproducible via `node scripts/create-inline-worker.mjs` after `npm run build`, which writes `deploy-inline/index.js`. Use native Cloudflare Workers Static Assets via `cf deploy` for the intended long-term hosting strategy.

The Cloudflare deployment must define `AI` (native binding), `AI_MODEL`, `ANALYZE_ENABLED=true`, and a **secret** `PREVIEW_TOKEN`. Never put the secret in the repo, build artifacts, or Vite environment. Public AI requests are not enabled; private access is a temporary measure until robust cost and abuse controls are added.
