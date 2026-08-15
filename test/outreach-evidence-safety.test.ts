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

test("outreach drafting rejects old stored claims that a contact page has no form", async () => {
  await assert.rejects(
    () => generateOutreachDraft({
      businessName: "Heroic Roofing",
      domain: "heroicroof.com",
      keyword: "roofer",
      primaryOutreachAngle: "Add the missing inspection request form",
      researchSummary: "CTA analysis",
      qualificationReason: "Conversion opportunity",
      problems: [{
        title: "Contact page lacks an online inspection form",
        evidence: "The Free Inspection CTA sends visitors to a contact page without an online request form",
        businessConsequence: "Visitors have to call or email instead",
        confidence: 0.95,
        outreachValue: "high",
      }],
    }, "unused-model", 0.7, "Write a concise evidence-backed email."),
    /No evidence-backed outreach problem meets the configured safety threshold/,
  );
});
