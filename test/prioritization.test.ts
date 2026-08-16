import test from "node:test";
import assert from "node:assert/strict";
import { calculateOpportunityPriority, DEFAULT_PRIORITY_WEIGHTS } from "../src/lib/prioritization.js";

test("rebuild opportunity with strong evidence ranks above weak optimization opportunity", () => {
  const strong = calculateOpportunityPriority({
    decision: "rebuild_candidate", assetStrength: "weak", assessmentConfidence: 0.95, siteMaturityRating: "adequate",
    findings: [{ significance: "high", confidence: 0.95 }], email: "owner@example.com", phone: "8175551212", adSource: "paid_ad", isAgencyManaged: false, isNationalChain: false,
  }, DEFAULT_PRIORITY_WEIGHTS);
  const weaker = calculateOpportunityPriority({
    decision: "optimization_candidate", assetStrength: "adequate", assessmentConfidence: 0.7, siteMaturityRating: "adequate",
    findings: [{ significance: "medium", confidence: 0.7 }], email: "owner@example.com", phone: null, adSource: "local_organic", isAgencyManaged: false, isNationalChain: false,
  }, DEFAULT_PRIORITY_WEIGHTS);
  assert.ok(strong.score > weaker.score);
  assert.ok(strong.score <= 100);
});

test("national chains are deterministically capped on business maturity", () => {
  const result = calculateOpportunityPriority({
    decision: "rebuild_candidate", assetStrength: "weak", assessmentConfidence: 1, siteMaturityRating: "strong",
    findings: [{ significance: "high", confidence: 1 }], email: "owner@example.com", phone: "8175551212", adSource: "paid_ad", isAgencyManaged: false, isNationalChain: true,
  }, DEFAULT_PRIORITY_WEIGHTS);
  assert.equal(result.scores.businessMaturity, 25);
});
