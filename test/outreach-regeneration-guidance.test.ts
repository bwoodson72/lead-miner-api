import test from "node:test";
import assert from "node:assert/strict";
import { withOperatorOutreachNotes } from "../src/lib/operator-outreach-notes.js";
import {
  currentRegenerationInstruction,
  normalizeRegenerationInstruction,
  withRegenerationInstruction,
} from "../src/lib/outreach-regeneration-guidance.js";

test("plain regeneration adds no artificial guidance", () => {
  assert.equal(normalizeRegenerationInstruction("   "), null);
  assert.equal(currentRegenerationInstruction(), null);
  assert.equal(withOperatorOutreachNotes("Base campaign rules", null), "Base campaign rules");
});

test("one-time regeneration instruction reaches outreach writing instructions", async () => {
  await withRegenerationInstruction("Focus on the lost-lead consequence and do not mention speed.", async () => {
    const instructions = withOperatorOutreachNotes("Base campaign rules", "Owner posts actively on Facebook.");
    assert.match(instructions, /OPERATOR OUTREACH NOTES/);
    assert.match(instructions, /ONE-TIME OPERATOR REGENERATION INSTRUCTION/);
    assert.match(instructions, /Focus on the lost-lead consequence/);
    assert.match(instructions, /must not create or embellish facts/);
  });

  assert.equal(currentRegenerationInstruction(), null);
});

test("regeneration instruction does not leak into reply classification instructions", async () => {
  await withRegenerationInstruction("Make the email shorter.", async () => {
    const instructions = withOperatorOutreachNotes("Classify reply", null, "reply");
    assert.doesNotMatch(instructions, /ONE-TIME OPERATOR REGENERATION INSTRUCTION/);
    assert.doesNotMatch(instructions, /Make the email shorter/);
  });
});
