# IssueLint Clipper (Chrome extension, Manifest V3)

Clip clean Markdown from the active tab (including Jira, Linear, Trello, Rally, Monday, Asana and GitHub
pages you are already logged into), edit it, send it to a task-readiness API, and read the scorecard in
Chrome's side panel.

This folder is a self-contained package. It does not change the IssueLint web app or Worker.

## Build and load

Requires Node.js >= 22 and Chrome 116+.

```bash
cd extension
npm install
npm run build
```

Then load it in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick `extension/dist/`.
4. Pin **IssueLint Clipper**, open a task page, and click the toolbar icon (or press **Alt+Shift+L**).

After code changes, run `npm run build` again and click the reload icon on the extension card.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests: Markdown cleanup, URL validation, IssueLint request mapping and limits, Quick Scan / Decision / generic normalization, API client (mocked `fetch`) |
| `npm run test:e2e` | Runs the built `dist/content.js` in headless Chromium (Playwright) against fixture pages |
| `npm run check` | build + unit + e2e |
| `npm run zip` | Zips `dist/` for upload to the Chrome Web Store |
| `node scripts/make-icons.mjs` | Regenerates `public/icons/*.png` |

## How it works

```
toolbar click / Alt+Shift+L
  └─ background.ts: opens the side panel (grants activeTab for that page) and asks it to extract
sidepanel.ts
  ├─ chrome.scripting.executeScript(content.js) → __issuelintClipperExtract()
  ├─ editable Markdown + character count (8,000 soft limit) + Copy
  └─ Analyze Task → Mock sample OR POST to IssueLint /api/quick-scan | /api/analyze-v2 | custom URL → result view
content.ts (injected only on demand, never modifies the page, makes no network requests)
  1. selection  – the selected HTML fragment
  2. modal      – the largest visible [role=dialog] / [aria-modal=true] / dialog[open] with ≥200 chars
  3. page       – Defuddle on a cloned document (hidden subtrees pruned first)
  → Turndown + GFM (tables, task lists, fenced code), URLs absolutized, data: images dropped
  → { title, url, markdown, sourceMode, truncated }   (hard cap 100,000 chars)
```

### Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the page you clicked the toolbar icon on. Lasts until that tab navigates away. |
| `scripting` | Inject `content.js` on demand. |
| `sidePanel` | The UI. |
| `storage` | Settings. |
| `optional_host_permissions` (`https://*/*`, `http://*/*`) | **Nothing is granted at install.** Chrome asks for one origin at a time: the IssueLint server (or custom API host) when you save Settings, and optionally "Always allow on <site>" if you want Re-extract to work on a site without clicking the toolbar icon first. |

No `<all_urls>` host permission, no `tabs` permission, no persistent content scripts, no remote code.

If Re-extract says the page needs access, click the toolbar icon (or Alt+Shift+L) once on that tab.
Chrome blocks all extensions on `chrome://` pages and the Web Store.

## Settings

Open the ⚙ button in the side panel.

| Setting | Stored in | Notes |
| --- | --- | --- |
| **Backend** | `chrome.storage.sync` (`MODE`) | `IssueLint · Quick Scan` (default), `IssueLint · Analyze v2 (Decision)`, or `Custom endpoint` |
| **IssueLint server** | `sync` (`SERVER_URL`) | Default `https://issuelint.com`. `http://` only for `localhost` (e.g. `http://localhost:8787` for local dev) |
| **API URL** | `sync` (`API_URL`) | Custom endpoint only |
| **Preview access code / API key** | `chrome.storage.local` (`API_KEY`) | Sent as `Authorization: Bearer …`. Never synced. For IssueLint this is the same private-preview code you use on the website (the Worker's `PREVIEW_TOKEN`, ≥24 characters) |
| **Mock mode** | `sync` (`MOCK_MODE`) | On by default. Returns sample data in the selected backend's exact response shape and sends nothing |

On Save (and on the first Analyze), Chrome asks once for access to the server's origin.

## What Analyze sends

All modes: `POST`, `Content-Type: application/json`, `X-Request-ID: <uuid>`, Bearer key if set,
`credentials: "omit"`, redirects rejected, 180-second timeout, cancellable.

### IssueLint · Quick Scan → `POST <server>/api/quick-scan`
### IssueLint · Analyze v2 → `POST <server>/api/analyze-v2`

Body matches the Worker's task contract (`worker/schema.ts`), with the web app's paste-flow defaults:

```json
{ "title": "<page title, or first Markdown line>", "description": "<edited Markdown>", "type": "General", "domain": "Other" }
```

- `title` ≤ 180 characters; `description` ≤ **6,500** characters (the counter switches to this hard limit and
  Analyze is disabled above it — nothing is truncated silently).
- The page URL is **not** added to the task text.
- Privacy: Quick Scan sends the title and text to IssueLint, which asks Google Gemini; Analyze v2 additionally uses
  Cloudflare Workers AI (GPT-OSS 120B) for gates where Gemini's P(clear) < 0.85.

Responses:
- **Quick Scan** `{ mode: "quick_scan", scan: { gates: [{ dimension, assessment }] } }` → an 11-row ✓/✕ list.
  ✓ means *nothing flagged* (clear or not applicable), not that the task is correct. No evidence, no score.
- **Analyze v2** `{ mode: "decision", decision: { gates, audit } }` → gap rows with reason, quotes and question,
  plus every gate with its source (GPT-OSS / Gemini) and Gemini's P(Clear). Marks follow the web app's
  `presentDecisionGate`: a validated GPT-OSS check wins; a gate routed for audit but not validated is
  **unverified** (`?`), never a pass. Partial / unavailable audits are stated explicitly.
- Errors use the Worker's `{ error, message }`: 401 → check the access code; 422/413 → task too long or invalid;
  502 rate limit / provider failure; 503 → analysis not enabled on that server. The request ID is shown for support.

### Custom endpoint → `POST <API_URL>`

```json
{ "source_url": "https://…", "page_title": "…", "markdown": "…" }
```

Expected response (extra fields ignored; also accepted wrapped as `{ "analysis": { … } }`):

```json
{
  "status": "ready | needs_clarification | blocked",
  "summary": "One-paragraph overview.",
  "counts": { "gaps": 3, "clear": 7, "not_applicable": 1 },
  "checks": [
    {
      "dimension": "completion",
      "assessment": "gap | clear | not_applicable",
      "severity": "critical | important | suggestion",
      "title": "No definition of done",
      "detail": "Why this is a gap.",
      "evidence": ["exact quote from the task"],
      "question": "Clarification question to ask."
    }
  ],
  "findings": []
}
```

`checks` drives counts and the "Other dimensions" chips; `findings` (same fields) can be sent instead and wins
when present; `counts` is derived when omitted.

## Layout

```
extension/
  manifest.json          MV3 manifest (version stamped from package.json at build)
  package.json
  vite.config.ts         two builds: side panel + module service worker, then content.js as one IIFE
  tsconfig.json
  public/icons/          toolbar icons
  scripts/make-icons.mjs
  src/
    background.ts        toolbar click → open panel → ask it to extract
    content.ts           selection → modal → Defuddle page pipeline, Turndown + GFM
    sidepanel.html
    sidepanel.ts         UI, settings, analyze flow, scorecard rendering (textContent only)
    styles.css           dark theme
    lib/                 IssueLint request mapping, api client, URL checks, settings, scorecard normalizer, mock data, Markdown cleanup
  test/                  node:test unit tests + Playwright extraction test
```
