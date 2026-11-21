import { ApiError, postAnalysis } from "./lib/api.ts";
import { buildRequestBody, checkPreviewCode, ISSUELINT_LIMITS, resolveTarget } from "./lib/issuelint.ts";
import { mockAnalyze } from "./lib/mock.ts";
import {
  dimensionLabel, groupByDimension, normalizeScorecard, ScorecardError, STATUS_LABELS,
  type DimensionResult, type Mark, type Scorecard, type ScorecardFinding,
} from "./lib/scorecard.ts";
import {
  DEFAULT_SETTINGS, isIssueLintMode, loadSettings, MODE_LABELS, saveSettings, type BackendMode, type Settings,
} from "./lib/settings.ts";
import { SOFT_LIMIT_CHARS, type ExtractionResult, type PanelMessage, type SourceMode } from "./lib/types.ts";

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  reextract: $<HTMLButtonElement>("reextract"),
  settingsToggle: $<HTMLButtonElement>("settings-toggle"),
  settings: $<HTMLElement>("settings"),
  settingsForm: $<HTMLFormElement>("settings-form"),
  mode: $<HTMLSelectElement>("mode"),
  serverUrl: $<HTMLInputElement>("server-url"),
  serverUrlField: $<HTMLElement>("server-url-field"),
  apiUrl: $<HTMLInputElement>("api-url"),
  apiUrlField: $<HTMLElement>("api-url-field"),
  apiKeyLabel: $<HTMLElement>("api-key-label"),
  privacyHint: $<HTMLElement>("privacy-hint"),
  backendBadge: $<HTMLElement>("backend-badge"),
  limitHint: $<HTMLElement>("limit-hint"),
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
/** Origin pattern Chrome has already granted for the current backend, if any. */
let grantedPattern: string | null = null;
let extraction: ExtractionResult | null = null;
let extractedTabId: number | null = null;
let extracting = false;
let analysis: AbortController | null = null;

const SOURCE_LABELS: Record<SourceMode, string> = { selection: "Selection", modal: "Modal", page: "Full Page" };

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
  ui.modePill.textContent = SOURCE_LABELS[result.sourceMode];
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
  const n = ui.markdown.value.trim().length;
  const hard = isIssueLintMode(settings.mode);
  const limit = hard ? ISSUELINT_LIMITS.description : SOFT_LIMIT_CHARS;
  ui.charCount.textContent = `${n.toLocaleString()} / ${limit.toLocaleString()}`;
  ui.charCount.dataset.level = n === 0 ? "empty" : n > limit ? "over" : n > limit * 0.85 ? "near" : "ok";
  ui.charCount.title = hard
    ? `IssueLint accepts up to ${limit.toLocaleString()} characters of task text.`
    : n > limit
      ? "Above the recommended 8,000 characters. Trim unrelated content for a sharper review."
      : "Recommended maximum: 8,000 characters.";
  const overHard = hard && n > limit;
  ui.limitHint.hidden = !overHard;
  ui.limitHint.textContent = overHard
    ? `IssueLint accepts up to ${limit.toLocaleString()} characters. Trim ${(n - limit).toLocaleString()} more to analyze.`
    : "";
  ui.copy.disabled = n === 0;
  ui.analyze.disabled = n === 0 || overHard || !!analysis;
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
function requestOrigin(pattern: string): Promise<boolean> {
  // Must be called before any await in a click handler so Chrome can show the prompt.
  return chrome.permissions.request({ origins: [pattern] }).then(
    (ok) => {
      if (ok) grantedPattern = pattern;
      return ok;
    },
    () => false,
  );
}

async function analyzeTask() {
  if (!ui.markdown.value.trim() || analysis) return;
  const mode = settings.mode;

  // Everything before the permission prompt stays synchronous to keep the click's user gesture.
  const body = buildRequestBody(mode, {
    url: extraction?.url ?? "",
    title: extraction?.title ?? "",
    markdown: ui.markdown.value,
  });
  if (!body.ok) {
    showNotice(body.error);
    return;
  }
  let target: { url: string; originPattern: string } | null = null;
  if (!settings.mockMode) {
    const resolved = resolveTarget(settings);
    if (!resolved.ok) {
      openSettings();
      showNotice(`${resolved.error} Or turn on Mock mode in Settings to try the UI.`);
      return;
    }
    if (isIssueLintMode(mode)) {
      const codeError = checkPreviewCode(settings.apiKey);
      if (codeError) {
        openSettings();
        showNotice(codeError);
        return;
      }
    }
    target = resolved.value;
    if (grantedPattern !== target.originPattern && !(await requestOrigin(target.originPattern))) {
      showNotice(`Access to ${new URL(target.url).hostname} was not granted, so nothing was sent.`);
      return;
    }
  }

  clearNotice();
  const controller = new AbortController();
  analysis = controller;
  setLoading(true);
  try {
    const raw = target
      ? await postAnalysis({ url: target.url, body: body.value, apiKey: settings.apiKey, signal: controller.signal })
      : await mockAnalyze(mode, controller.signal);
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
        h("span", { text: settings.mockMode ? "Generating mock scorecard…" : loadingText(settings.mode) })),
      h("div", { class: "skeleton" }), h("div", { class: "skeleton short" }), h("div", { class: "skeleton" }),
    );
  }
}

function loadingText(mode: BackendMode): string {
  if (mode === "quick_scan") return "Running Quick Scan…";
  if (mode === "analyze_v2") return "Running the Decision review… this can take a minute.";
  return "Waiting for the API…";
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
  const sample = settings.mockMode ? h("span", { class: "pill pill-mock", text: "Sample data" }) : null;
  const parts: (Node | null)[] = [];

  if (card.kind === "quick_scan") {
    parts.push(
      h("div", { class: "result-head" },
        h("span", { class: `status ${card.counts.gaps ? "status-needs_clarification" : "status-quiet"}`,
          text: `Quick Scan · ${card.counts.gaps} flagged` }),
        sample),
      h("p", { class: "muted note", text: "✓ means nothing was flagged for that gate, not that the task is correct. ✕ means Gemini flagged a gap. Quick Scan gives no evidence; use Analyze v2 for reasons and quotes." }),
      checklist(card.dimensions, false),
    );
  } else if (card.kind === "decision") {
    parts.push(
      h("div", { class: "result-head" },
        h("span", { class: `status ${card.counts.gaps ? "status-needs_clarification" : "status-quiet"}`,
          text: `Decision review · ${card.counts.gaps} gap${card.counts.gaps === 1 ? "" : "s"}` }),
        sample),
      counts(card),
      auditNote(card),
      card.findings.length
        ? h("div", { class: "findings" }, ...groupByDimension(card.findings).map(([dim, items], i) => findingGroup(dim, items, i === 0)))
        : null,
      h("h3", { text: "All gates" }),
      checklist(card.dimensions, true),
      h("p", { class: "muted note", text: "P(Clear) is Gemini's screening probability, not a verified accuracy. Gates marked ? were not verified and are not a pass." }),
    );
  } else {
    parts.push(
      h("div", { class: "result-head" },
        h("span", { class: `status status-${card.status}`, text: STATUS_LABELS[card.status] }),
        sample),
      counts(card),
      card.summary ? h("p", { class: "summary", text: card.summary }) : null,
      card.findings.length
        ? h("div", { class: "findings" }, ...groupByDimension(card.findings).map(([dim, items], i) => findingGroup(dim, items, i === 0)))
        : h("p", { class: "muted", text: "No findings reported." }),
    );
    const passed = card.dimensions.filter((d) => d.mark !== "issue");
    if (passed.length) {
      parts.push(h("div", { class: "passed" },
        h("h3", { text: "Other dimensions" }),
        h("ul", { class: "chips" }, ...passed.map((d) =>
          h("li", { class: `chip chip-${d.mark === "pass" ? "clear" : "na"}`,
            text: `${d.mark === "pass" ? "✓" : "–"} ${dimensionLabel(d.dimension)}`,
            attrs: { title: d.mark === "pass" ? "Clear" : "Not applicable" } })))));
    }
  }

  parts.push(h("details", { class: "raw" },
    h("summary", { text: "Raw response" }),
    h("pre", { class: "mono", text: JSON.stringify(raw, null, 2).slice(0, 50_000) })));

  ui.results.hidden = false;
  ui.results.replaceChildren(...parts.filter((p): p is Node => !!p));
}

function counts(card: Scorecard) {
  return h("div", { class: `counts${card.counts.unverified ? " counts-4" : ""}` },
    countTile("Gaps", card.counts.gaps, "gap"),
    countTile("Clear", card.counts.clear, "clear"),
    countTile("N/A", card.counts.notApplicable, "na"),
    card.counts.unverified ? countTile("Unverified", card.counts.unverified, "unverified") : null);
}

function auditNote(card: Scorecard) {
  const audit = card.audit;
  if (!audit) return null;
  if (audit.status === "unavailable") {
    return h("p", { class: "audit-note audit-unavailable",
      text: audit.selected.length
        ? "The second-pass GPT-OSS audit was unavailable, so gates that needed review are shown as unverified."
        : "Gemini was confident on every gate, so no second-pass audit ran." });
  }
  if (audit.status === "partial") {
    return h("p", { class: "audit-note audit-partial",
      text: `Audit partially completed: ${audit.unverified.map(dimensionLabel).join(", ") || "some gates"} could not be verified.` });
  }
  return audit.selected.length
    ? h("p", { class: "audit-note", text: `GPT-OSS independently reviewed ${audit.selected.length} gate${audit.selected.length === 1 ? "" : "s"} with P(Clear) < ${audit.threshold}.` })
    : null;
}

const MARK_ICON: Record<Mark, string> = { pass: "✓", issue: "✕", not_applicable: "–", unverified: "?" };
const MARK_TEXT: Record<Mark, string> = { pass: "Nothing flagged", issue: "Gap", not_applicable: "Not applicable", unverified: "Not verified" };

/** Static per-gate list. Quick Scan folds N/A into ✓ ("nothing flagged"), as the web app does. */
function checklist(dimensions: DimensionResult[], detailed: boolean) {
  return h("ul", { class: "checklist" }, ...dimensions.map((d) => {
    const mark: Mark = !detailed && d.mark === "not_applicable" ? "pass" : d.mark;
    const meta = detailed
      ? [d.source === "gpt-oss" ? "GPT-OSS" : d.source === "gemini" ? "Gemini" : "",
         d.pClear !== undefined ? `P(Clear) ${Math.round(d.pClear * 100)}%` : ""].filter(Boolean).join(" · ")
      : "";
    return h("li", { class: `check check-${mark}`, attrs: { title: MARK_TEXT[d.mark] } },
      h("span", { class: "check-icon", text: MARK_ICON[mark], attrs: { "aria-label": MARK_TEXT[d.mark] } }),
      h("span", { class: "check-label", text: dimensionLabel(d.dimension) }),
      meta ? h("span", { class: "check-meta", text: meta }) : null);
  }));
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
  ui.mode.value = settings.mode;
  ui.serverUrl.value = settings.serverUrl;
  ui.apiUrl.value = settings.apiUrl;
  ui.apiKey.value = settings.apiKey;
  ui.mockMode.checked = settings.mockMode;
  syncModeFields(settings.mode);
  applyBadges();
}

function applyBadges() {
  ui.mockBadge.hidden = !settings.mockMode;
  ui.backendBadge.textContent = settings.mode === "quick_scan" ? "Quick Scan" : settings.mode === "analyze_v2" ? "Analyze v2" : "Custom";
  ui.backendBadge.title = MODE_LABELS[settings.mode];
  updateCount();
}

/** Shows the fields that apply to the mode currently selected in the form (not yet saved). */
function syncModeFields(mode: BackendMode) {
  const issuelint = isIssueLintMode(mode);
  ui.serverUrlField.hidden = !issuelint;
  ui.apiUrlField.hidden = issuelint;
  ui.apiKeyLabel.textContent = issuelint ? "Preview access code" : "API key (optional)";
  ui.privacyHint.textContent = mode === "quick_scan"
    ? "Quick Scan sends the title and text to IssueLint, which asks Google Gemini to screen it. Nothing is sent in Mock mode."
    : mode === "analyze_v2"
      ? "Analyze v2 sends the title and text to IssueLint, which uses Google Gemini and Cloudflare Workers AI (GPT-OSS). Nothing is sent in Mock mode."
      : "Sends the page URL, title and Markdown to your endpoint. Nothing is sent in Mock mode.";
}

function openSettings() {
  ui.settings.hidden = false;
  ui.settingsToggle.setAttribute("aria-expanded", "true");
}

function setSettingsStatus(text: string, kind: "ok" | "error") {
  ui.settingsStatus.textContent = text;
  ui.settingsStatus.dataset.kind = kind;
}

function onSaveSettings(event: SubmitEvent) {
  event.preventDefault();
  const next: Settings = {
    mode: ui.mode.value as BackendMode,
    serverUrl: ui.serverUrl.value.trim() || DEFAULT_SETTINGS.serverUrl,
    apiUrl: ui.apiUrl.value.trim(),
    apiKey: ui.apiKey.value.trim(),
    mockMode: ui.mockMode.checked,
  };
  const target = resolveTarget(next);
  const needsTarget = !next.mockMode || (isIssueLintMode(next.mode) ? true : !!next.apiUrl);
  if (!target.ok && needsTarget) {
    setSettingsStatus(next.mode === "custom" && !next.apiUrl ? "Enter an API URL, or keep Mock mode on." : target.error, "error");
    return;
  }
  if (!next.mockMode && isIssueLintMode(next.mode)) {
    const codeError = checkPreviewCode(next.apiKey);
    if (codeError) {
      setSettingsStatus(codeError, "error");
      return;
    }
  }
  // Ask for the backend origin while we still hold the click's user gesture (skipped in Mock mode).
  const permission = target.ok && !next.mockMode ? requestOrigin(target.value.originPattern) : Promise.resolve(true);

  void (async () => {
    await saveSettings(next);
    settings = next;
    const granted = await permission;
    applySettingsToForm();
    if (!granted) setSettingsStatus("Saved, but access to the server was not granted. You will be asked again on Analyze.", "error");
    else setSettingsStatus("Saved", "ok");
  })();
}

async function refreshGrantedPattern() {
  const target = resolveTarget(settings);
  grantedPattern = target.ok && (await chrome.permissions.contains({ origins: [target.value.originPattern] }))
    ? target.value.originPattern
    : null;
}

// ---------- Wiring ----------
ui.reextract.addEventListener("click", () => void extract());
ui.copy.addEventListener("click", () => void copyMarkdown());
ui.analyze.addEventListener("click", () => void analyzeTask());
ui.cancel.addEventListener("click", () => analysis?.abort());
ui.markdown.addEventListener("input", updateCount);
ui.settingsForm.addEventListener("submit", onSaveSettings);
ui.mode.addEventListener("change", () => syncModeFields(ui.mode.value as BackendMode));
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
    await refreshGrantedPattern();
    applyBadges();
  });
});

async function init() {
  settings = await loadSettings();
  await refreshGrantedPattern();
  applySettingsToForm();
  await extract();
}

void init();
