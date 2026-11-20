# IssueLint v0.1 — frontend prototype

Platform-independent task clarity review UI, built with **SolidJS + TypeScript + Vite** and plain CSS.

## Run

```bash
npm install
npm run dev
npm run build
```

Deploy `dist/` as a static site. On Cloudflare Pages, use build command `npm run build` and output directory `dist`.

## Features
- Task title, description, type, area, and optional completion criteria/context.
- Three prewritten example analyses for software, marketing, and sales.
- Basic *structural* checks for arbitrary text; copyable draft.
- Responsive layout and dark mode.
- No backend, auth, database, API, or platform integration.

## Integrity
**No AI is connected.** Example evaluations and their scores are prewritten. Arbitrary input only receives explicit basic structural checks and **no quality score**. The app does not claim to detect real contradictions in custom text. Data stays in the browser; no persistence.

## Later
Add a secure AI analyzer behind an API, without exposing model keys in the browser.
