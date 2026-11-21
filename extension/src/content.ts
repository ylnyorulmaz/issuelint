/**
 * Injected on demand via chrome.scripting.executeScript (activeTab or a granted site permission).
 * It never runs automatically, never modifies the page, and never sends data anywhere itself:
 * it only defines an extraction function the side panel calls and returns the result.
 */
import Defuddle from "defuddle";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { cleanupMarkdown, truncateMarkdown } from "./lib/markdown.ts";
import { MAX_EXTRACT_CHARS, type ExtractionResult, type SourceMode } from "./lib/types.ts";

const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
const MIN_MODAL_TEXT = 200;
const LAYOUT_SELECTOR = "nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary']";
const MAX_PRUNE_ELEMENTS = 25_000;

/** Elements that never carry task content. */
const NOISE_SELECTOR = [
  "script", "style", "noscript", "template", "iframe", "object", "embed", "canvas", "svg",
  "link", "meta", "button", "select", "[hidden]", '[role="toolbar"]', '[role="menu"]',
  '[role="menubar"]', '[role="tooltip"]', '[role="tablist"]', '[role="progressbar"]',
  'input:not([type="checkbox"])',
].join(",");

function isHidden(el: Element): boolean {
  if (!(el instanceof HTMLElement) || el instanceof HTMLDetailsElement) return false;
  const style = getComputedStyle(el);
  return style.display === "none" || (style.visibility === "hidden" && style.display !== "contents");
}

/** Clones `root`, dropping subtrees that are not rendered on the live page (closed menus, templates, etc.). */
function cloneRendered<T extends Node>(root: T, liveRoot: Element): T {
  const clone = root.cloneNode(true) as T;
  const cloneRoot = clone instanceof Document ? clone.documentElement : (clone as unknown as Element);
  const live = liveRoot.querySelectorAll("*");
  const copy = cloneRoot.querySelectorAll("*");
  if (live.length !== copy.length || live.length > MAX_PRUNE_ELEMENTS) return clone;
  const remove: Element[] = [];
  let skip: Element | null = null;
  for (let i = 0; i < live.length; i++) {
    const el = live[i];
    if (skip && skip.contains(el)) continue;
    if (isHidden(el)) {
      remove.push(copy[i]);
      skip = el;
    }
  }
  for (const el of remove) el.remove();
  return clone;
}

function absolutize(root: ParentNode): void {
  const base = document.baseURI;
  for (const el of root.querySelectorAll<HTMLElement>("a[href], img[src]")) {
    const attr = el.tagName === "A" ? "href" : "src";
    const value = el.getAttribute(attr) ?? "";
    if (/^(javascript|data):/i.test(value.trim())) {
      el.removeAttribute(attr);
      continue;
    }
    try {
      el.setAttribute(attr, new URL(value, base).href);
    } catch {
      el.removeAttribute(attr);
    }
  }
}

function stripNoise(root: ParentNode): void {
  for (const el of root.querySelectorAll(NOISE_SELECTOR)) el.remove();
}

function textLength(el: Element): number {
  return (el instanceof HTMLElement ? el.innerText : el.textContent ?? "").trim().length;
}

function isRendered(el: Element): boolean {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.use(gfm);
  td.remove(["script", "style", "noscript", "template", "iframe", "button", "select"]);
  // Inline data: URIs and unlabeled decorative images only add noise.
  td.addRule("issuelintImages", {
    filter: "img",
    replacement: (_content, node) => {
      const img = node as HTMLImageElement;
      const src = img.getAttribute("src") ?? "";
      const alt = (img.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
      if (!alt || !/^https?:/i.test(src)) return alt;
      return `![${alt.replace(/[[\]]/g, "")}](${src})`;
    },
  });
  return td;
}

function toMarkdown(html: string | Node): string {
  return cleanupMarkdown(createTurndown().turndown(html as string));
}

function extractSelection(): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return null;
  const container = document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const fragment = range.cloneContents();
    // A selection inside one code block loses its <pre>; restore it so it stays fenced.
    const ancestor = range.commonAncestorContainer;
    const pre = (ancestor instanceof Element ? ancestor : ancestor.parentElement)?.closest("pre");
    if (pre && !fragment.querySelector("pre")) {
      const wrapper = document.createElement("pre");
      wrapper.textContent = fragment.textContent ?? "";
      container.append(wrapper);
    } else {
      container.append(fragment);
    }
  }
  stripNoise(container);
  absolutize(container);
  const markdown = toMarkdown(container);
  return markdown || selection.toString().trim();
}

function findModal(): Element | null {
  let best: Element | null = null;
  let bestLength = 0;
  for (const el of document.querySelectorAll(MODAL_SELECTOR)) {
    if (!isRendered(el)) continue;
    const length = textLength(el);
    if (length >= MIN_MODAL_TEXT && length > bestLength) {
      best = el;
      bestLength = length;
    }
  }
  return best;
}

function extractModal(modal: Element): string {
  const clone = cloneRendered(modal, modal);
  stripNoise(clone);
  absolutize(clone);
  return toMarkdown(clone);
}

function extractPage(): { markdown: string; title: string } {
  const clone = cloneRendered(document, document.documentElement);
  let html = "";
  let title = "";
  try {
    const result = new Defuddle(clone, {
      url: location.href,
      // Sync parse only; the clipper never lets Defuddle make network requests from the page.
      useAsync: false,
      fetch: () => Promise.reject(new Error("network disabled")),
    }).parse();
    html = result.content ?? "";
    title = result.title ?? "";
  } catch {
    // Fall back to the pruned body below.
  }
  // Work inside an inert <template> fragment: nothing in it loads resources or runs scripts.
  const template = document.createElement("template");
  if (html.trim()) {
    template.innerHTML = html;
  } else if (clone.body) {
    template.content.append(...Array.from(clone.body.childNodes));
    for (const el of template.content.querySelectorAll(LAYOUT_SELECTOR)) el.remove();
  }
  const container = template.content;
  stripNoise(container);
  absolutize(container);
  return { markdown: toMarkdown(container), title };
}

function extract(): ExtractionResult {
  let sourceMode: SourceMode = "page";
  let markdown = extractSelection();
  let title = "";
  if (markdown) {
    sourceMode = "selection";
  } else {
    const modal = findModal();
    if (modal) {
      markdown = extractModal(modal);
      sourceMode = "modal";
      title = modal.querySelector("h1, h2, [role='heading']")?.textContent?.trim() ?? "";
    }
    if (!markdown) {
      const page = extractPage();
      markdown = page.markdown;
      title = page.title;
      sourceMode = "page";
    }
  }
  const { text, truncated } = truncateMarkdown(markdown, MAX_EXTRACT_CHARS);
  return {
    title: (title || document.title || location.hostname).slice(0, 300),
    url: location.href,
    markdown: text,
    sourceMode,
    truncated,
  };
}

// Re-injection on "Re-extract" just replaces the function; there is no other page-side state.
(globalThis as { __issuelintClipperExtract?: () => ExtractionResult }).__issuelintClipperExtract = extract;
