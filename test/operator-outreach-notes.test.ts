import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOutreachNotes, withOperatorOutreachNotes } from "../src/lib/operator-outreach-notes.js";

test("blank My Notes are ignored", () => {
  assert.equal(normalizeOutreachNotes("   "), null);
  assert.equal(withOperatorOutreachNotes("Base instructions", "   "), "Base instructions");
});

test("My Notes are appended as private message-writing context only", () => {
  const result = withOperatorOutreachNotes("Base instructions", "Lead with the stale commercial roofing portfolio.");
  assert.match(result, /MY NOTES/);
  assert.match(result, /persistent human context for wording and emphasis after qualification/);
  assert.match(result, /never change research, qualification, priority, or the stored qualification decision/);
  assert.match(result, /do not select the outreach angle/);
  assert.match(result, /stale commercial roofing portfolio/);
  assert.match(result, /Do not quote the notes mechanically/);
});

test("reply mode keeps My Notes out of inbound reply classification and lead qualification", () => {
  const result = withOperatorOutreachNotes("Classify the reply", "Mention the owner's financing question.", "reply");
  assert.match(result, /suggestedResponse/);
  assert.match(result, /do not let these notes change the reply classification/);
  assert.match(result, /never change research, qualification, priority, or the stored qualification decision/);
});
