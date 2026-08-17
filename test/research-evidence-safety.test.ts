import test from "node:test";
import assert from "node:assert/strict";
import {
  applyResearchEvidenceSafety,
  sanitizePrimaryOutreachAngle,
} from "../src/lib/research-evidence-safety.js";

function problem(overrides: Partial<Parameters<typeof applyResearchEvidenceSafety>[0]> = {}) {
  return {
    category: "credibility",
    title: "Unrelated kitchen template content remains",
    evidence: "Static DOM contains Kitchor kitchen-design headings",
    businessConsequence: "Could confuse visitors",
    recommendedImprovement: "Remove it",
    confidence: 0.99,
    outreachValue: "high" as const,
    evidenceSources: ["dom_heading", "dom_text"] as ("dom_heading" | "dom_text")[],
    ...overrides,
  };
}

test("raw-DOM-only template contamination cannot become outreach evidence", () => {
  const safe = applyResearchEvidenceSafety(problem());
  assert.equal(safe.outreachValue, "low");
  assert.equal(safe.confidence, 0.4);
});

test("ordinary raw-DOM-only findings are capped below high confidence/outreach", () => {
  const safe = applyResearchEvidenceSafety(problem({
    category: "content",
    title: "Service explanation is thin",
    evidence: "The extracted page text has little service detail",
    evidenceSources: ["dom_text"],
  }));
  assert.equal(safe.outreachValue, "medium");
  assert.equal(safe.confidence, 0.65);
});

test("corroborated template evidence can retain its original confidence", () => {
  const safe = applyResearchEvidenceSafety(problem({ evidenceSources: ["dom_text", "navigation"] as any }));
  assert.equal(safe.outreachValue, "high");
  assert.equal(safe.confidence, 0.99);
});

test("explicit visitor-visibility uncertainty blocks outreach even with mixed sources", () => {
  const safe = applyResearchEvidenceSafety(problem({
    evidenceSources: ["dom_text", "representative_page"] as any,
    businessConsequence: "Because the evidence is static HTML rather than rendered-browser output, the exact visitor-facing presentation should be verified.",
  }));
  assert.equal(safe.outreachValue, "low");
  assert.equal(safe.confidence, 0.4);
});

test("uncorroborated template wording is removed from the primary outreach angle", () => {
  assert.equal(sanitizePrimaryOutreachAngle("Remove leftover kitchen template content", [problem()]), null);
});

test("corroborated visitor-facing evidence may remain the primary outreach angle", () => {
  const corroborated = problem({ evidenceSources: ["navigation", "dom_text"] as any });
  assert.equal(sanitizePrimaryOutreachAngle("Remove leftover kitchen template content", [corroborated]), "Remove leftover kitchen template content");
});

test("template angle is blocked when the finding itself says rendered verification is still needed", () => {
  const uncertain = problem({
    evidenceSources: ["representative_page", "dom_text"] as any,
    businessConsequence: "The exact visitor-facing presentation should be verified in a rendered browser.",
  });
  assert.equal(sanitizePrimaryOutreachAngle("Remove leftover kitchen template content", [uncertain]), null);
});

test("missing-form claims are blocked because single-page research cannot prove site-wide absence", () => {
  const safe = applyResearchEvidenceSafety(problem({
    category: "conversion",
    title: "No online inspection form",
    evidence: "The Free Inspection CTA sends visitors to a contact page without an online request form",
    recommendedImprovement: "Add a short inspection form",
    evidenceSources: ["cta", "contact_signal"] as any,
  }));
  assert.equal(safe.outreachValue, "low");
  assert.equal(safe.confidence, 0.2);
});

test("missing-form wording cannot remain the primary outreach angle", () => {
  const safe = applyResearchEvidenceSafety(problem({
    category: "conversion",
    title: "Contact page lacks a form",
    evidence: "The request page has no contact form",
    recommendedImprovement: "Add a request form",
    evidenceSources: ["contact_signal"] as any,
  }));
  assert.equal(sanitizePrimaryOutreachAngle("Add the missing inspection request form", [safe]), null);
});
