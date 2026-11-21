import { analyzeRemote, ApiError } from "./lib/api.ts";
import { checkApiUrl } from "./lib/api-url.ts";
import { mockAnalyze } from "./lib/mock.ts";
import {
  dimensionLabel, groupByDimension, normalizeScorecard, ScorecardError, STATUS_LABELS,
  type Scorecard, type ScorecardFinding,
} from "./lib/scorecard.ts";
import { DEFAULT_SETTINGS, hasApiPermission, loadSettings, saveSettings, type Settings } from "./lib/settings.ts";
import { SOFT_LIMIT_CHARS, type ExtractionResult, type PanelMessage, type SourceMode } from "./lib/types.ts";

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  reextract: $<HTMLButtonElement>("reextract"),
  settingsToggle: $<HTMLButtonElement>("settings-toggle"),
  settings: $<HTMLElement>("settings"),
  settingsForm: $<HTMLFormElement>("settings-form"),
  apiUrl: $<HTMLInputElement>("api-url"),
  apiKey: $<HTMLInputElement>("api-key"),
  apiKeyReveal: $<HTMLButtonElement>("api-key-reveal"),
  mockMode: $<HTMLInputElement>("mock-mode"),
  settingsStatus: $<HTMLElement>("settings-status"),
  urlBadge: $<HTMLElement>("url-badge"),
  mockBadge: $<HTMLElement>("mock-badge"),
  notice: $<HTMLElement>("notice"),
  noticeText: $<HTMLElement>("notice-text"),
  noticeAction: $<HTMLButtonElement>("notice-action"),
  modePill: $<HTMLElement>("mode-pill"),
  charCount: $<HTMLElement>("char-count"),
  pageTitle: $<HTMLElement>("page-title"),
  markdown: $<HTMLTextAreaElement>("markdown"),
  copy: $<HTMLButtonElement>("copy"),
  copyStatus: $<HTMLElement>("copy-status"),
  analyze: $<HTMLButtonElement>("analyze"),
  cancel: $<HTMLButtonElement>("cancel"),
  results: $<HTMLElement>("results"),
};

/** Tiny element builder; all user/page/API text goes through textContent, never innerHTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

// ---------- State ----------
let settings: Settings = { ...DEFAULT_SETTINGS };
let apiPermission = false;
let extraction: ExtractionResult | null = null;
let extractedTabId: number | null = null;
let extracting = false;
let analysis: AbortController | null = null;

const MODE_LABELS: Record<SourceMode, string> = { selection: "Selection", modal: "Modal", page: "Full Page" };

// ---------- Notices ----------
function showNotice(message: string, kind: "error" | "info" = "error", action?: { label: string; run: () => void }) {
  ui.notice.hidden = false;
  ui.notice.dataset.kind = kind;
  ui.noticeText.textContent = message;
  ui.noticeAction.hidden = !action;
  ui.noticeAction.onclick = action ? () => action.run() : null;
  if (action) ui.noticeAction.textContent = action.label;
}
function clearNotice() {
  ui.notice.hidden = true;
  ui.noticeAction.onclick = null;
}

// ---------- Extraction ----------
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isRestrictedUrl(url: string | undefined): boolean {
  return !!url && /^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-search):/i.test(url)
    || !!url && /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

function describeInjectionError(err: unknown, tab: chrome.tabs.Tab) {
  const message = err instanceof Error ? err.message : String(err);
  if (isRestrictedUrl(tab.url) || /cannot be scripted|extensions gallery|chrome:\/\//i.test(message)) {
    showNotice("Chrome does not allow extensions to read this page (browser or Web Store pages). Open the task page and try again.");
    return;
  }
  if (/permission|cannot access/i.test(message)) {
    let origin = "";
    try {
      origin = tab.url ? new URL(tab.url).origin : "";
    } catch { /* unknown origin */ }
    const grant = origin && /^https?:/.test(origin)
      ? {
          label: `Always allow on ${new URL(origin).hostname}`,
          run: () => {
            chrome.permissions.request({ origins: [`${origin}/*`] }).then((ok) => {
              if (ok) void extract();
            }, () => undefined);
          },
        }
      : undefined;
    showNotice(
      "IssueLint needs access to this page. Click the IssueLint toolbar icon (or press Alt+Shift+L) to grant one-time access, then Re-extract.",
      "error",
      grant,
    );
    return;
  }
  showNotice("Could not extract this page. Reload the tab and try again.");
}

async function extract(tabId?: number) {
  if (extracting) return;
  extracting = true;
  ui.reextract.disabled = true;
  ui.reextract.classList.add("is-busy");
  try {
    const tab = tabId !== undefined ? await chrome.tabs.get(tabId) : await activeTab();
    if (!tab?.id) {
      showNotice("No active tab found.");
      return;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (globalThis as { __issuelintClipperExtract?: () => unknown }).__issuelintClipperExtract?.(),
      });
      const result = injection?.result as ExtractionResult | undefined;
      if (!result || typeof result.markdown !== "string") throw new Error("Extraction returned no result");
      clearNotice();
      setExtraction(result, tab.id);
      if (!result.markdown.trim()) {
        showNotice("No readable text was found on this page. Try selecting the task text and Re-extract.", "info");
      } else if (result.truncated) {
        showNotice("The page was very long, so the clip was cut at 100,000 characters. Trim it before analyzing.", "info");
      }
    } catch (err) {
      describeInjectionError(err, tab);
    }
  } finally {
    extracting = false;
    ui.reextract.disabled = false;
    ui.reextract.classList.remove("is-busy");
  }
}

function setExtraction(result: ExtractionResult, tabId: number) {
  extraction = result;
  extractedTabId = tabId;
  ui.markdown.value = result.markdown;
  ui.modePill.hidden = false;
  ui.modePill.textContent = MODE_LABELS[result.sourceMode];
  ui.modePill.dataset.mode = result.sourceMode;
  ui.pageTitle.textContent = result.title;
  setUrlBadge(result.url);
  ui.results.hidden = true;
  ui.results.replaceChildren();
  updateCount();
}

function setUrlBadge(url: string) {
  ui.urlBadge.title = url;
  try {
    const u = new URL(url);
    ui.urlBadge.textContent = `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    ui.urlBadge.textContent = url;
  }
  ui.urlBadge.classList.remove("is-stale");
}

function updateCount() {
  const n = ui.markdown.value.length;
  ui.charCount.textContent = `${n.toLocaleString()} / ${SOFT_LIMIT_CHARS.toLocaleString()}`;
  ui.charCount.dataset.level = n === 0 ? "empty" : n > SOFT_LIMIT_CHARS ? "over" : n > SOFT_LIMIT_CHARS * 0.85 ? "near" : "ok";
  ui.charCount.title = n > SOFT_LIMIT_CHARS
    ? "Above the recommended 8,000 characters. Trim unrelated content for a sharper review."
    : "Recommended maximum: 8,000 characters.";
  const hasText = ui.markdown.value.trim().length > 0;
  ui.copy.disabled = !hasText;
  ui.analyze.disabled = !hasText || !!analysis;
}

function markStale(reason: string) {
  if (!extraction) return;
  ui.urlBadge.classList.add("is-stale");
  ui.urlBadge.title = `${extraction.url}\n${reason}`;
}

// ---------- Copy ----------
async function copyMarkdown() {
  try {
    await navigator.clipboard.writeText(ui.markdown.value);
    flash(ui.copyStatus, "Copied");
  } catch {
    ui.markdown.select();
    flash(ui.copyStatus, "Press Ctrl/Cmd+C to copy");
  }
}

function flash(el: HTMLElement, text: string) {
  el.textContent = text;
  window.setTimeout(() => {
    if (el.textContent === text) el.textContent = "";
  }, 2000);
}

// ---------- Analyze ----------
function requestApiPermission(): Promise<boolean> {
  const check = checkApiUrl(settings.apiUrl);
  if (!check.ok) return Promise.resolve(false);
  // Called synchronously from a click so Chrome shows the prompt.
  return chrome.permissions.request({ origins: [check.originPattern] }).then(
    (ok) => (apiPermission = ok),
    () => false,
  );
}

async function analyzeTask() {
  const markdown = ui.markdown.value.trim();
  if (!markdown || analysis) return;

  if (!settings.mockMode) {
    const check = checkApiUrl(settings.apiUrl);
    if (!check.ok) {
      openSettings();
      showNotice(`${check.error} Or turn on Mock mode in Settings to try the UI.`);
      return;
    }
    if (!apiPermission && !(await requestApiPermission())) {
      showNotice(`Access to ${new URL(check.url).hostname} was not granted, so the task was not sent.`);
      return;
    }
  }

  clearNotice();
  const controller = new AbortController();
  analysis = controller;
  setLoading(true);
  try {
    const raw = settings.mockMode
      ? await mockAnalyze(controller.signal)
      : await analyzeRemote(
          {
            source_url: extraction?.url ?? "",
            page_title: extraction?.title ?? "",
            markdown,
          },
          { apiUrl: settings.apiUrl, apiKey: settings.apiKey, signal: controller.signal },
        );
    renderScorecard(normalizeScorecard(raw), raw);
  } catch (err) {
    if (controller.signal.aborted) {
      ui.results.hidden = true;
      showNotice("Analysis cancelled.", "info");
    } else if (err instanceof ApiError) {
      renderError(err.message, err.requestId);
    } else if (err instanceof ScorecardError) {
      renderError(`Unexpected response format: ${err.message}`);
    } else {
      renderError("Something went wrong while analyzing the task.");
    }
  } finally {
    analysis = null;
    setLoading(false);
  }
}

function setLoading(loading: boolean) {
  ui.cancel.hidden = !loading;
  ui.analyze.textContent = loading ? "Analyzing…" : "Analyze Task";
  ui.analyze.classList.toggle("is-busy", loading);
  ui.results.setAttribute("aria-busy", String(loading));
  ui.markdown.readOnly = loading;
  updateCount();
  if (loading) {
    ui.results.hidden = false;
    ui.results.replaceChildren(
      h("div", { class: "loading" },
        h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
        h("span", { text: settings.mockMode ? "Generating mock scorecard…" : "Waiting for the API…" })),
      h("div", { class: "skeleton" }), h("div", { class: "skeleton short" }), h("div", { class: "skeleton" }),
    );
  }
}

function renderError(message: string, requestId?: string) {
  ui.results.hidden = false;
  ui.results.replaceChildren(
    h("div", { class: "result-error" },
      h("strong", { text: "Analysis failed" }),
      h("p", { text: message }),
      requestId ? h("small", { class: "muted mono", text: `Request ID: ${requestId}` }) : null),
  );
}

function renderScorecard(card: Scorecard, raw: unknown) {
  const header = h("div", { class: "result-head" },
    h("span", { class: `status status-${card.status}`, text: STATUS_LABELS[card.status] }),
    settings.mockMode ? h("span", { class: "pill pill-mock", text: "Sample data" }) : null);

  const counts = h("div", { class: "counts" },
    countTile("Gaps", card.counts.gaps, "gap"),
    countTile("Clear", card.counts.clear, "clear"),
    countTile("N/A", card.counts.notApplicable, "na"));

  const summary = card.summary ? h("p", { class: "summary", text: card.summary }) : null;

  const groups = groupByDimension(card.findings);
  const findings = groups.length
    ? h("div", { class: "findings" }, ...groups.map(([dim, items], i) => findingGroup(dim, items, i === 0)))
    : h("p", { class: "muted", text: "No findings reported." });

  const passed = card.dimensions.filter((d) => d.assessment !== "gap");
  const passedList = passed.length
    ? h("div", { class: "passed" },
        h("h3", { text: "Other dimensions" }),
        h("ul", { class: "chips" }, ...passed.map((d) =>
          h("li", { class: `chip chip-${d.assessment === "clear" ? "clear" : "na"}`,
            text: `${d.assessment === "clear" ? "✓" : "–"} ${dimensionLabel(d.dimension)}`,
            attrs: { title: d.assessment === "clear" ? "Clear" : "Not applicable" } }))))
    : null;

  const rawJson = h("details", { class: "raw" },
    h("summary", { text: "Raw response" }),
    h("pre", { class: "mono", text: JSON.stringify(raw, null, 2).slice(0, 50_000) }));

  ui.results.hidden = false;
  ui.results.replaceChildren(header, counts, summary ?? document.createTextNode(""), findings, passedList ?? document.createTextNode(""), rawJson);
}

function countTile(label: string, value: number, kind: string) {
  return h("div", { class: `count count-${kind}` },
    h("span", { class: "count-value", text: String(value) }),
    h("span", { class: "count-label", text: label }));
}

function findingGroup(dimension: string, items: ScorecardFinding[], open: boolean) {
  const details = h("details", { class: "group" },
    h("summary", {},
      h("span", { class: "group-title", text: dimensionLabel(dimension) }),
      h("span", { class: "group-count", text: String(items.length) })),
    ...items.map(findingItem));
  details.open = open;
  return details;
}

function findingItem(f: ScorecardFinding) {
  return h("article", { class: "finding" },
    h("div", { class: "finding-head" },
      f.severity ? h("span", { class: `sev sev-${f.severity.replace(/[^a-z]/g, "")}`, text: f.severity }) : null,
      h("h4", { text: f.issue })),
    f.detail ? h("p", { text: f.detail }) : null,
    ...f.evidence.map((q) => h("blockquote", { text: q })),
    f.question ? h("p", { class: "question" }, h("span", { class: "question-label", text: "Ask: " }), document.createTextNode(f.question)) : null);
}

// ---------- Settings ----------
function applySettingsToForm() {
  ui.apiUrl.value = settings.apiUrl;
  ui.apiKey.value = settings.apiKey;
  ui.mockMode.checked = settings.mockMode;
  ui.mockBadge.hidden = !settings.mockMode;
}

function openSettings() {
  ui.settings.hidden = false;
  ui.settingsToggle.setAttribute("aria-expanded", "true");
}

function onSaveSettings(event: SubmitEvent) {
  event.preventDefault();
  const next: Settings = {
    apiUrl: ui.apiUrl.value.trim(),
    apiKey: ui.apiKey.value.trim(),
    mockMode: ui.mockMode.checked,
  };
  const check = next.apiUrl ? checkApiUrl(next.apiUrl) : null;
  if (check && !check.ok) {
    ui.settingsStatus.textContent = check.error;
    ui.settingsStatus.dataset.kind = "error";
    return;
  }
  if (!next.mockMode && !check) {
    ui.settingsStatus.textContent = "Enter an API URL, or keep Mock mode on.";
    ui.settingsStatus.dataset.kind = "error";
    return;
  }
  // Ask for access to the API origin while we still have the click's user gesture.
  const permission = check?.ok
    ? chrome.permissions.request({ origins: [check.originPattern] }).catch(() => false)
    : Promise.resolve(false);

  void (async () => {
    await saveSettings(next);
    settings = next;
    apiPermission = await permission;
    applySettingsToForm();
    ui.settingsStatus.dataset.kind = check?.ok && !apiPermission && !next.mockMode ? "error" : "ok";
    ui.settingsStatus.textContent = check?.ok && !apiPermission && !next.mockMode
      ? "Saved, but access to the API host was not granted."
      : "Saved";
  })();
}

// ---------- Wiring ----------
ui.reextract.addEventListener("click", () => void extract());
ui.copy.addEventListener("click", () => void copyMarkdown());
ui.analyze.addEventListener("click", () => void analyzeTask());
ui.cancel.addEventListener("click", () => analysis?.abort());
ui.markdown.addEventListener("input", updateCount);
ui.settingsForm.addEventListener("submit", onSaveSettings);
ui.settingsToggle.addEventListener("click", () => {
  const open = ui.settings.hidden;
  ui.settings.hidden = !open;
  ui.settingsToggle.setAttribute("aria-expanded", String(open));
  if (open) ui.apiUrl.focus();
});
ui.apiKeyReveal.addEventListener("click", () => {
  const reveal = ui.apiKey.type === "password";
  ui.apiKey.type = reveal ? "text" : "password";
  ui.apiKeyReveal.textContent = reveal ? "Hide" : "Show";
  ui.apiKeyReveal.setAttribute("aria-pressed", String(reveal));
});

chrome.runtime.onMessage.addListener((message: PanelMessage) => {
  if (message?.type === "clipper:extract") void extract(message.tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (extractedTabId !== null && tabId !== extractedTabId) markStale("Active tab changed — click Re-extract to clip it.");
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === extractedTabId && info.status === "complete") markStale("The page reloaded — click Re-extract to refresh.");
});
chrome.storage.onChanged.addListener(() => {
  void loadSettings().then(async (s) => {
    settings = s;
    apiPermission = s.apiUrl ? await hasApiPermission(s.apiUrl) : false;
    ui.mockBadge.hidden = !s.mockMode;
  });
});

async function init() {
  settings = await loadSettings();
  apiPermission = settings.apiUrl ? await hasApiPermission(settings.apiUrl) : false;
  applySettingsToForm();
  updateCount();
  await extract();
}

void init();
