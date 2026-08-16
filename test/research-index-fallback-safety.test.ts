import test from "node:test";
import assert from "node:assert/strict";
import { applyCrawlerFailureSafety, type ResearchResult } from "../src/lib/ai-research.js";
import type { PerformanceAssessment } from "../src/lib/performance-assessment.js";

function dimension(rating: "strong" | "adequate" | "constrained" | "weak" | "unknown", sources: any[]) {
  return { rating, evidence: "test evidence", evidenceSources: sources, confidence: 0.9 };
}

const crownStyleResult: ResearchResult = {
  decision: "rebuild_candidate",
  assetStrength: "weak",
  dimensions: {
    performanceEffectiveness: dimension("weak", ["performance"]),
    demandAlignment: dimension("strong", ["search_index"]),
    businessRepresentation: dimension("adequate", ["search_index"]),
    customerActionCapability: dimension("unknown", ["site_coverage"]),
    acquisitionReadiness: dimension("constrained", ["performance", "search_index", "site_coverage"]),
    siteMaturity: dimension("adequate", ["search_index", "site_coverage"]),
  },
  findings: [
    {
      category: "site_maturity",
      title: "A rebuild-versus-optimization recommendation requires live validation",
      evidence: "Direct inspection failed while search indexing shows a substantial site.",
      assetCapability: "Validate the live homepage before deciding.",
      confidence: 0.65,
      significance: "medium",
      evidenceSources: ["site_coverage", "search_index"],
    },
    {
      category: "customer_action",
      title: "The current website conversion path cannot be verified",
      evidence: "The direct crawler could not verify forms or CTAs.",
      assetCapability: "This is an evidence gap rather than proof of a deficiency.",
      confidence: 0.2,
      significance: "low",
      evidenceSources: ["search_index", "contact_signal", "site_coverage"],
    },
    {
      category: "performance",
      title: "Measured loading and interaction performance is severely slow",
      evidence: "LCP is poor and multiple measured metrics are poor.",
      assetCapability: "Slow rendering materially constrains the visitor experience.",
      confidence: 0.99,
      significance: "high",
      evidenceSources: ["performance"],
    },
  ],
  researchSummary: "The performance evidence is strong enough to justify a conversation about the visitor experience.",
  decisionReason: "Live validation is needed before choosing rebuild versus optimization.",
  confidence: 0.9,
};

const crownStyleWebsite = {
  finalUrl: null,
  fetchError: "fetch failed",
  searchIndexEvidence: {
    succeeded: true,
    pages: [{ url: "a" }, { url: "b" }, { url: "c" }, { url: "d" }],
  },
} as any;

const severePerformance: PerformanceAssessment = {
  overall: "poor",
  scoreBand: "poor",
  lcpBand: "poor",
  tbtBand: "poor",
  clsBand: "good",
  poorMetricCount: 3,
  needsImprovementMetricCount: 0,
  strongPerformanceSignal: true,
};

test("indexed fallback plus severe measured performance becomes optimization candidate, not needs review", () => {
  const safe = applyCrawlerFailureSafety(crownStyleResult, crownStyleWebsite, severePerformance);
  assert.equal(safe.decision, "optimization_candidate");
  assert.equal(safe.assetStrength, "constrained");
  assert.equal(safe.confidence, 0.65);
  assert.equal(safe.decisionReason, "Optimization candidate because direct performance measurements show a material performance constraint while same-domain indexed evidence indicates a substantial existing website. Direct site inspection is still required before a rebuild conclusion can be supported.");
});

test("crawler uncertainty is not stored as a material finding", () => {
  const safe = applyCrawlerFailureSafety(crownStyleResult, crownStyleWebsite, severePerformance);
  assert.deepEqual(safe.findings.map((finding) => finding.title), ["Measured loading and interaction performance is severely slow"]);
});

test("research narratives remove outreach-style conversation language", () => {
  const safe = applyCrawlerFailureSafety({ ...crownStyleResult, decision: "optimization_candidate" }, crownStyleWebsite, severePerformance);
  assert.doesNotMatch(safe.researchSummary, /conversation/i);
  assert.match(safe.researchSummary, /support further evaluation/i);
});
