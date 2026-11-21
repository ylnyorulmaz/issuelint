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
| `npm test` | Unit tests: Markdown cleanup, URL validation, scorecard normalization, API client (mocked `fetch`) |
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
  └─ Analyze Task → Mock mode sample OR POST to API_URL → scorecard view
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
| `optional_host_permissions` (`https://*/*`, `http://*/*`) | **Nothing is granted at install.** Chrome asks for one origin at a time: the API host when you save Settings, and optionally "Always allow on <site>" if you want Re-extract to work on a site without clicking the toolbar icon first. |

No `<all_urls>` host permission, no `tabs` permission, no persistent content scripts, no remote code.

If Re-extract says the page needs access, click the toolbar icon (or Alt+Shift+L) once on that tab.
Chrome blocks all extensions on `chrome://` pages and the Web Store.

## Settings

Open the ⚙ button in the side panel.

- **API URL**: stored in `chrome.storage.sync` (`API_URL`). Must be `https://`; `http://` only for `localhost`.
- **API key** (optional): sent as `Authorization: Bearer <key>`. Stored in `chrome.storage.local`
  (`API_KEY`), so it stays on this device and is never synced to your Google account.
- **Mock mode**: on by default. Returns built-in sample data (a fictional checkout ticket, labelled
  "Sample data") and never makes a network request.

## API contract

Request (`POST <API_URL>`):

```http
Content-Type: application/json
Authorization: Bearer <API_KEY>        (only if set)
X-Request-ID: <uuid>
```
```json
{ "source_url": "https://…", "page_title": "…", "markdown": "…" }
```

Cookies are not sent (`credentials: "omit"`), redirects are rejected, and requests time out after 180 seconds.
The user can cancel at any time.

Expected response (any extra fields are ignored; also accepted wrapped as `{ "analysis": { … } }`):

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

- `checks` (one per dimension) drives the counts and the "Other dimensions" chips; `gap` checks become findings.
- `findings` (same fields as a gap check) can be sent instead of, or in addition to, `checks`;
  when present it is used as the final finding list.
- `counts` is optional and is derived from `checks` when omitted.
- Errors: non-2xx responses are shown with the status and an optional `{ "error": "…" }` message.

> The current IssueLint Worker endpoints (`/api/analyze`, `/api/analyze-v2`) take a different request body,
> so point the clipper at a backend route that accepts the payload above (or keep Mock mode on).

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
    lib/                 api client, URL checks, settings, scorecard normalizer, mock data, Markdown cleanup
  test/                  node:test unit tests + Playwright extraction test
```
