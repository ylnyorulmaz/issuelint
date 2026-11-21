export type SourceMode = "selection" | "modal" | "page";

export interface ExtractionResult {
  title: string;
  url: string;
  markdown: string;
  sourceMode: SourceMode;
  /** True when the Markdown was cut at MAX_EXTRACT_CHARS. */
  truncated: boolean;
}

/** Hard cap on what the content script hands back; the UI shows a separate 8,000-char soft limit. */
export const MAX_EXTRACT_CHARS = 100_000;
export const SOFT_LIMIT_CHARS = 8_000;

/** Messages from the service worker to the side panel. */
export type PanelMessage = { type: "clipper:extract"; tabId: number };

/** Exact request body sent to the backend. */
export interface AnalyzeRequest {
  source_url: string;
  page_title: string;
  markdown: string;
}
