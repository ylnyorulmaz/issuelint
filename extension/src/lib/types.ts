export type SourceMode = "selection" | "modal" | "card" | "page";

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

/** Element picker ("Pick Card / Area"). The side panel starts it with chrome.tabs.sendMessage; the content
 *  script then opens a runtime port with this name and reports back over it. A closed port ends the picker. */
export const PICKER_PORT = "clipper-picker";
export type PickerCommand = { type: "START_ELEMENT_PICKER" } | { type: "CANCEL_ELEMENT_PICKER" };
export type PickerEvent =
  | { type: "ELEMENT_PICKED"; result: ExtractionResult }
  | { type: "ELEMENT_PICKER_CANCELLED"; reason: string };

/** Exact request body sent to the backend. */
export interface AnalyzeRequest {
  source_url: string;
  page_title: string;
  markdown: string;
}
