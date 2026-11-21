/**
 * Element picker for "Pick Card / Area" mode. Pure DOM, no dependencies.
 *
 * While active it adds exactly one overlay host (closed shadow root, pointer-events: none) and a set of
 * capture-phase listeners on `window`. Both are removed on pick, cancel, Escape, page hide or navigation.
 * Pointer/mouse/click events are swallowed while picking so the page's own handlers (open card, drag,
 * navigate) never run.
 */

export type PickerEndReason = "escape" | "cancelled" | "hidden" | "restarted" | "disconnected";
export type PickerOutcome =
  | { type: "picked"; element: Element; exact: boolean }
  | { type: "cancelled"; reason: PickerEndReason };

export interface PickerSession {
  cancel(reason?: PickerEndReason): void;
  readonly active: boolean;
}

export const PICKER_HOST_ATTR = "data-issuelint-picker";

/** Strong containers: almost always one card, drawer, dialog or task. The nearest one wins. */
const STRONG_SELECTOR = "article, [role='dialog'], [role='alertdialog'], [role='article'], dialog";
/** Weak containers: list items and sections. Used only when no strong container encloses them
 *  (so a checklist <li> inside a Jira drawer resolves to the drawer, a bare card <li> to itself). */
const WEAK_SELECTOR = "li, section, [role='listitem'], [role='region']";

/** Words in class names / data-testids that usually mark one card, drawer or issue container. */
const CARD_WORD = /(card|drawer|modal|issue|task|ticket)/i;
/** …unless the token names a part of a card (title, body, badge…). */
const PART_TOKEN = /(card|drawer|modal|issue|task|ticket)s?[-_.]?(title|name|header|heading|head|body|content|text|label|badges?|icons?|cover|footer|meta|details?|members?|actions?|avatars?|image|img|link|count|summary|description|key|status|assignee|date|menu|button|btn|overlay|backdrop|close)$/i;
/** …or a collection of cards (column, list, board). */
const COLLECTION_TOKEN = /((cards|issues|tasks|tickets)$)|([-_](list|lists|container|grid|column|columns|board|deck|lane|lanes|swimlane|group|groups|area|wrapper|backdrop|overlay|root|portal)$)/i;

const MIN_CARD_TEXT = 15;
const MIN_FALLBACK_TEXT = 40;
const BLOCK_TAGS = new Set(["DIV", "MAIN", "ASIDE", "FORM", "FIGURE", "DETAILS", "TD", "DD", "BLOCKQUOTE"]);

function textLen(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function tokenMarksCard(token: string): boolean {
  return CARD_WORD.test(token) && !PART_TOKEN.test(token) && !COLLECTION_TOKEN.test(token);
}

function looksLikeCard(el: Element): boolean {
  if (el.matches(STRONG_SELECTOR)) return true;
  const testId = el.getAttribute("data-testid") ?? el.getAttribute("data-test-id") ?? "";
  if (testId) {
    const last = testId.split(/[.\s/:]+/).filter(Boolean).pop() ?? "";
    if (tokenMarksCard(last)) return true;
  }
  const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") ?? "";
  return cls.split(/\s+/).some((t) => t && tokenMarksCard(t));
}

/** Parent element, crossing open shadow-root boundaries. */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isRootish(el: Element, doc: Document): boolean {
  return el === doc.body || el === doc.documentElement;
}

/** The page shell: covers nearly the whole viewport and holds nearly all the page text. */
function isPageShell(el: Element, doc: Document, bodyText: number): boolean {
  const view = doc.defaultView;
  if (!view) return false;
  const r = el.getBoundingClientRect();
  const visibleW = Math.max(0, Math.min(r.right, view.innerWidth) - Math.max(r.left, 0));
  const visibleH = Math.max(0, Math.min(r.bottom, view.innerHeight) - Math.max(r.top, 0));
  const coverage = (visibleW * visibleH) / Math.max(1, view.innerWidth * view.innerHeight);
  return coverage >= 0.95 && bodyText > 0 && textLen(el) >= bodyText * 0.9;
}

/**
 * Resolves the hovered node to the card/task container a user most likely means.
 * With `exact` (Shift held) the hovered element itself is used. Never returns <body> or <html>.
 */
export function resolveCardContainer(target: Node | null, exact = false, doc: Document = document): Element | null {
  let start: Element | null =
    target instanceof Element ? target : target?.parentElement ?? null;
  if (!start || isRootish(start, doc) || start.closest(`[${PICKER_HOST_ATTR}]`)) return null;
  if (exact) return start;

  const bodyText = doc.body ? textLen(doc.body) : 0;
  let weak: Element | null = null;
  let fallback: Element | null = null;
  for (let el: Element | null = start; el && !isRootish(el, doc); el = parentOf(el)) {
    if (isPageShell(el, doc, bodyText)) break;
    const len = textLen(el);
    if (looksLikeCard(el) && len >= MIN_CARD_TEXT) return el;
    if (!weak && el.matches(WEAK_SELECTOR) && len >= MIN_CARD_TEXT) weak = el;
    if (!fallback && BLOCK_TAGS.has(el.tagName) && el.childElementCount >= 2 && len >= MIN_FALLBACK_TEXT) fallback = el;
  }
  return weak ?? fallback ?? start;
}

/** Short label for the overlay pill. */
export function describeContainer(el: Element, exact: boolean): string {
  const tag = el.tagName.toLowerCase();
  if (exact) return `<${tag}> · exact`;
  const role = el.getAttribute("role");
  if (role === "dialog" || role === "alertdialog") return "Dialog";
  const hint = `${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("data-testid") ?? ""}`;
  if (/drawer/i.test(hint)) return "Drawer";
  if (/modal/i.test(hint)) return "Dialog";
  if (/card|issue|task|ticket/i.test(hint)) return "Card";
  if (tag === "li" || role === "listitem") return "List item";
  if (tag === "article" || role === "article") return "Article";
  if (tag === "section" || role === "region") return "Section";
  return "Container";
}

const OVERLAY_CSS = `
  :host { all: initial; }
  .box {
    position: fixed; box-sizing: border-box; display: none;
    border: 2px solid #98b99f; background: rgba(152, 185, 159, 0.12); border-radius: 4px;
    transition: top .06s, left .06s, width .06s, height .06s;
  }
  .tag {
    position: fixed; display: none; white-space: nowrap;
    font: 600 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: .06em; text-transform: uppercase;
    color: #121714; background: #98b99f; border-radius: 3px; padding: 4px 6px;
  }
  .hint {
    position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); white-space: nowrap;
    font: 500 12px/1 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #eef2ef; background: #121714; border: 1px solid #39483f; border-radius: 999px; padding: 7px 12px;
  }
  @media (prefers-reduced-motion: reduce) { .box { transition: none; } }
`;

/** Events swallowed while picking so the page never sees a click, drag or context menu. */
const BLOCKED_EVENTS = [
  "click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup",
] as const;

export function startPicker(onDone: (outcome: PickerOutcome) => void, doc: Document = document): PickerSession {
  const view = doc.defaultView ?? window;
  const host = doc.createElement("div");
  host.setAttribute(PICKER_HOST_ATTR, "");
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = OVERLAY_CSS;
  const box = doc.createElement("div");
  box.className = "box";
  const tag = doc.createElement("div");
  tag.className = "tag";
  const hint = doc.createElement("div");
  hint.className = "hint";
  hint.textContent = "Click a card to clip it · Shift: exact element · Esc: cancel";
  root.append(style, box, tag, hint);
  doc.documentElement.append(host);

  let active = true;
  let lastTarget: Node | null = null;
  let shift = false;
  let current: Element | null = null;
  let frame = 0;

  const render = () => {
    frame = 0;
    if (!active) return;
    current = resolveCardContainer(lastTarget, shift, doc);
    if (!current) {
      box.style.display = tag.style.display = "none";
      return;
    }
    const r = current.getBoundingClientRect();
    Object.assign(box.style, { display: "block", top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    tag.textContent = describeContainer(current, shift);
    tag.style.display = "block";
    const tagH = 20;
    const top = r.top - tagH - 4 >= 0 ? r.top - tagH - 4 : Math.min(r.top + 4, view.innerHeight - tagH);
    const left = Math.min(Math.max(r.left, 4), Math.max(4, view.innerWidth - tag.offsetWidth - 4));
    Object.assign(tag.style, { top: `${Math.max(0, top)}px`, left: `${left}px` });
  };
  const schedule = () => {
    if (!frame) frame = view.requestAnimationFrame(render);
  };

  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const onMove = (e: MouseEvent) => {
    lastTarget = (e.composedPath()[0] as Node | undefined) ?? (e.target as Node | null);
    shift = e.shiftKey;
    schedule();
  };
  const onBlocked = (e: Event) => {
    swallow(e);
    if (e.type !== "click") return;
    const me = e as MouseEvent;
    const target = (me.composedPath()[0] as Node | undefined) ?? (me.target as Node | null);
    const picked = resolveCardContainer(target, me.shiftKey, doc);
    if (picked) finish({ type: "picked", element: picked, exact: me.shiftKey });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      swallow(e);
      finish({ type: "cancelled", reason: "escape" });
      return;
    }
    if (e.key === "Shift" && shift !== (e.type === "keydown")) {
      shift = e.type === "keydown";
      schedule();
    }
  };
  const onHide = () => {
    if (doc.visibilityState === "hidden") finish({ type: "cancelled", reason: "hidden" });
  };
  const onPageHide = () => finish({ type: "cancelled", reason: "hidden" });

  const capture = { capture: true } as const;
  view.addEventListener("mousemove", onMove, capture);
  for (const type of BLOCKED_EVENTS) view.addEventListener(type, onBlocked, capture);
  view.addEventListener("keydown", onKey, capture);
  view.addEventListener("keyup", onKey, capture);
  view.addEventListener("scroll", schedule, capture);
  view.addEventListener("resize", schedule);
  view.addEventListener("pagehide", onPageHide);
  doc.addEventListener("visibilitychange", onHide);

  function teardown() {
    active = false;
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
    view.removeEventListener("mousemove", onMove, capture);
    for (const type of BLOCKED_EVENTS) view.removeEventListener(type, onBlocked, capture);
    view.removeEventListener("keydown", onKey, capture);
    view.removeEventListener("keyup", onKey, capture);
    view.removeEventListener("scroll", schedule, capture);
    view.removeEventListener("resize", schedule);
    view.removeEventListener("pagehide", onPageHide);
    doc.removeEventListener("visibilitychange", onHide);
    host.remove();
    lastTarget = current = null;
  }

  function finish(outcome: PickerOutcome) {
    if (!active) return;
    teardown();
    onDone(outcome);
  }

  return {
    cancel: (reason: PickerEndReason = "cancelled") => finish({ type: "cancelled", reason }),
    get active() {
      return active;
    },
  };
}
