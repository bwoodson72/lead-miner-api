import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAssetFindingSafety,
  isUnsupportedCrawlerReachabilityFinding,
} from "../src/lib/asset-research-safety.js";

test("raw-DOM-only template contamination cannot become a high-significance v6 finding", () => {
  const finding = applyAssetFindingSafety({
    category: "objective_defect",
    title: "Unrelated kitchen template content",
    evidence: "Raw DOM contains Kitchor template copy",
    assetCapability: "Could affect business representation if actually visitor-visible",
    confidence: 0.99,
    significance: "high" as const,
    evidenceSources: ["dom_text"] as const,
  });
  assert.equal(finding.confidence, 0.4);
  assert.equal(finding.significance, "low");
});

test("missing-form claims are capped even in the business asset model", () => {
  const finding = applyAssetFindingSafety({
    category: "customer_action",
    title: "No online request form",
    evidence: "No form was found in static HTML",
    assetCapability: "Limits customer action",
    confidence: 0.9,
    significance: "high" as const,
    evidenceSources: ["contact_signal"] as const,
  });
  assert.equal(finding.confidence, 0.2);
  assert.equal(finding.significance, "low");
});

test("crawler failure cannot become a visitor-reachability defect", () => {
  const crownStyleFinding = {
    category: "objective_defect",
    title: "Homepage is currently unreachable",
    evidence: "The website record reports fetch failed, no final URL, no page content, and no discovered pages.",
    assetCapability: "This can prevent prospective roofing customers from accessing services or contact options.",
    confidence: 0.97,
    significance: "high" as const,
    evidenceSources: ["site_coverage"] as const,
  };
  assert.equal(isUnsupportedCrawlerReachabilityFinding(crownStyleFinding), true);
  const safe = applyAssetFindingSafety(crownStyleFinding);
  assert.equal(safe.confidence, 0.1);
  assert.equal(safe.significance, "low");
});

test("ordinary objective defects are not suppressed by the reachability guard", () => {
  const finding = {
    category: "objective_defect",
    title: "Quote CTA points to unrelated destination",
    evidence: "The visible Get a Quote CTA resolves to an unrelated external domain.",
    assetCapability: "The observed CTA destination does not support the intended customer action.",
    confidence: 0.97,
    significance: "high" as const,
    evidenceSources: ["cta"] as const,
  };
  assert.equal(isUnsupportedCrawlerReachabilityFinding(finding), false);
  const safe = applyAssetFindingSafety(finding);
  assert.equal(safe.confidence, 0.97);
  assert.equal(safe.significance, "high");
});
