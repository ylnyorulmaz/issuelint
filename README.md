# IssueLint

Platform-independent task clarity reviewer — SolidJS + TypeScript + Vite. Currently a **frontend prototype** with Cloudflare Worker routing groundwork.

## Iteration 1: Worker foundation

- Workers Static Assets are configured to serve the existing SolidJS SPA.
- `/api/*` routes run first in a small Worker.
- `GET /api/health` reports health and whether the `AI` binding is configured.
- `POST /api/analyze` is a **fixed transport stub** and intentionally **does not inspect user text or call Workers AI**.
- Other API paths return JSON 404; non-API requests serve static assets.
- There is **no live AI analysis, auth, database, or Jira integration**.
- The frontend deliberately continues to display the v0.1 demo/basic checks. Wiring it to the endpoint is Iteration 3.

## Local development

Requires Node.js **22.23+** (Cloudflare CLI `cf` typed config requirement).

```bash
npm install
npm run check
npm run dev
```

In a second terminal, test the endpoint:

```bash
curl http://localhost:5173/api/health
curl -i -X POST http://localhost:5173/api/analyze -H 'content-type: application/json' -d '{"title":"Example","description":"A test request"}'
```

The test response must contain `"mode":"stub"` and `"analyzed":false`.
To test the Worker independently without model calls: `npm run test:worker`.

## Cloudflare

The repo uses [Cloudflare CLI `cf`](https://developers.cloudflare.com/cf/) and the Cloudflare Vite plugin, with typed `cloudflare.config.ts` configuration. The development Worker is **`issuelint-dev`**, not the production domain.

```bash
npm run build
npm run deploy
```

Deploy requires Cloudflare authentication and an account selection. The Workers AI binding is defined as `AI`; do **not** add API keys to client-side Vite variables. The `ASSETS` binding is for fallback serving.

Configuration:
- `cloudflare.config.ts`: Worker name, AI binding, static routing, observability.
- `vite.config.ts`: SolidJS and Cloudflare Vite plugins.
- `worker/index.ts`: small HTTP handler; no model calls.

**Deployment scope:** No custom domain or production Worker is changed. Do not enable public user-facing analysis until the real AI endpoint, input limits, and abuse safeguards are implemented.

## Frontend demo

Three prewritten examples (software, marketing, sales); other text gets basic structural checks only. The application does not invent contradiction findings or quality scores for arbitrary input.

## Next

**Iteration 2**: add validated JSON request/response schemas, prompt and real Workers AI model invocation. **Iteration 3**: switch frontend Analyze to the API with loading and error states.
