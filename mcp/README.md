# issuelint-mcp

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI coding agents
(Claude Code, Cursor, Windsurf, Claude Desktop) run an **IssueLint pre-flight check** on a task, ticket, spec or
PRD **before writing code**. If the task has gaps or contradictions, the agent gets the exact source quotes and the
clarification questions to ask the user.

It is a thin client for the IssueLint Worker in this repository. It does not run any model itself.

## What it calls

| | |
| --- | --- |
| Endpoint | `POST {ISSUELINT_API_URL}/api/analyze-v2` (the web app's **Analyze v2 · Decision** engine) |
| Auth | `Authorization: Bearer {ISSUELINT_API_KEY}`: the private-preview access code (`PREVIEW_TOKEN`, 24–256 chars) |
| Body | `{ title, description, type, domain, criteria?, context?, scope?, outcome?, references? }` (`worker/schema.ts`) |
| Limits | title ≤ 180, description ≤ 6,500, criteria/context ≤ 1,200, scope/outcome/references ≤ 1,000, **total ≤ 8,000** chars |
| Engine | Gemini screens 11 gates; one GPT-OSS 120B audit independently re-checks gates with P(clear) < 0.85 |
| Latency | typically ~45–60 s, so the default timeout is 120 s |

Privacy: the task text is sent to IssueLint, which uses Google Gemini and Cloudflare Workers AI (GPT-OSS).
The server logs only fixed operational fields to stderr (tool, request ID, duration, status code). It never logs task
text, quotes, model output or the key.

## Tools

### `lint_task`
Structured task check.

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string, **required** | 1–180 chars |
| `description` | string, **required** | 1–6,500 chars; pass the user's words verbatim |
| `type` | `General` \| `Bug` \| `Feature` \| `Improvement` \| `Request` | default `General` |
| `domain` | `Software` \| `Marketing` \| `Sales` \| `Operations` \| `Other` | default `Software` |
| `criteria` | string | ≤ 1,200 |
| `context` | string | ≤ 1,200 |
| `scope` | string | ≤ 1,000 |
| `outcome` | string | ≤ 1,000 |
| `references` | string | ≤ 1,000 |

### `lint_markdown`
Raw Markdown check (GitHub issue body, PRD excerpt, copied Jira/Linear ticket). Uses the same mapping as the
IssueLint Clipper Chrome extension: `page_title` (or the first Markdown line) becomes the title, the Markdown is
sent verbatim as the description, `type: "General"`.

| Field | Type | Notes |
| --- | --- | --- |
| `markdown` | string, **required** | 1–6,500 chars (the Worker's description limit) |
| `page_title` | string | optional |
| `source_url` | string | optional; echoed in the result only, **not** sent to IssueLint |
| `domain` | enum as above | default `Software` |

### Result
A Markdown summary for the agent plus `structuredContent`:

```jsonc
{
  "readiness": "blocked_by_critical_gap | needs_clarification | not_fully_verified | no_gaps_flagged",
  "counts": { "gaps": 2, "clear": 7, "notApplicable": 1, "unverified": 1 },
  "gaps": [{ "dimension": "contradictions", "label": "Contradictions", "severity": "critical", "kind": "contradiction",
             "issue": "…", "reason": "…", "quotes": ["exact text from the task"], "question": "…" }],
  "gates": [{ "dimension": "scope", "label": "Scope", "mark": "clear|gap|not_applicable|unverified",
              "source": "gpt-oss|gemini|none", "pClear": 0.92 }],
  "audit": { "status": "complete|partial|unavailable", "selected": [], "unverified": [], "threshold": 0.85 },
  "requestId": "…", "durationMs": 47210, "endpoint": "https://issuelint.com/api/analyze-v2"
}
```

- `readiness` is derived from the findings, not a score. `blocked_by_critical_gap` means a critical gap or a
  contradiction was found. `no_gaps_flagged` does **not** mean the task is correct.
- Gate marks follow the web app's rules: a validated GPT-OSS check wins; a gate that needed the audit but wasn't
  validated is `unverified` and is **never** counted as clear.
- Errors (missing/invalid key, 401, 403, 429/rate limit, 503 not enabled, 413/422 invalid input, timeout, network)
  come back as `isError: true` with an actionable message and the request ID, and they say explicitly that the task
  was **not** checked.

## Prompt

`preflight_check` (optional `request` argument) tells the agent to run `lint_task`/`lint_markdown` before
writing code and, if critical gaps or contradictions are found, to stop and ask the user the returned questions first.

## Install and build

Requires Node.js ≥ 18.

```bash
cd mcp
npm install        # also builds dist/ via the prepare script
npm run build      # rebuild after changes
```

Optional: put `issuelint-mcp` on your PATH:

```bash
npm link
```

The package isn't published to npm, so `npx issuelint-mcp` works only after `npm link` (or a future publish).
The configs below run the built file with `node`, which works everywhere. Replace `/ABSOLUTE/PATH/TO` with your checkout path.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `ISSUELINT_API_KEY` | — | **Required for live checks.** Your IssueLint preview access code. |
| `ISSUELINT_API_URL` | `https://issuelint.com` | `https://` only (`http://` allowed for `localhost`, e.g. `http://localhost:8787` with `npm run dev`). |
| `ISSUELINT_TIMEOUT_MS` | `120000` | 1–600000. |

Keep the key out of version control: prefer your shell environment or your client's secret settings over a
committed config file.

### Claude Code

```bash
claude mcp add issuelint --env ISSUELINT_API_KEY=your-preview-access-code -- node /ABSOLUTE/PATH/TO/issuelint/mcp/dist/index.js
```

Or a project-scoped `.mcp.json`; the key is read from your shell environment:

```json
{
  "mcpServers": {
    "issuelint": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/issuelint/mcp/dist/index.js"],
      "env": {
        "ISSUELINT_API_KEY": "${ISSUELINT_API_KEY}",
        "ISSUELINT_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "issuelint": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/issuelint/mcp/dist/index.js"],
      "env": {
        "ISSUELINT_API_KEY": "your-preview-access-code"
      }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`, which lives in `~/Library/Application Support/Claude/` on macOS or
`%APPDATA%\Claude\` on Windows:

```json
{
  "mcpServers": {
    "issuelint": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/issuelint/mcp/dist/index.js"],
      "env": {
        "ISSUELINT_API_KEY": "your-preview-access-code"
      }
    }
  }
}
```

Restart Claude Desktop afterwards. Server logs go to Claude Desktop's MCP log files, because this server writes only to stderr.

### Windsurf

`~/.codeium/windsurf/mcp_config.json` uses the same `mcpServers` block as Cursor.

## Tests

```bash
npm run smoke-test
```

Builds, then starts `dist/index.js` over real stdio with the official MCP client against a **local mock** of the
IssueLint Worker (no key or network needed). It checks:

- tool and prompt listing, and the input schemas;
- the exact request body and headers;
- the Markdown and structured output;
- a missing key (no request sent), 401, 403, 429, a rate-limit 502 and a timeout;
- input limits, including the 8,000-char total;
- an invalid URL;
- that the key and the task text never appear in stderr.

## Design notes

- **stdout is JSON-RPC only.** `src/stdout-guard.ts` is imported first and routes `console.log`/`info`/`debug` to
  stderr before any dependency loads.
- **One call per tool invocation, no retries.** A rate-limit message tells the agent not to retry in a loop.
- Redirects are refused, responses over 2 MiB are rejected, and the client-supplied `X-Request-ID` matches the Worker's allowlist,
  so log lines correlate with Worker logs.
- **Quoted task text is untrusted.** The summary reminds the agent to treat it as data, not instructions.

| File | Role |
| --- | --- |
| `src/index.ts` | Server, tools, prompt |
| `src/client.ts` | Config + HTTP + error mapping |
| `src/task.ts` | Zod schemas + Worker task mapping |
| `src/formatter.ts` | Decision response → summary |
