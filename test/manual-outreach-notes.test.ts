import test from "node:test";
import assert from "node:assert/strict";
import { manualOutreachNotesEligibilityReason } from "../src/lib/manual-outreach.js";

test("manual outreach requires saved My Notes when research did not qualify the lead", () => {
  assert.match(manualOutreachNotesEligibilityReason(null) ?? "", /Add My Notes/);
  assert.match(manualOutreachNotesEligibilityReason("   ") ?? "", /Add My Notes/);
  assert.equal(manualOutreachNotesEligibilityReason("The pool page is mostly photos and two short promotional claims."), null);
});
