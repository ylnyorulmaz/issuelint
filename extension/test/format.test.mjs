import { test } from "node:test";
import assert from "node:assert/strict";
import { backendLabel, charsLabel, gapLabel, gatesLabel } from "../src/lib/format.ts";

test("gap label is singular only for exactly one", () => {
  assert.equal(gapLabel(0), "Potential gaps");
  assert.equal(gapLabel(1), "Potential gap");
  assert.equal(gapLabel(2), "Potential gaps");
});

test("character and gate labels", () => {
  assert.equal(charsLabel(113, 8000), "113 / 8,000 characters");
  assert.equal(charsLabel(6501, 6500), "6,501 / 6,500 characters");
  assert.equal(gatesLabel(1), "1 gate");
  assert.equal(gatesLabel(3), "3 gates");
});

test("backend pill names", () => {
  assert.deepEqual(["quick_scan", "analyze_v2", "custom"].map(backendLabel), ["Quick Scan", "Decision v2", "Custom"]);
});
