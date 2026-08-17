import test from "node:test";
import assert from "node:assert/strict";
import {
  containsArtificialOutreachLanguage,
  containsConsultantJargon,
  containsGenericOpening,
  containsMinimizingRemediation,
  containsPlaceholderText,
  containsProspectFacingPerformanceMeasurement,
  containsSenderIdentity,
  containsTechnicalAuditLanguage,
  ctaNeedsRegeneration,
  ctaTooSimilarToRecent,
  generateOutreachDraft,
  hasNeutralGreeting,
  hasUnverifiedSalutation,
  isPlaceholderBusinessName,
  normalizeOutreachBody,
  OUTREACH_PROMPT_VERSION,
  outreachDraftNeedsRegeneration,
  subjectNeedsRegeneration,
} from "../src/lib/ai-outreach.js";

test("outreach prompt version is v15", () => {
  assert.equal(OUTREACH_PROMPT_VERSION, "outreach-draft-v15");
});

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

test("outreach drafting rejects a selected finding that still requires rendered visitor verification", async () => {
  await assert.rejects(
    () => generateOutreachDraft({
      businessName: "Texas Pride Foundation Repair",
      domain: "texaspridefoundation.com",
      keyword: "foundation repair",
      senderName: "Brian Woodson",
      senderEmail: "leads@brianwoodson.dev",
      primaryOutreachAngle: "Unrelated kitchen template content makes the site appear unfinished",
      researchSummary: "Template-content concern",
      qualificationReason: "Possible credibility issue",
      selectedFinding: {
        id: 10,
        category: "credibility",
        title: "Unrelated kitchen-design template content remains",
        evidence: "Kitchen-design copy appears in static HTML",
        assetCapability: "Because the evidence is static HTML rather than rendered-browser output, the exact visitor-facing presentation should be verified.",
        confidence: 0.96,
        significance: "high",
      },
    }, "unused-model", 0.7, "Write a concise evidence-backed email."),
    /still requires visitor-facing verification/,
  );
});

test("representative simple-cleanup outreach is rejected by deterministic draft safety", () => {
  assert.equal(containsMinimizingRemediation("A simple cleanup—one primary phone, one monitored email, and consistent contact details across the site—could make it easier for prospects to reach you."), true);
});

test("problem-and-reply framing is not rejected as trivial remediation", () => {
  assert.equal(containsMinimizingRemediation("I noticed the site gives people conflicting contact information, which can make someone hesitate before calling. Want me to send over what I found?"), false);
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
  assert.equal(containsGenericOpening("I took a look at the Weatherford page and noticed it takes a while to show up."), false);
});

test("existing drafts with fabricated team greetings require regeneration", () => {
  assert.equal(outreachDraftNeedsRegeneration("Hi Acme Roofing team,\n\nThe site makes the estimate path harder to follow than it needs to be.", "Website question"), true);
});

test("existing drafts without a neutral greeting require regeneration", () => {
  assert.equal(outreachDraftNeedsRegeneration("The mobile service page takes long enough to become usable that someone comparing roofers could reasonably return to the search results instead of waiting.", "Weatherford page"), true);
});

test("agreed human Touch 1 voice remains acceptable", () => {
  const body = "Hi,\n\nI took a look at the Weatherford page on your site and noticed it takes a pretty long time before the main roofing info and quote options show up.\n\nIf someone is comparing a few roofers, that gives them an easy reason to hit Back and try the next company before they ever see why they should choose you.\n\nI build custom websites for service businesses, so this kind of thing tends to stand out to me.\n\nWant me to send over what I found?\n\nBrian";
  assert.equal(outreachDraftNeedsRegeneration(body, "Weatherford roofing page", "Want me to send over what I found?"), false);
});

test("sender identity accepts varied natural web-development context", () => {
  assert.equal(containsSenderIdentity("I build custom websites for service businesses, so this stood out to me.", "Brian Woodson"), true);
  assert.equal(containsSenderIdentity("I'm a web developer and this stood out to me.", "Brian Woodson"), true);
  assert.equal(containsSenderIdentity("I spend most of my time building websites for service businesses, so I tend to notice this stuff.", "Brian Woodson"), true);
  assert.equal(containsSenderIdentity("My work involves web development for service businesses, which is why I noticed it.", "Brian Woodson"), true);
  assert.equal(containsSenderIdentity("This stood out to me.", "Brian Woodson"), false);
});

test("prospect-facing consultant jargon is rejected", () => {
  assert.equal(containsConsultantJargon("This material limitation weakens the acquisition asset."), true);
  assert.equal(containsConsultantJargon("Someone comparing roofers may leave before reaching the estimate form."), false);
});

test("analyst-style campaign language is rejected", () => {
  assert.equal(containsArtificialOutreachLanguage("Could we look at where that delay is affecting the customer journey?"), true);
  assert.equal(containsArtificialOutreachLanguage("The first-visit friction may affect prospective customers."), true);
  assert.equal(containsArtificialOutreachLanguage("I noticed the estimate form takes a while to show up."), false);
});

test("technical audit language is never prospect-facing", () => {
  assert.equal(containsTechnicalAuditLanguage("The page has an LCP problem in Lighthouse."), true);
  assert.equal(containsTechnicalAuditLanguage("PageSpeed shows a 7200 ms delay."), true);
  assert.equal(containsTechnicalAuditLanguage("The page takes a pretty long time to show up."), false);
});

test("exact performance measurements are private evidence only", () => {
  assert.equal(containsProspectFacingPerformanceMeasurement("The homepage took about seven seconds to appear."), true);
  assert.equal(containsProspectFacingPerformanceMeasurement("The homepage took 7.1 seconds to appear."), true);
  assert.equal(containsProspectFacingPerformanceMeasurement("The page responded in 910 ms."), true);
  assert.equal(containsProspectFacingPerformanceMeasurement("The homepage takes noticeably longer than it should to show the main content."), false);
  const body = "Hi,\n\nI checked the homepage and the main content took about seven seconds to appear. Someone comparing roofers may not wait around.\n\nI work in web development for service businesses, so this stood out to me.\n\nWant me to send what I found?\n\nBrian";
  assert.equal(outreachDraftNeedsRegeneration(body, "Homepage load", "Want me to send what I found?"), true);
});

test("Touch 1 rejects meeting asks but allows tiny permission asks", () => {
  assert.equal(ctaNeedsRegeneration("Invite a brief consultation about improving the homepage experience."), true);
  assert.equal(ctaNeedsRegeneration("Would you be open to a quick conversation about it?"), true);
  assert.equal(ctaNeedsRegeneration("Could we schedule 15 minutes to look at it?"), true);
  assert.equal(ctaNeedsRegeneration("Want me to send over what I found?"), false);
  assert.equal(ctaNeedsRegeneration("Want to see what I found?"), false);
  assert.equal(ctaNeedsRegeneration("Should I send the details?"), false);
  assert.equal(ctaNeedsRegeneration("Does that match what you've noticed?"), false);
});

test("CTA diversity is evaluated against recent campaign copy instead of banning a phrase globally", () => {
  assert.equal(ctaTooSimilarToRecent("Want me to send over what I found?", ["Want me to send over the details?"]), true);
  assert.equal(ctaTooSimilarToRecent("Should I send the details?", ["Want me to send over what I found?"]), false);
  assert.equal(ctaNeedsRegeneration("Would it be useful to see what I found?"), false);
});

test("subjects stay mundane, short, and specific", () => {
  assert.equal(subjectNeedsRegeneration("Weatherford roofing page"), false);
  assert.equal(subjectNeedsRegeneration("Estimate form"), false);
  assert.equal(subjectNeedsRegeneration("Quick question"), true);
  assert.equal(subjectNeedsRegeneration("FREE WEBSITE AUDIT"), true);
  assert.equal(subjectNeedsRegeneration("Homepage took seven seconds"), true);
  assert.equal(subjectNeedsRegeneration("An urgent opportunity to improve your roofing website today"), true);
});

test("stored drafts use current human-language and Touch 1 CTA validation", () => {
  const body = "Hi,\n\nI noticed the estimate form takes a while to show up. Someone comparing roofers may go back to the search results instead of waiting.\n\nI build custom websites for service businesses, so this stood out to me.\n\nWant me to send over what I found?\n\nBrian";
  assert.equal(outreachDraftNeedsRegeneration(body, "Estimate form", "Would you be open to a quick conversation about it?"), true);
  assert.equal(outreachDraftNeedsRegeneration(body, "Estimate form", "Want me to send over what I found?"), false);
});