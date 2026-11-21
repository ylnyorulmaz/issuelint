// Runs the built dist/content.js in real Chromium against local fixture pages.
// Usage: npm run build && npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const contentJs = readFileSync(new URL("../dist/content.js", import.meta.url), "utf8");

const BOARD = `
  <header><nav><a href="/">Home</a> <a href="/boards">Boards</a> Workspace switcher</nav></header>
  <aside class="sidebar"><ul><li>Backlog</li><li>Sprint 42</li><li>Reports</li></ul></aside>
  <main>
    ${Array.from({ length: 8 }, (_, i) => `<div class="card">BG-${i} Background card that must not leak into the clip</div>`).join("")}
  </main>
  <footer>© Example Corp · Terms · Privacy</footer>`;

const MODAL = `
  <div role="dialog" aria-modal="true" class="modal">
    <h1>PAY-123 Fix rounding on the checkout summary</h1>
    <button>Watch</button><button>Share</button>
    <p>Totals on the summary step are off by one cent for some carts. Only USD prices are affected.</p>
    <ul><li><input type="checkbox" checked> Reproduce with cart fixture A</li><li><input type="checkbox"> Verify EUR totals on the summary step</li></ul>
    <pre><code class="language-ts">const total = round(sum, 2);</code></pre>
    <a href="/browse/PAY-100">Related ticket</a>
    <div style="display:none">Hidden activity log that should be dropped</div>
  </div>`;

const ARTICLE = `
  <header><nav>Site nav · Pricing · Docs · Login</nav></header>
  <aside>Related posts sidebar</aside>
  <main><article>
    <h1>Migrate the billing service to the new queue</h1>
    <p>${"We need to move the billing worker off the legacy queue so retries stop duplicating invoices. ".repeat(12)}</p>
    <h2>Checklist</h2>
    <table><thead><tr><th>Step</th><th>Owner</th></tr></thead><tbody><tr><td>Drain old queue</td><td>Ops</td></tr><tr><td>Switch consumer</td><td>Billing</td></tr></tbody></table>
    <pre><code class="language-bash">npm run migrate -- --dry-run</code></pre>
    <p>${"Rollback is a config flip in the deploy dashboard and must be rehearsed in staging first. ".repeat(10)}</p>
  </article></main>
  <footer>Footer links · Careers · Status</footer>`;

let browser;
let page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => browser?.close());

async function run(html, prepare) {
  await page.route("https://fixture.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>Fixture</title></head><body>${html}</body></html>` }));
  await page.goto("https://fixture.test/browse/PAY-123");
  if (prepare) await page.evaluate(prepare);
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.addScriptTag({ content: contentJs });
  const result = await page.evaluate(() => globalThis.__issuelintClipperExtract());
  await page.unrouteAll();
  return { result, requests };
}

test("selection wins over modal and page", async () => {
  const { result } = await run(BOARD + MODAL, () => {
    const p = document.querySelector(".modal p");
    const range = document.createRange();
    range.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  assert.equal(result.sourceMode, "selection");
  assert.match(result.markdown, /off by one cent/);
  assert.doesNotMatch(result.markdown, /PAY-123|Background card/);
});

test("open modal is clipped without background cards, buttons or hidden nodes", async () => {
  const { result, requests } = await run(BOARD + MODAL);
  assert.equal(result.sourceMode, "modal");
  assert.equal(result.title, "PAY-123 Fix rounding on the checkout summary");
  assert.match(result.markdown, /^# PAY-123/m);
  assert.match(result.markdown, /- \[x\] Reproduce with cart fixture A/);
  assert.match(result.markdown, /- \[ \] Verify EUR totals/);
  assert.match(result.markdown, /```ts\nconst total = round\(sum, 2\);\n```/);
  assert.match(result.markdown, /\[Related ticket\]\(https:\/\/fixture\.test\/browse\/PAY-100\)/);
  assert.doesNotMatch(result.markdown, /Background card|Watch|Share|Hidden activity/);
  assert.deepEqual(requests, [], "extraction must not make network requests");
});

test("full page uses Defuddle: drops nav, sidebar, footer and keeps tables/code", async () => {
  const { result, requests } = await run(ARTICLE);
  assert.equal(result.sourceMode, "page");
  assert.equal(result.url, "https://fixture.test/browse/PAY-123");
  assert.match(result.markdown, /legacy queue/);
  assert.match(result.markdown, /\| Step \| Owner \|/);
  assert.match(result.markdown, /\| Drain old queue \| Ops \|/);
  assert.match(result.markdown, /```bash\nnpm run migrate -- --dry-run\n```/);
  assert.doesNotMatch(result.markdown, /Site nav|Related posts sidebar|Careers/);
  assert.deepEqual(requests, []);
});

test("extraction does not modify the live page", async () => {
  await run(ARTICLE);
  const html = await page.evaluate(() => document.body.innerHTML.length);
  const before = html;
  await page.evaluate(() => globalThis.__issuelintClipperExtract());
  assert.equal(await page.evaluate(() => document.body.innerHTML.length), before);
  assert.equal(await page.evaluate(() => document.querySelectorAll("nav, footer, aside").length), 3);
});
