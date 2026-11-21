import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseTask, taskSource, TASK_TYPES, DOMAINS } from "../worker/schema.ts";
import { REVIEW_DIMENSIONS } from "../worker/review-v2.ts";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/task-review-control-v1.json", import.meta.url), "utf8",
));

const domains = ["Software", "Marketing", "Sales"];
const qualities = ["deliberately_flawed", "well_specified_control"];
const expectedStatuses = ["ready", "needs_clarification", "blocked"];

test("benchmark has 12 separate task inputs, 3 flawed and 1 clean per domain", () => {
  assert.equal(fixture.dataset_id, "issuelint-cross-domain-control-v1");
  assert.equal(fixture.schema_version, "1.1.0");
  assert.equal(fixture.cases.length, 12);
  assert.deepEqual(fixture.dimensions, [...REVIEW_DIMENSIONS]);
  assert.equal(new Set(fixture.cases.map(x => x.id)).size, 12);
  for (const domain of domains) {
    const items = fixture.cases.filter(x => x.domain === domain);
    assert.equal(items.length, 4, domain + ": four cases required");
    assert.equal(items.filter(x => x.quality === "deliberately_flawed").length, 3);
    assert.equal(items.filter(x => x.quality === "well_specified_control").length, 1);
    assert.deepEqual(fixture.groups[domain], {
      flawed: 3, well_specified_control: 1,
    });
  }
});

test("all task payloads pass the actual public API schema with no answer fields", () => {
  const validKeys = ["title","description","type","domain","criteria",
    "context","scope","outcome","references"];
  for (const row of fixture.cases) {
    assert.ok(qualities.includes(row.quality),row.id);
    assert.ok(DOMAINS.includes(row.domain),row.id);
    assert.ok(TASK_TYPES.includes(row.task.type),row.id);
    assert.equal(row.task.domain,row.domain,row.id);
    assert.deepEqual(Object.keys(row.task),validKeys,row.id);
    assert.deepEqual(parseTask(row.task),row.task,row.id);
    assert.ok(!("oracle" in row.task),"oracle leakage "+row.id);
    assert.ok(!("expected_status" in row.task),"status leakage "+row.id);
    assert.ok(!("quality" in row.task),"label leakage "+row.id);
    assert.ok(expectedStatuses.includes(row.oracle.expected_status),row.id);
  }
});

test("required and optional oracle evidence consists of literal source substrings", () => {
  let required = 0, optional = 0;
  for (const row of fixture.cases) {
    const source = taskSource(row.task).replace(/\s+/g," ").toLocaleLowerCase();
    for (const [kind,entries] of [
      ["must_detect",row.oracle.must_detect],
      ["bonus_detect",row.oracle.bonus_detect ?? []],
    ]) {
      assert.ok(Array.isArray(entries),row.id+" "+kind);
      for (const signal of entries) {
        if (kind === "must_detect") required++;
        else optional++;
        assert.ok(REVIEW_DIMENSIONS.includes(signal.dimension),row.id+" dimension");
        assert.ok(signal.issue?.length >= 15,row.id+" issue");
        assert.ok(signal.question?.length >= 15,row.id+" question");
        assert.ok(["critical","important","suggestion"].includes(signal.importance),row.id+" importance");
        assert.ok(signal.source_quotes.length >= 1 && signal.source_quotes.length <= 2,row.id+" quotes");
        for (const quote of signal.source_quotes) {
          assert.ok(typeof quote === "string" && quote.length >= 2 && quote.length <= 260,row.id+" length");
          assert.ok(source.includes(quote.replace(/\s+/g," ").toLocaleLowerCase()),
            row.id+"/"+signal.dimension+": invented quote "+JSON.stringify(quote));
        }
      }
    }
  }
  assert.equal(required,16);
  assert.equal(optional,3);
});

test("clean controls test false positives without insisting N/A means Clear", () => {
  for (const row of fixture.cases) {
    if (row.quality === "well_specified_control") {
      assert.equal(row.oracle.expected_status,"ready",row.id);
      assert.equal(row.oracle.expected_material_findings,"zero",row.id);
      assert.deepEqual(row.oracle.must_detect,[],row.id);
      assert.deepEqual(row.oracle.expected_non_gap_gates,[...REVIEW_DIMENSIONS],row.id);
      assert.equal(row.oracle.minor_suggestions_permitted,true,row.id);
      assert.ok(!("expected_clear_gates" in row.oracle),row.id);
    } else {
      assert.notEqual(row.oracle.expected_status,"ready",row.id);
      assert.ok(row.oracle.must_detect.length >= 1,row.id);
      assert.equal(row.oracle.expected_material_findings,"one_or_more",row.id);
    }
  }
});

test("V1 verdict labels are not silently reused as V2 audit statuses", () => {
  assert.match(fixture.instructions.status_semantics,/\bV1\b/);
  assert.match(fixture.instructions.status_semantics,/\bV2\b/);
  assert.match(fixture.instructions.model_input,/ONLY cases\[i\]\.task/);
  assert.match(fixture.instructions.scoring,/bonus_detect/);
  assert.equal(fixture.cases.find(x => x.id === "SW-01").evaluation_role,"known_regression");
  const sales = fixture.cases.find(x => x.id === "SA-01");
  assert.equal(sales.oracle.must_detect.filter(x=>x.dimension==="contradictions").length,1);
  assert.ok(sales.oracle.bonus_detect.some(x=>x.dimension==="contradictions"));
});

test("positive controls explicitly resolve timing and prerequisite ambiguity", () => {
  const sw=fixture.cases.find(x=>x.id==="SW-04").task;
  assert.match(sw.description,/account ID/);
  assert.match(sw.criteria,/another account/);
  const mk=fixture.cases.find(x=>x.id==="MK-04").task;
  assert.match(mk.description,/10:00 UTC/);
  assert.match(mk.description,/72 but less than 96 hours/);
  assert.match(mk.criteria,/at most one send/i);
  const sa=fixture.cases.find(x=>x.id==="SA-04").task;
  assert.match(sa.description,/Europe\/London/);
  assert.match(sa.description,/UK bank holidays/);
  assert.match(sa.description,/agreed to sales email/);
  assert.match(sa.criteria,/Follow-up complete/);
});
