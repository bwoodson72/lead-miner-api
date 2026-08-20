import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAssetFindingSafety,
  containsUnverifiedPlaceholderContent,
  isUnverifiedPlaceholderFinding,
} from "../src/lib/asset-research-safety.js";

test("lorem ipsum from a representative page cannot become a material finding", () => {
  const finding = {
    category: "business_representation",
    title: "Lorem ipsum placeholder copy remains on a service page",
    evidence: "Representative-page text extraction includes Lorem ipsum dolor sit amet.",
    assetCapability: "Could confuse visitors if the text is actually rendered.",
    confidence: 0.98,
    significance: "high" as const,
    evidenceSources: ["representative_page"] as const,
  };

  assert.equal(isUnverifiedPlaceholderFinding(finding), true);
  const safe = applyAssetFindingSafety(finding);
  assert.equal(safe.confidence, 0.25);
  assert.equal(safe.significance, "low");
});

test("provider-extracted placeholder text is also treated as visibility-unverified", () => {
  const finding = applyAssetFindingSafety({
    category: "business_representation",
    title: "Placeholder content detected",
    evidence: "Current provider extraction contains demo content in the page text.",
    assetCapability: "Could weaken trust if visitor-visible.",
    confidence: 0.92,
    significance: "high" as const,
    evidenceSources: ["provider_scrape"] as const,
  });

  assert.equal(finding.confidence, 0.25);
  assert.equal(finding.significance, "low");
});

test("the placeholder guard is narrow and does not suppress ordinary defects", () => {
  assert.equal(containsUnverifiedPlaceholderContent("Quote button sends visitors to another company"), false);
  const safe = applyAssetFindingSafety({
    category: "objective_defect",
    title: "Quote CTA points to unrelated destination",
    evidence: "The Get a Quote CTA resolves to an unrelated external domain.",
    assetCapability: "The observed CTA destination does not support the intended customer action.",
    confidence: 0.97,
    significance: "high" as const,
    evidenceSources: ["cta"] as const,
  });
  assert.equal(safe.confidence, 0.97);
  assert.equal(safe.significance, "high");
});
