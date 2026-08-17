import test from "node:test";
import assert from "node:assert/strict";
import { containsMinimizingRemediation, generateOutreachDraft } from "../src/lib/ai-outreach.js";

test("outreach drafting refuses to call AI when no vetted finding survives", async () => {
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
    /No evidence-backed outreach finding meets the configured safety threshold/,
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
    /No evidence-backed outreach finding meets the configured safety threshold/,
  );
});

test("representative simple-cleanup outreach is rejected by deterministic draft safety", () => {
  const body = "A simple cleanup—one primary phone, one monitored email, and consistent contact details across the site—could make it easier for prospects to reach you.";
  assert.equal(containsMinimizingRemediation(body), true);
});

test("problem-and-consultation framing is not rejected as trivial remediation", () => {
  const body = "I noticed the site gives visitors conflicting contact information, which can create uncertainty at the point they are deciding whether to reach out. Would you be open to a brief consultation to look at whether the website is doing enough to support new inquiries?";
  assert.equal(containsMinimizingRemediation(body), false);
});
