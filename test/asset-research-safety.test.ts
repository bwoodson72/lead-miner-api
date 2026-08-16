import test from "node:test";
import assert from "node:assert/strict";
import { applyAssetFindingSafety } from "../src/lib/asset-research-safety.js";

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
