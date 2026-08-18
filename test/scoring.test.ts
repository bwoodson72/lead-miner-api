import test from "node:test";
import assert from "node:assert/strict";
import { ResearchResultSchema } from "../src/lib/ai-research.js";

const validDimension = {
  rating: "adequate",
  evidence: "Supported by supplied evidence",
  evidenceSources: ["lead_data"],
  confidence: 0.8,
};

test("v6 research contract accepts business asset assessment output", () => {
  const parsed = ResearchResultSchema.safeParse({
    decision: "rebuild_candidate",
    assetStrength: "constrained",
    dimensions: {
      performanceEffectiveness: { ...validDimension, rating: "weak", evidenceSources: ["performance"] },
      demandAlignment: validDimension,
      businessRepresentation: validDimension,
      customerActionCapability: validDimension,
      acquisitionReadiness: validDimension,
      siteMaturity: validDimension,
    },
    findings: [{
      category: "performance",
      title: "Severe mobile performance constraint",
      evidence: "Deterministic performance assessment is poor",
      assetCapability: "Reduces the site's effectiveness as a destination for acquired traffic",
      confidence: 0.95,
      significance: "high",
      evidenceSources: ["performance"],
    }],
    researchSummary: "The site has meaningful capability but severe delivery constraints.",
    decisionReason: "Performance and other observable constraints make rebuild consideration reasonable.",
    confidence: 0.9,
  });
  assert.equal(parsed.success, true);
});

test("v6 research contract rejects legacy sales scoring and outreach fields", () => {
  const parsed = ResearchResultSchema.safeParse({
    decision: "qualified",
    scores: { businessFit: 10, websiteNeed: 10, abilityToPay: 10, contactability: 10, urgency: 10, salesOpportunity: 10 },
    problems: [],
    researchSummary: "Summary",
    primaryOutreachAngle: "CTA",
    qualificationReason: "Reason",
    confidence: 0.9,
  });
  assert.equal(parsed.success, false);
});

test("v6 research contract rejects invalid asset ratings and significance", () => {
  const parsed = ResearchResultSchema.safeParse({
    decision: "rebuild_candidate",
    assetStrength: "excellent",
    dimensions: {
      performanceEffectiveness: validDimension,
      demandAlignment: validDimension,
      businessRepresentation: validDimension,
      customerActionCapability: validDimension,
      acquisitionReadiness: validDimension,
      siteMaturity: validDimension,
    },
    findings: [{
      category: "performance",
      title: "Finding",
      evidence: "Evidence",
      assetCapability: "Capability",
      confidence: 0.8,
      significance: "critical",
      evidenceSources: ["performance"],
    }],
    researchSummary: "Summary",
    decisionReason: "Reason",
    confidence: 0.9,
  });
  assert.equal(parsed.success, false);
});
