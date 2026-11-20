# IssueLint

Platform-independent AI review of work requests. **SolidJS + TypeScript + Cloudflare Workers + Workers AI**.

## Current preview

- Frontend: minimalist Constructivist design, responsive task form, findings and suggested rewrite.
- Backend: `POST /api/analyze` → native Workers AI binding → validated structured response.
- Default AI model: `@cf/openai/gpt-oss-20b`, **low** reasoning effort, 1,600 max output tokens.
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

Initial Gemma 4 tests exhausted `max_completion_tokens=1500` in reasoning, returning `finish_reason=length` and `content=null`. We switched to the verified GPT-OSS 20B low-reasoning configuration.

The API now distinguishes:
- `AI_TRUNCATED` — model exceeded output budget
- `AI_INVALID_RESPONSE` — output failed schema/source verification
- `AI_UNAVAILABLE` — provider invocation failed

The Worker logs **only failure category and model label**, never raw task content, prompt, access codes or provider error bodies. Cloudflare Workers Logs are enabled for preview with query-string redaction and traces at partial sampling. Historical errors before observability was enabled are not retrievable.

No automatic retry of paid inference is performed. Add rate limiting and a usage budget before public launch.

## Design

Minimal Constructivism: structural grid, off-white/ink/red tokens, restrained diagonals, high-contrast type, single-screen task → analysis flow. No UI kit, external fonts or image requests.

## CI

GitHub Actions runs unit tests, TypeScript/Vite build, release bundle export and public smoke checks for the page and unauthorized API response.
