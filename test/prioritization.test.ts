import test from "node:test";
import assert from "node:assert/strict";
import { calculateOpportunityPriority, DEFAULT_PRIORITY_WEIGHTS } from "../src/lib/prioritization.js";

test("rebuild opportunity receives full opportunity credit", () => {
  const rebuild = calculateOpportunityPriority({
    decision: "rebuild_candidate", assetStrength: "weak", assessmentConfidence: 0.95, siteMaturityRating: "adequate",
    findings: [{ significance: "high", confidence: 0.95 }], email: "owner@example.com", phone: "8175551212", adSource: "paid_ad", isAgencyManaged: false, isNationalChain: false,
  }, DEFAULT_PRIORITY_WEIGHTS);
  assert.equal(rebuild.scores.opportunityType, 100);
  assert.ok(rebuild.score <= 100);
});

test("legacy optimization records receive no service-opportunity credit", () => {
  const legacy = calculateOpportunityPriority({
    decision: "optimization_candidate", assetStrength: "adequate", assessmentConfidence: 0.9, siteMaturityRating: "adequate",
    findings: [{ significance: "high", confidence: 0.9 }], email: "owner@example.com", phone: "8175551212", adSource: "paid_ad", isAgencyManaged: false, isNationalChain: false,
  }, DEFAULT_PRIORITY_WEIGHTS);
  assert.equal(legacy.scores.opportunityType, 0);
});

test("national chains are deterministically capped on business maturity", () => {
  const result = calculateOpportunityPriority({
    decision: "rebuild_candidate", assetStrength: "weak", assessmentConfidence: 1, siteMaturityRating: "strong",
    findings: [{ significance: "high", confidence: 1 }], email: "owner@example.com", phone: "8175551212", adSource: "paid_ad", isAgencyManaged: false, isNationalChain: true,
  }, DEFAULT_PRIORITY_WEIGHTS);
  assert.equal(result.scores.businessMaturity, 25);
});