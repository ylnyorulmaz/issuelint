import { ApiError, postAnalysis } from "./lib/api.ts";
import { backendLabel, charsLabel, gapLabel, gatesLabel } from "./lib/format.ts";
import { buildRequestBody, checkPreviewCode, ISSUELINT_LIMITS, resolveTarget } from "./lib/issuelint.ts";
import { mockAnalyze } from "./lib/mock.ts";
import {
  dimensionLabel, groupByDimension, normalizeScorecard, ScorecardError, STATUS_LABELS,
  type Mark, type Scorecard, type ScorecardFinding,
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
  backendBadgeText: $<HTMLElement>("backend-badge-text"),
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
  segments: Array.from(document.querySelectorAll<HTMLElement>(".segmented .seg")),
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
  setSegment(result.sourceMode);
  ui.pageTitle.textContent = result.title;
  setUrlBadge(result.url);
  ui.results.hidden = true;
  ui.results.replaceChildren();
  updateCount();
}

function setSegment(mode: SourceMode | null) {
  for (const seg of ui.segments) {
    const active = seg.dataset.mode === mode;
    seg.classList.toggle("is-active", active);
    if (active) seg.setAttribute("aria-current", "true");
    else seg.removeAttribute("aria-current");
    seg.title = active ? `Extracted from: ${SOURCE_LABELS[mode as SourceMode]}` : "";
  }
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
  ui.charCount.textContent = charsLabel(n, limit);
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
    flash(ui.copyStatus, "Press Ctrl/Cmd+C");
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
      resultsHead(),
      h("div", { class: "loading" },
        h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
        h("span", { text: settings.mockMode ? "Generating sample review…" : loadingText(settings.mode) })),
      h("div", { class: "skeleton" }), h("div", { class: "skeleton short" }), h("div", { class: "skeleton" }),
    );
  }
}

function loadingText(mode: BackendMode): string {
  if (mode === "quick_scan") return "Running Quick Scan…";
  if (mode === "analyze_v2") return "Running the Decision review… this can take a minute.";
  return "Waiting for the API…";
}

function resultsHead() {
  return h("div", { class: "card-head" },
    h("span", { class: "step", text: "02", attrs: { "aria-hidden": "true" } }),
    h("h2", { class: "kicker" }, h("span", { class: "sr-only", text: "02 " }), document.createTextNode("Review & findings")));
}

function renderError(message: string, requestId?: string) {
  ui.results.hidden = false;
  ui.results.replaceChildren(
    resultsHead(),
    h("div", { class: "result-error" },
      h("span", { class: "kicker kicker-gap", text: "Analysis failed" }),
      h("p", { text: message }),
      requestId ? h("small", { class: "meta mono", text: `Request ID ${requestId}` }) : null),
  );
}

const ENGINE_KICKER: Record<Scorecard["kind"], string> = {
  quick_scan: "Gemini screen",
  decision: "Decision engine",
  generic: "Custom backend",
};

function renderScorecard(card: Scorecard, raw: unknown) {
  const modePill = h("span", { class: "pill" }, h("i", { class: "dot" }),
    document.createTextNode(card.kind === "quick_scan" ? "Quick Scan" : card.kind === "decision" ? "Decision v2" : "Custom"));
  const sample = settings.mockMode ? h("span", { class: "pill pill-mock" }, h("i", { class: "dot" }), document.createTextNode("Sample data")) : null;

  const headline = card.kind === "generic" && card.status !== "unknown"
    ? h("p", { class: `headline status-${card.status}`, text: STATUS_LABELS[card.status] })
    : h("p", { class: `headline ${card.counts.gaps ? "status-needs_clarification" : "status-quiet"}`,
        text: card.counts.gaps
          ? `${card.counts.gaps} ${gapLabel(card.counts.gaps).toLowerCase()} flagged`
          : card.kind === "quick_scan" ? "Nothing flagged" : "No gaps found" });

  const parts: (Node | null)[] = [
    resultsHead(),
    h("div", { class: "engine-row" }, h("span", { class: "kicker kicker-khaki", text: ENGINE_KICKER[card.kind] }), modePill, sample),
    headline,
    stats(card),
    card.counts.unverified
      ? h("p", { class: "unverified-note" }, h("span", { class: "mark-dot mark-unverified", attrs: { "aria-hidden": "true" } }),
          document.createTextNode(`${gatesLabel(card.counts.unverified)} not verified — not counted as clear.`))
      : null,
    auditNote(card),
    card.summary ? h("p", { class: "summary", text: card.summary }) : null,
    gateList(card),
  ];

  if (card.kind === "quick_scan") {
    parts.push(h("p", { class: "note", text: "✓ means nothing was flagged for that gate, not that the task is correct. Quick Scan gives no evidence; switch to Analyze v2 in Settings for reasons and quotes." }));
  } else if (card.kind === "decision") {
    parts.push(h("p", { class: "note", text: "P(Clear) is Gemini's screening probability, not a verified accuracy." }));
  }

  parts.push(h("details", { class: "raw" },
    h("summary", { text: "Raw response" }),
    h("pre", { class: "mono", text: JSON.stringify(raw, null, 2).slice(0, 50_000) })));

  ui.results.hidden = false;
  ui.results.replaceChildren(...parts.filter((p): p is Node => !!p));
}

function stats(card: Scorecard) {
  const tile = (value: number, label: string, kind: string) =>
    h("div", { class: `stat stat-${kind}` },
      h("span", { class: "stat-value", text: String(value) }),
      h("span", { class: "stat-label", text: label }));
  return h("div", { class: "stats" },
    tile(card.counts.gaps, gapLabel(card.counts.gaps), "gap"),
    tile(card.counts.clear, "Clear", "clear"),
    tile(card.counts.notApplicable, "Not applicable", "na"));
}

function auditNote(card: Scorecard) {
  const audit = card.audit;
  if (!audit) return null;
  if (audit.status === "unavailable") {
    return h("p", { class: "audit-note audit-warn",
      text: audit.selected.length
        ? "The second-pass GPT-OSS audit was unavailable, so gates that needed review are shown as not verified."
        : "Gemini was confident on every gate, so no second-pass audit ran." });
  }
  if (audit.status === "partial") {
    return h("p", { class: "audit-note audit-warn",
      text: `Audit partially completed: ${audit.unverified.map(dimensionLabel).join(", ") || "some gates"} could not be verified.` });
  }
  return audit.selected.length
    ? h("p", { class: "audit-note", text: `GPT-OSS independently reviewed ${gatesLabel(audit.selected.length)} with P(Clear) < ${audit.threshold}.` })
    : null;
}

type PillMark = Mark | "flag_free";
const PILL: Record<PillMark, { icon: string; text: string }> = {
  issue: { icon: "✕", text: "Gap" },
  pass: { icon: "✓", text: "Clear" },
  not_applicable: { icon: "–", text: "N/A" },
  unverified: { icon: "?", text: "Not verified" },
  flag_free: { icon: "✓", text: "Nothing flagged" },
};

function statusPill(mark: PillMark) {
  const p = PILL[mark];
  return h("span", { class: `gate-pill gate-${mark}` },
    h("span", { attrs: { "aria-hidden": "true" }, text: p.icon }),
    document.createTextNode(p.text));
}

/** One hairline-divided list of gates. Gap gates with findings expand to reasons, quotes and questions. */
function gateList(card: Scorecard) {
  const byDim = new Map(groupByDimension(card.findings));
  const rows: { dimension: string; mark: Mark; meta: string }[] = card.dimensions.map((d) => ({
    dimension: d.dimension,
    mark: d.mark,
    meta: card.kind === "decision"
      ? [d.source === "gpt-oss" ? "GPT-OSS" : d.source === "gemini" ? "Gemini" : "",
         d.pClear !== undefined ? `P(Clear) ${Math.round(d.pClear * 100)}%` : ""].filter(Boolean).join(" · ")
      : "",
  }));
  // Findings whose dimension has no gate row (generic backends) still get a row.
  for (const dim of byDim.keys()) {
    if (!rows.some((r) => r.dimension === dim)) rows.push({ dimension: dim, mark: "issue", meta: "" });
  }
  if (!rows.length) return h("p", { class: "note", text: "No findings reported." });

  let opened = false;
  return h("ul", { class: "gates" }, ...rows.map((r) => {
    // Quick Scan folds N/A into "nothing flagged", as the web app does.
    const pill: PillMark = card.kind === "quick_scan" && r.mark !== "issue" ? "flag_free" : r.mark;
    const label = h("span", { class: "gate-label", text: dimensionLabel(r.dimension) });
    const meta = r.meta ? h("span", { class: "gate-meta", text: r.meta }) : null;
    const findings = byDim.get(r.dimension);
    if (findings?.length) {
      const details = h("details", { class: "gate-details" },
        h("summary", { class: "gate-row" }, h("span", { class: "chev", attrs: { "aria-hidden": "true" }, text: "›" }), label, meta, statusPill(pill)),
        h("div", { class: "gate-body" }, ...findings.map(findingItem)));
      if (!opened) details.open = opened = true;
      return h("li", { class: `gate gate-has-findings mark-${r.mark}` }, details);
    }
    return h("li", { class: `gate mark-${r.mark}` }, h("div", { class: "gate-row" }, h("span", { class: "chev chev-blank", attrs: { "aria-hidden": "true" } }), label, meta, statusPill(pill)));
  }));
}

function findingItem(f: ScorecardFinding) {
  return h("article", { class: "finding" },
    h("div", { class: "finding-head" },
      f.severity ? h("span", { class: `sev sev-${f.severity.replace(/[^a-z]/g, "")}`, text: f.severity }) : null,
      h("h4", { text: f.issue })),
    f.detail ? h("p", { class: "finding-detail", text: f.detail }) : null,
    ...f.evidence.map((q) => h("blockquote", { text: q })),
    f.question ? h("p", { class: "question" }, h("span", { class: "question-label", text: "Ask" }), document.createTextNode(f.question)) : null);
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
  ui.backendBadgeText.textContent = backendLabel(settings.mode);
  ui.backendBadge.title = `Backend: ${MODE_LABELS[settings.mode]}`;
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
