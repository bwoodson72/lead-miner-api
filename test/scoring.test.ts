import test from "node:test";
import assert from "node:assert/strict";
import { calculatePriority, ResearchResultSchema } from "../src/lib/ai-research.js";

test("calculatePriority applies the configured weighted score", () => {
  const score = calculatePriority({
    businessFit: 8,
    websiteNeed: 10,
    abilityToPay: 6,
    contactability: 8,
    urgency: 5,
    salesOpportunity: 9,
  });
  assert.equal(score, 81);
});

test("calculatePriority stays within the 0-100 range for valid score inputs", () => {
  assert.equal(calculatePriority({ businessFit: 0, websiteNeed: 0, abilityToPay: 0, contactability: 0, urgency: 0, salesOpportunity: 0 }), 0);
  assert.equal(calculatePriority({ businessFit: 10, websiteNeed: 10, abilityToPay: 10, contactability: 10, urgency: 10, salesOpportunity: 10 }), 100);
});

test("research contract rejects invented score ranges and invalid outreach values", () => {
  const parsed = ResearchResultSchema.safeParse({
    decision: "qualified",
    scores: { businessFit: 11, websiteNeed: 8, abilityToPay: 8, contactability: 8, urgency: 8, salesOpportunity: 8 },
    problems: [{ category: "conversion", title: "Weak CTA", evidence: "Homepage", businessConsequence: "Fewer leads", recommendedImprovement: "Improve CTA", confidence: 0.9, outreachValue: "critical" }],
    researchSummary: "Summary",
    primaryOutreachAngle: "CTA",
    qualificationReason: "Reason",
    confidence: 0.9,
  });
  assert.equal(parsed.success, false);
});
