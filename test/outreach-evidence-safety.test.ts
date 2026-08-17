import test from "node:test";
import assert from "node:assert/strict";
import {
  containsConsultantJargon,
  containsGenericOpening,
  containsMinimizingRemediation,
  containsPlaceholderText,
  containsSenderIdentity,
  ctaNeedsRegeneration,
  generateOutreachDraft,
  hasNeutralGreeting,
  hasUnverifiedSalutation,
  isPlaceholderBusinessName,
  normalizeOutreachBody,
  outreachDraftNeedsRegeneration,
} from "../src/lib/ai-outreach.js";

test("outreach drafting refuses to call AI when no vetted finding survives", async () => {
  await assert.rejects(
    () => generateOutreachDraft({
      businessName: "Example Foundation Repair",
      domain: "example.com",
      keyword: "foundation repair",
      senderName: "Brian Woodson",
      senderEmail: "leads@brianwoodson.dev",
      primaryOutreachAngle: null,
      researchSummary: "Unverified template text",
      qualificationReason: "Unverified template text",
      problems: [{ title: "Unrelated kitchen template content", evidence: "Static DOM contained kitchen copy [Sources: dom_heading, dom_text — visibility unverified]", businessConsequence: "Could confuse visitors", confidence: 0.4, outreachValue: "low" }],
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
      senderName: "Brian Woodson",
      senderEmail: "leads@brianwoodson.dev",
      primaryOutreachAngle: "Add the missing inspection request form",
      researchSummary: "CTA analysis",
      qualificationReason: "Conversion opportunity",
      problems: [{ title: "Contact page lacks an online inspection form", evidence: "The Free Inspection CTA sends visitors to a contact page without an online request form", businessConsequence: "Visitors have to call or email instead", confidence: 0.95, outreachValue: "high" }],
    }, "unused-model", 0.7, "Write a concise evidence-backed email."),
    /No evidence-backed outreach finding meets the configured safety threshold/,
  );
});

test("representative simple-cleanup outreach is rejected by deterministic draft safety", () => {
  assert.equal(containsMinimizingRemediation("A simple cleanup—one primary phone, one monitored email, and consistent contact details across the site—could make it easier for prospects to reach you."), true);
});

test("problem-and-consultation framing is not rejected as trivial remediation", () => {
  assert.equal(containsMinimizingRemediation("I noticed the site gives visitors conflicting contact information, which can create uncertainty at the point they are deciding whether to reach out. Would you be open to a brief consultation to look at whether the website is doing enough to support new inquiries?"), false);
});

test("neutral greeting is allowed and preserved", () => {
  const body = "Hi,\n\nThe site shows conflicting contact information in several places, which can create uncertainty before someone reaches out.";
  assert.equal(hasNeutralGreeting(body), true);
  assert.equal(hasUnverifiedSalutation(body), false);
  assert.equal(normalizeOutreachBody(body), body);
});

test("company-team salutations remain unverified personalization", () => {
  const body = "Hi Archival Roofing team,\n\nThe site shows conflicting contact information in several places, which can create uncertainty before someone reaches out.";
  assert.equal(hasUnverifiedSalutation(body), true);
  assert.equal(hasNeutralGreeting(body), false);
});

test("placeholder identities and template tokens are rejected", () => {
  assert.equal(isPlaceholderBusinessName("Acme Roofing"), true);
  assert.equal(isPlaceholderBusinessName("Archival Roofing"), false);
  assert.equal(containsPlaceholderText("Hi [First Name],"), true);
  assert.equal(containsPlaceholderText("I reviewed Acme Roofing's site."), true);
});

test("generic cold-email filler openings are rejected", () => {
  assert.equal(containsGenericOpening("I wanted to reach out about your website."), true);
  assert.equal(containsGenericOpening("I came across your website and wanted to connect."), true);
  assert.equal(containsGenericOpening("The quote path sends visitors through two conflicting contact options."), false);
});

test("existing drafts with fabricated team greetings require regeneration", () => {
  assert.equal(outreachDraftNeedsRegeneration("Hi Acme Roofing team,\n\nThe site makes the estimate path harder to follow than it needs to be.", "Website question"), true);
});

test("existing drafts without a neutral greeting require regeneration", () => {
  assert.equal(outreachDraftNeedsRegeneration("The mobile service page takes long enough to become usable that someone comparing roofers could reasonably return to the search results instead of waiting.", "A question about the site"), true);
});

test("specific observation with natural sender context and simple CTA remains acceptable", () => {
  const body = "Hi,\n\nI noticed the Weatherford page takes a while to show the quote options. Someone comparing roofers may decide not to wait.\n\nI build custom websites for service businesses, and this is the kind of issue I work on.\n\nWould you be open to a quick conversation about it?\n\nBrian";
  assert.equal(outreachDraftNeedsRegeneration(body, "A question about the Weatherford page", "Would you be open to a quick conversation about it?"), false);
});

test("sender context does not require the same full-name bio sentence", () => {
  assert.equal(containsSenderIdentity("I’m Brian Woodson, a web developer who builds custom websites for service businesses.", "Brian Woodson"), true);
  assert.equal(containsSenderIdentity("I build custom websites for service businesses, and this is the kind of issue I work on.", "Brian Woodson"), true);
  assert.equal(containsSenderIdentity("I'm a web developer focused on service-business websites.", "Brian Woodson"), true);
  assert.equal(containsSenderIdentity("The page takes a while to load.", "Brian Woodson"), false);
});

test("prospect-facing consultant jargon is rejected", () => {
  assert.equal(containsConsultantJargon("This material limitation weakens the acquisition asset."), true);
  assert.equal(containsConsultantJargon("Someone comparing roofers may leave before reaching the estimate form."), false);
});

test("meta, fragment, and generic website-improvement CTAs require regeneration while simple conversation CTAs pass", () => {
  assert.equal(ctaNeedsRegeneration("Invite a brief consultation about improving the homepage experience."), true);
  assert.equal(ctaNeedsRegeneration("Brief consultation about improving the site."), true);
  assert.equal(ctaNeedsRegeneration("Would you be open to a brief consultation about improving the site's responsiveness?"), true);
  assert.equal(ctaNeedsRegeneration("Would you be open to a quick conversation about it?"), false);
  assert.equal(ctaNeedsRegeneration("Would it be worth looking at what a homeowner sees before they reach the estimate form?"), false);
});

test("stored drafts can use CTA validation when CTA is available", () => {
  const body = "Hi,\n\nThe homepage takes long enough to show its main content that someone comparing roofers may go back to the search results before reaching the estimate form.\n\nI build custom websites for service businesses.";
  assert.equal(outreachDraftNeedsRegeneration(body, "Estimate path", "Invite a brief consultation about improving the site."), true);
  assert.equal(outreachDraftNeedsRegeneration(body, "Estimate path", "Would you be open to a quick conversation about it?"), false);
});