import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveQualificationDecision } from "../src/lib/outreach-preparation.js";

test("lead-level qualification is authoritative over the stored research assessment", () => {
  assert.equal(resolveEffectiveQualificationDecision("rebuild_candidate", "no_material_opportunity"), "rebuild_candidate");
  assert.equal(resolveEffectiveQualificationDecision("no_material_opportunity", "rebuild_candidate"), "no_material_opportunity");
  assert.equal(resolveEffectiveQualificationDecision("needs_review", "rebuild_candidate"), "needs_review");
});

test("research assessment is used only when the lead has no current qualification decision", () => {
  assert.equal(resolveEffectiveQualificationDecision(null, "rebuild_candidate"), "rebuild_candidate");
  assert.equal(resolveEffectiveQualificationDecision(undefined, "no_material_opportunity"), "no_material_opportunity");
});
