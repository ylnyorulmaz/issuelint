// Drives the built dist/content.js element picker in real Chromium against fixture pages.
// Usage: npm run build && npm run test:e2e
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const contentJs = readFileSync(new URL("../dist/content.js", import.meta.url), "utf8");

const BOARD = `
  <style>
    body { margin: 0; font: 14px sans-serif; }
    .board { display: flex; gap: 16px; padding: 16px; }
    .list { width: 260px; background: #eee; padding: 8px; }
    .list-cards { list-style: none; margin: 0; padding: 0; }
    .list-card { background: #fff; margin: 8px 0; padding: 8px; }
    .issue-drawer { width: 360px; background: #fafafa; padding: 12px; }
    .menu { display: none; }
  </style>
  <header><nav>Workspace · Boards · Members</nav></header>
  <main class="board">
    <div class="list">
      <h2>To do</h2>
      <ol class="list-cards">
        <li class="list-card" id="card1">
          <a class="list-card-title" href="/c/1">PAY-123 Fix rounding on checkout summary</a>
          <div class="badges"><span class="icon"><svg width="10" height="10"></svg></span><span class="icon-wrap"><i class="ico"></i></span></div>
          <button>Edit card</button>
          <p class="list-card-details" id="card1-details">Totals are off by one cent for USD carts.</p>
          <div class="menu">Hidden card menu: Archive · Move</div>
        </li>
        <li class="list-card" id="card2">
          <a class="list-card-title" href="/c/2">PAY-124 Add EUR support to the pricing API</a>
          <p>Needs pricing API v2 before release.</p>
        </li>
      </ol>
    </div>
    <aside class="issue-drawer" id="drawer">
      <div class="drawer-header"><h1>JIRA-9 Migrate billing worker</h1></div>
      <div class="drawer-body">
        <p>Move the billing worker off the legacy queue so retries stop duplicating invoices.</p>
        <ul><li id="drawer-step">Drain the old queue before switching consumers</li></ul>
      </div>
    </aside>
  </main>
  <footer>© Example · Terms</footer>
  <script>
    window.pageEvents = [];
    for (const type of ["click", "pointerdown", "mousedown", "mouseup", "pointerup", "keydown"]) {
      document.addEventListener(type, () => window.pageEvents.push(type));
      document.getElementById("card1").addEventListener(type, () => window.pageEvents.push("card:" + type), true);
    }
    document.querySelector('a[href="/c/1"]').addEventListener("click", (e) => { e.preventDefault(); window.pageEvents.push("navigate"); });
  </script>`;

let browser;
let page;
const requests = [];
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on("request", (r) => requests.push(r.url()));
});
after(async () => browser?.close());

beforeEach(async () => {
  await page.route("https://board.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>Payments board</title></head><body>${BOARD}</body></html>` }));
  await page.goto("https://board.test/b/payments");
  await page.addScriptTag({ content: contentJs });
  requests.length = 0;
});

/** Starts the picker in the page; the outcome lands in window.pickerEvents. */
async function startPicker() {
  await page.evaluate(() => {
    window.pickerEvents = [];
    window.__issuelintClipperPicker.start((event) => window.pickerEvents.push(event));
  });
}
const pickerEvents = () => page.evaluate(() => window.pickerEvents);
const overlayCount = () => page.evaluate(() => document.querySelectorAll("[data-issuelint-picker]").length);
const pageEvents = () => page.evaluate(() => window.pageEvents);
async function hover(selector, opts = {}) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + Math.min(10, box.width / 2), box.y + box.height / 2, opts);
  await page.waitForTimeout(60); // one animation frame
}
const resolvedId = (selector, exact = false) =>
  page.evaluate(([s, e]) => window.__issuelintClipperPicker.resolve(document.querySelector(s), e)?.id ?? null, [selector, exact]);

test("container resolution climbs from leaves to the card, not to the column or page", async () => {
  assert.equal(await resolvedId("#card1-details"), "card1");
  assert.equal(await resolvedId(".list-card-title"), "card1", "card-title is a part token, not the card");
  assert.equal(await resolvedId("#card2 p"), "card2");
  assert.equal(await resolvedId("#drawer-step"), "drawer", "a checklist <li> inside a drawer resolves to the drawer");
  assert.equal(await resolvedId("#drawer h1"), "drawer");
  assert.equal(await resolvedId("#card1-details", true), "card1-details", "Shift picks the exact element");
  assert.equal(await page.evaluate(() => window.__issuelintClipperPicker.resolve(document.body)), null);
  assert.equal(await page.evaluate(() => window.__issuelintClipperPicker.resolve(document.documentElement)), null);
});

test("hover shows one overlay matching the resolved card; click captures only that card and the page sees nothing", async () => {
  await startPicker();
  assert.equal(await overlayCount(), 1);
  await hover("#card1-details");
  const overlay = await page.evaluate(() => {
    // The overlay lives in a closed shadow root; check its host and the card geometry instead.
    const host = document.querySelector("[data-issuelint-picker]");
    const cs = getComputedStyle(host);
    return { pointerEvents: cs.pointerEvents, zIndex: cs.zIndex, position: cs.position, inShadow: host.shadowRoot === null };
  });
  assert.deepEqual(overlay, { pointerEvents: "none", zIndex: "2147483647", position: "fixed", inShadow: true });
  await page.mouse.down();
  await page.mouse.up();
  const events = await pickerEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "ELEMENT_PICKED");
  const r = events[0].result;
  assert.equal(r.sourceMode, "card");
  assert.equal(r.title, "Payments board", "card has no heading element, so document.title is used");
  assert.equal(r.url, "https://board.test/b/payments");
  assert.match(r.markdown, /^\[PAY-123 Fix rounding on checkout summary\]\(https:\/\/board\.test\/c\/1\)/, "a card <li> is not rendered as a list item");
  assert.match(r.markdown, /Totals are off by one cent for USD carts\./);
  assert.doesNotMatch(r.markdown, /PAY-124|Edit card|Hidden card menu|To do|JIRA-9|Workspace/);
  assert.deepEqual(await pageEvents(), [], "no click/pointer/mouse event reached the page or the card");
  assert.equal(await overlayCount(), 0, "overlay removed after pick");
  assert.deepEqual(requests, [], "picking makes no network requests");
});

test("a card with a heading element uses it as the title", async () => {
  await page.evaluate(() => {
    const h = document.createElement("h3");
    h.textContent = "PAY-124 heading";
    document.getElementById("card2").prepend(h);
  });
  await startPicker();
  const box = await page.locator("#card2 p").boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.click(box.x + 5, box.y + 5);
  const [event] = await pickerEvents();
  assert.equal(event.type, "ELEMENT_PICKED");
  assert.equal(event.result.title, "PAY-124 heading");
  assert.match(event.result.markdown, /Needs pricing API v2/);
});

test("drawer pick uses the drawer heading as title and keeps its checklist", async () => {
  await startPicker();
  await hover("#drawer-step");
  const box = await page.locator("#drawer-step").boundingBox();
  await page.mouse.click(box.x + 5, box.y + 5);
  const [event] = await pickerEvents();
  assert.equal(event.type, "ELEMENT_PICKED");
  assert.equal(event.result.title, "JIRA-9 Migrate billing worker");
  assert.match(event.result.markdown, /^# JIRA-9 Migrate billing worker/m);
  assert.match(event.result.markdown, /- Drain the old queue/);
  assert.doesNotMatch(event.result.markdown, /PAY-12/);
});

test("Shift picks the exact hovered element", async () => {
  await startPicker();
  await page.keyboard.down("Shift");
  await hover("#card1-details");
  const box = await page.locator("#card1-details").boundingBox();
  await page.mouse.click(box.x + 5, box.y + 5, { modifiers: ["Shift"] });
  await page.keyboard.up("Shift");
  const [event] = await pickerEvents();
  assert.equal(event.result.markdown, "Totals are off by one cent for USD carts.");
});

test("Escape cancels, removes the overlay and listeners; later clicks reach the page again", async () => {
  await startPicker();
  await hover("#card1-details");
  await page.keyboard.press("Escape");
  assert.deepEqual(await pickerEvents(), [{ type: "ELEMENT_PICKER_CANCELLED", reason: "escape" }]);
  assert.equal(await overlayCount(), 0);
  assert.deepEqual(await pageEvents(), [], "the Escape keydown itself was swallowed");
  const box = await page.locator("#card1-details").boundingBox();
  await page.mouse.click(box.x + 5, box.y + 5);
  const after = await pageEvents();
  assert.ok(after.includes("click") && after.includes("card:click"), "page handlers work again after cancel");
  assert.equal((await pickerEvents()).length, 1, "no second outcome after teardown");
});

test("starting twice leaves a single overlay and cancels the first session; cancel() tears down", async () => {
  await page.evaluate(() => {
    window.firstEvents = [];
    window.__issuelintClipperPicker.start((event) => window.firstEvents.push(event));
    window.pickerEvents = [];
    window.__issuelintClipperPicker.start((event) => window.pickerEvents.push(event));
  });
  assert.equal(await overlayCount(), 1);
  assert.deepEqual(await page.evaluate(() => window.firstEvents), [{ type: "ELEMENT_PICKER_CANCELLED", reason: "restarted" }]);
  await page.evaluate(() => window.__issuelintClipperPicker.cancel());
  assert.equal(await overlayCount(), 0);
  assert.deepEqual(await pickerEvents(), [{ type: "ELEMENT_PICKER_CANCELLED", reason: "cancelled" }]);
});

test("re-injecting content.js mid-pick does not leave a second overlay", async () => {
  await startPicker();
  await page.addScriptTag({ content: contentJs });
  await page.evaluate(() => window.__issuelintClipperPicker.start(() => {}));
  assert.equal(await overlayCount(), 1);
  await page.evaluate(() => window.__issuelintClipperPicker.cancel());
  assert.equal(await overlayCount(), 0);
});

test("hiding the page cancels the picker", async () => {
  await startPicker();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.deepEqual(await pickerEvents(), [{ type: "ELEMENT_PICKER_CANCELLED", reason: "hidden" }]);
  assert.equal(await overlayCount(), 0);
});
