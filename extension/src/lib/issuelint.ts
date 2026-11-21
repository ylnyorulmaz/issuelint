/**
 * Pure mapping from a clip to the IssueLint Worker's task contract (worker/schema.ts `parseTask`).
 * No chrome.* usage, so it is unit-testable.
 */
import { checkApiUrl } from "./api-url.ts";
import type { BackendMode, Settings } from "./settings.ts";
import type { AnalyzeRequest } from "./types.ts";

export const ISSUELINT_LIMITS = { title: 180, description: 6_500, total: 8_000, minPreviewCode: 24 } as const;

export const ISSUELINT_PATHS = {
  quick_scan: "/api/quick-scan",
  analyze_v2: "/api/analyze-v2",
} as const;

export interface IssueLintTask {
  title: string;
  description: string;
  /** Same defaults as the web app's paste flow (src/analyzer.ts `blank()`). */
  type: "General";
  domain: "Other";
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Page title, else the first non-empty Markdown line (mirrors src/review-task.ts). */
export function deriveTitle(pageTitle: string, markdown: string): string {
  const fromPage = pageTitle.replace(/\s+/g, " ").trim();
  if (fromPage) return fromPage.slice(0, ISSUELINT_LIMITS.title).trim();
  const heading = markdown.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return heading.replace(/^#{1,6}\s+/, "").slice(0, 120).trim();
}

export function buildIssueLintTask(pageTitle: string, markdown: string): Result<IssueLintTask> {
  const description = markdown.trim();
  if (!description) return { ok: false, error: "There is no text to analyze." };
  if (description.length > ISSUELINT_LIMITS.description) {
    const over = description.length - ISSUELINT_LIMITS.description;
    return {
      ok: false,
      error: `IssueLint accepts up to ${ISSUELINT_LIMITS.description.toLocaleString("en-US")} characters. Trim ${over.toLocaleString("en-US")} more before analyzing.`,
    };
  }
  const title = deriveTitle(pageTitle, description);
  if (!title) return { ok: false, error: "Add a title line to the text before analyzing." };
  if (title.length + description.length > ISSUELINT_LIMITS.total) {
    return { ok: false, error: `Title and text together must stay under ${ISSUELINT_LIMITS.total.toLocaleString("en-US")} characters.` };
  }
  return { ok: true, value: { title, description, type: "General", domain: "Other" } };
}

/** Client-side mirror of the Worker's PREVIEW_TOKEN shape check, for a clearer message. Not a security control. */
export function checkPreviewCode(code: string): string | null {
  const value = code.trim();
  if (!value) return "Enter your IssueLint preview access code in Settings.";
  if (/\s/.test(value)) return "The preview access code cannot contain spaces.";
  if (value.length < ISSUELINT_LIMITS.minPreviewCode) {
    return `The preview access code is at least ${ISSUELINT_LIMITS.minPreviewCode} characters long.`;
  }
  return null;
}

export interface Target {
  url: string;
  originPattern: string;
}

/** Resolves the URL to POST to for the selected mode. */
export function resolveTarget(settings: Pick<Settings, "mode" | "serverUrl" | "apiUrl">): Result<Target> {
  if (settings.mode === "custom") {
    const check = checkApiUrl(settings.apiUrl);
    return check.ok ? { ok: true, value: { url: check.url, originPattern: check.originPattern } } : check;
  }
  const base = checkApiUrl(settings.serverUrl);
  if (!base.ok) return base;
  const url = new URL(ISSUELINT_PATHS[settings.mode], base.url).toString();
  return { ok: true, value: { url, originPattern: base.originPattern } };
}

export interface Clip {
  url: string;
  title: string;
  markdown: string;
}

/** Builds the request body for the selected mode. */
export function buildRequestBody(mode: BackendMode, clip: Clip): Result<IssueLintTask | AnalyzeRequest> {
  if (mode === "custom") {
    const markdown = clip.markdown.trim();
    if (!markdown) return { ok: false, error: "There is no text to analyze." };
    return { ok: true, value: { source_url: clip.url, page_title: clip.title, markdown } };
  }
  return buildIssueLintTask(clip.title, clip.markdown);
}
