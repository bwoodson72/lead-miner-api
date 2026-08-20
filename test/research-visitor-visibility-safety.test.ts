import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAssetFindingSafety,
  enforcePlaceholderQualificationSafety,
  isUnverifiedCrawlerActionFailureFinding,
  isUnverifiedStaticPresentationFinding,
} from "../src/lib/asset-research-safety.js";

const performanceFinding = {
  category: "performance",
  title: "The main page has a severely delayed largest-contentful paint",
  evidence: "Measured LCP is 14,914 ms.",
  assetCapability: "The measured loading delay is material.",
  confidence: 0.98,
  significance: "high" as const,
  evidenceSources: ["performance"] as any,
};

const crawler404Finding = {
  category: "customer_action",
  title: "The free-estimate CTA leads to a 404 page",
  evidence: "The crawler followed the estimate destination and returned HTTP 404.",
  assetCapability: "The estimate path is described as broken.",
  confidence: 0.99,
  significance: "high" as const,
  evidenceSources: ["cta", "contact_signal", "site_coverage"] as any,
};

const hiddenCommerceFinding = {
  category: "business_representation",
  title: "Several sampled service pages use store-style presentation with a $0.00 price",
  evidence: "Representative-page extraction includes /store/p/ URLs and $0.00 text.",
  assetCapability: "This was described as visitor-visible pricing uncertainty.",
  confidence: 0.92,
  significance: "medium" as const,
  evidenceSources: ["representative_page", "architecture", "site_coverage"] as any,
};

test("crawler-only CTA 404 is not treated as a visitor-facing defect", () => {
  assert.equal(isUnverifiedCrawlerActionFailureFinding(crawler404Finding), true);
  const safe = applyAssetFindingSafety(crawler404Finding);
  assert.equal(safe.confidence, 0.2);
  assert.equal(safe.significance, "low");
});

test("static $0 store markup is not treated as rendered presentation evidence", () => {
  assert.equal(isUnverifiedStaticPresentationFinding(hiddenCommerceFinding), true);
  const safe = applyAssetFindingSafety(hiddenCommerceFinding);
  assert.equal(safe.confidence, 0.2);
  assert.equal(safe.significance, "low");
});

test("Grime-style crawler artifacts are removed from findings, summary, dimensions, and decision reasoning", () => {
  const result = enforcePlaceholderQualificationSafety({
    decision: "rebuild_candidate",
    assetStrength: "weak",
    findings: [
      performanceFinding,
      applyAssetFindingSafety(crawler404Finding),
      applyAssetFindingSafety(hiddenCommerceFinding),
    ],
    researchSummary: "The site has poor performance. The free-estimate CTA leads to a 404 page. Several service pages display $0.00 store-style pricing.",
    decisionReason: "REBUILD_CANDIDATE is supported by a broken estimate CTA, $0.00 store-style presentation, and slow performance.",
    dimensions: {
      customerActionCapability: {
        rating: "constrained",
        evidence: "The free-estimate CTA returned HTTP 404.",
        evidenceSources: ["cta"],
        confidence: 0.97,
      },
      businessRepresentation: {
        rating: "adequate",
        evidence: "Representative pages display $0.00 store-style pricing.",
        evidenceSources: ["representative_page"],
        confidence: 0.9,
      },
    },
    confidence: 0.93,
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.category, "performance");
  assert.doesNotMatch(result.researchSummary ?? "", /404|\$0\.00|store-style/i);
  assert.doesNotMatch(result.decisionReason, /404|\$0\.00|store-style/i);
  assert.equal(result.decision, "needs_review");
  assert.equal((result.dimensions as any).customerActionCapability.confidence, 0.5);
  assert.doesNotMatch((result.dimensions as any).customerActionCapability.evidence, /404/i);
});

test("valid performance plus direct thin-content evidence can still support rebuild after unsafe artifacts are removed", () => {
  const result = enforcePlaceholderQualificationSafety({
    decision: "rebuild_candidate",
    assetStrength: "weak",
    findings: [
      performanceFinding,
      {
        category: "content_depth",
        title: "Services page covers several services with very little substantive detail",
        evidence: "The sampled Services page has 39 substantive words across remodeling, concrete, painting, roofing, and commercial work.",
        assetCapability: "The page provides little service-specific information for a prospective buyer.",
        confidence: 0.96,
        significance: "high" as const,
        evidenceSources: ["representative_page"] as any,
      },
      applyAssetFindingSafety(crawler404Finding),
      applyAssetFindingSafety(hiddenCommerceFinding),
    ],
    researchSummary: "Poor performance and thin service content are material. The estimate CTA also returned 404 and sampled pages display $0.00.",
    decisionReason: "Rebuild is supported by performance, thin content, a broken estimate CTA, and store-style $0.00 presentation.",
    confidence: 0.94,
  });

  assert.equal(result.decision, "rebuild_candidate");
  assert.equal(result.findings.length, 2);
  assert.match(result.decisionReason, /content|largest-contentful|performance/i);
  assert.doesNotMatch(result.decisionReason, /404|\$0\.00|store-style/i);
});

test("a statically observed CTA pointing to an unrelated external domain remains valid evidence", () => {
  const finding = {
    category: "objective_defect",
    title: "Quote CTA points to unrelated destination",
    evidence: "The observed href points to an unrelated external domain.",
    assetCapability: "The link destination does not correspond to the business.",
    confidence: 0.97,
    significance: "high" as const,
    evidenceSources: ["cta"] as any,
  };
  assert.equal(isUnverifiedCrawlerActionFailureFinding(finding), false);
  const safe = applyAssetFindingSafety(finding);
  assert.equal(safe.confidence, 0.97);
  assert.equal(safe.significance, "high");
});
