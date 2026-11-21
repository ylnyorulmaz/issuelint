import test from "node:test";
import assert from "node:assert/strict";
import { parseVerifierVerdict, VerifierContractError } from "../worker/feedback-verifier.ts";

const task = {
  title: "Add dark mode", description: "Add a toggle on the Settings screen.",
  type: "Feature", domain: "Software", criteria: "", context: ""
};
const check = (dimension, assessment = "clear", severity = "suggestion") => ({
  dimension, assessment, severity, kind: "missing", title: "Original finding",
  detail: "Original details", question: "Which screen is included?", evidence: []
});
const checks = [check("scope"), check("behavior", "gap", "important"), check("contradictions", "gap", "critical")];
const validAdd = {
  dimension: "scope", action: "ADD", reason: "The target screen boundaries need a decision.",
  severity: "important", title: "Clarify screen coverage",
  detail: "The requested change does not define whether other screens are included.",
  question: "Should dark mode affect screens beyond Settings?",
  evidence: ["Settings screen"]
};
const parse = verdicts => parseVerifierVerdict({ verdicts, repair_needed: false }, task, checks);
const rejects = verdicts => assert.throws(() => parse(verdicts), VerifierContractError);

test("accepts a grounded noncritical addition", () => {
  const result = parse([validAdd]);
  assert.equal(result.verdicts[0].action, "ADD");
  assert.equal(result.verdicts[0].severity, "important");
});
test("accepts an empty verifier verdict", () => assert.deepEqual(parse([]).verdicts, []));
test("rejects fabricated source evidence", () => rejects([{ ...validAdd, evidence: ["approved Figma design"] }]));
test("rejects unknown and duplicate dimensions", () => {
  rejects([{ ...validAdd, dimension: "nonexistent" }]);
  rejects([validAdd, validAdd]);
});
test("rejects duplicate questions", () => rejects([{ ...validAdd, question: "Which screen is included?" }]));
test("rejects attempts to suppress or downgrade critical contradictions", () => {
  rejects([{ dimension: "contradictions", action: "SUPPRESS", reason: "Looks unimportant in context." }]);
  rejects([{ dimension: "contradictions", action: "DOWNGRADE", severity: "suggestion", reason: "Looks unimportant in context." }]);
});
test("rejects ADD over a gap and SUPPRESS over a clear dimension", () => {
  rejects([{ ...validAdd, dimension: "behavior" }]);
  rejects([{ dimension: "scope", action: "SUPPRESS", reason: "This is already clear enough." }]);
});
test("only permits important-to-suggestion downgrade", () => {
  assert.equal(parse([{ dimension: "behavior", action: "DOWNGRADE", severity: "suggestion", reason: "Optional enhancement only." }]).verdicts[0].severity, "suggestion");
  rejects([{ dimension: "behavior", action: "DOWNGRADE", severity: "important", reason: "Not a valid downgrade." }]);
});
test("rejects unexpected fields, invalid text and malformed envelopes", () => {
  rejects([{ ...validAdd, unexpected: true }]);
  rejects([{ dimension: "scope", action: "KEEP", reason: "short" }]);
  assert.throws(() => parseVerifierVerdict({ verdicts: [], repair_needed: "yes" }, task, checks), VerifierContractError);
});
test("REVISE may not silently change severity", () => {
  rejects([{ ...validAdd, dimension: "behavior", action: "REVISE" }]);
  const { severity, ...revision } = validAdd;
  assert.equal(parse([{ ...revision, dimension: "behavior", action: "REVISE" }]).verdicts[0].action, "REVISE");
});


test("returns stable privacy-safe rejection codes for every contract guard", () => {
  const reason="The current review has a documented issue to reconsider.";
  const examples = [
    ["unexpected_field", [{...validAdd, extra: "never log this value"}]],
    ["invalid_dimension", [{...validAdd, dimension:"fake_dimension"}]],
    ["invalid_action", [{...validAdd, action:"DELETE"}]],
    ["duplicate_dimension", [validAdd,validAdd]],
    ["unknown_check", [{...validAdd, dimension:"outcome"}]],
    ["invalid_reason", [{...validAdd,reason:"too short"}]],
    ["finding_not_gap", [{dimension:"scope",action:"SUPPRESS",reason}]],
    ["critical_locked", [{dimension:"contradictions",action:"REVISE",reason}]],
    ["add_over_gap", [{...validAdd,dimension:"behavior"}]],
    ["invalid_downgrade", [{dimension:"behavior",action:"DOWNGRADE",severity:"important",reason}]],
    ["invalid_title", [{...validAdd,title:"x"}]],
    ["invalid_detail", [{...validAdd,detail:"short"}]],
    ["invalid_question", [{...validAdd,question:"x?"}]],
    ["invalid_evidence_format", [{...validAdd,evidence:[" "]}]],
    ["evidence_not_in_task", [{...validAdd,evidence:["top secret fabricated quote"]}]],
    ["invalid_add_severity", [{...validAdd,severity:"critical"}]],
    ["duplicate_question", [{...validAdd,question:"Which screen is included?"}]],
    ["revise_severity", [{...validAdd,dimension:"behavior",action:"REVISE"}]],
    ["forbidden_action_field", [{dimension:"scope",action:"KEEP",reason,severity:"suggestion"}]],
  ];
  for (const [code,patches] of examples) {
    assert.throws(()=>parse(patches),err=>
      err instanceof VerifierContractError && err.code===code &&
      err.message===code && !err.message.includes("secret"),
      "expected safe code "+code);
  }
  assert.throws(
    ()=>parseVerifierVerdict({verdicts:[],repair_needed:"maybe"},task,checks),
    e=>e instanceof VerifierContractError && e.code==="invalid_envelope"
  );
});
