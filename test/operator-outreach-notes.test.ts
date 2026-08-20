import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOutreachNotes, withOperatorOutreachNotes } from "../src/lib/operator-outreach-notes.js";

test("blank outreach notes are ignored", () => {
  assert.equal(normalizeOutreachNotes("   "), null);
  assert.equal(withOperatorOutreachNotes("Base instructions", "   "), "Base instructions");
});

test("operator notes are appended as private high-priority outreach context", () => {
  const result = withOperatorOutreachNotes("Base instructions", "Lead with the stale commercial roofing portfolio.");
  assert.match(result, /OPERATOR OUTREACH NOTES/);
  assert.match(result, /high-priority human context/);
  assert.match(result, /stale commercial roofing portfolio/);
  assert.match(result, /Do not quote the notes mechanically/);
});

test("reply mode keeps notes out of inbound reply classification", () => {
  const result = withOperatorOutreachNotes("Classify the reply", "Mention the owner's financing question.", "reply");
  assert.match(result, /suggestedResponse/);
  assert.match(result, /do not let these notes change the reply classification/);
});
