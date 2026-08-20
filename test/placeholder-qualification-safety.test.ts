import test from "node:test";
import assert from "node:assert/strict";
import { enforcePlaceholderQualificationSafety } from "../src/lib/asset-research-safety.js";

const placeholderFinding = {
  category: "business_representation",
  title: "Lorem ipsum placeholder copy detected",
  evidence: "Representative-page extraction contains Lorem ipsum dolor sit amet.",
  assetCapability: "Could confuse visitors if the extracted content is actually rendered.",
  confidence: 0.25,
  significance: "low" as const,
  evidenceSources: ["representative_page"] as const,
};

test("placeholder-only rebuild decision is downgraded to needs review", () => {
  const safe = enforcePlaceholderQualificationSafety({
    decision: "rebuild_candidate",
    assetStrength: "weak",
    findings: [placeholderFinding],
    decisionReason: "Placeholder copy weakens the site.",
    confidence: 0.94,
  });

  assert.equal(safe.decision, "needs_review");
  assert.equal(safe.assetStrength, "unknown");
  assert.equal(safe.confidence, 0.5);
  assert.match(safe.decisionReason, /non-rendered website extraction/i);
});

test("independent material evidence can preserve a rebuild decision", () => {
  const safe = enforcePlaceholderQualificationSafety({
    decision: "rebuild_candidate",
    assetStrength: "weak",
    findings: [
      placeholderFinding,
      {
        category: "objective_defect",
        title: "Primary quote CTA points to an unrelated external destination",
        evidence: "The observed quote link resolves to another domain.",
        assetCapability: "The primary customer-action path does not reach the business.",
        confidence: 0.96,
        significance: "high" as const,
        evidenceSources: ["cta"] as const,
      },
    ],
    decisionReason: "Independent customer-action evidence supports replacement.",
    confidence: 0.9,
  });

  assert.equal(safe.decision, "rebuild_candidate");
  assert.equal(safe.assetStrength, "weak");
  assert.equal(safe.confidence, 0.9);
});
