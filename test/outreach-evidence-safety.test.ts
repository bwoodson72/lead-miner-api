import test from "node:test";
import assert from "node:assert/strict";
import { generateOutreachDraft } from "../src/lib/ai-outreach.js";

test("outreach drafting refuses to call AI when no vetted problem survives", async () => {
  await assert.rejects(
    () => generateOutreachDraft({
      businessName: "Example Foundation Repair",
      domain: "example.com",
      keyword: "foundation repair",
      primaryOutreachAngle: null,
      researchSummary: "Unverified template text",
      qualificationReason: "Unverified template text",
      problems: [{
        title: "Unrelated kitchen template content",
        evidence: "Static DOM contained kitchen copy [Sources: dom_heading, dom_text — visibility unverified]",
        businessConsequence: "Could confuse visitors",
        confidence: 0.4,
        outreachValue: "low",
      }],
    }, "unused-model", 0.7, "Write a concise evidence-backed email."),
    /No evidence-backed outreach problem meets the configured safety threshold/,
  );
});
