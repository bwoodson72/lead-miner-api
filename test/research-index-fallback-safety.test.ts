import test from "node:test";
import assert from "node:assert/strict";
import { applyCrawlerFailureSafety, ResearchResultSchema, type ResearchResult } from "../src/lib/ai-research.js";
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
      title: "A rebuild recommendation requires live validation",
      evidence: "Direct inspection failed while search indexing shows a substantial site.",
      assetCapability: "Validate the live homepage before deciding whether replacement is justified.",
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
  decisionReason: "Live validation is needed before deciding whether a rebuild is justified.",
  confidence: 0.9,
};

const crownStyleWebsite = {
  finalUrl: null,
  fetchError: "fetch failed",
  providerScrapeEvidence: { succeeded: false, wordCount: 0 },
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

test("indexed fallback downgrades an unsupported rebuild to review rather than an optimization offer", () => {
  const safe = applyCrawlerFailureSafety(crownStyleResult, crownStyleWebsite, severePerformance);
  assert.equal(safe.decision, "needs_review");
  assert.equal(safe.assetStrength, "unknown");
  assert.equal(safe.confidence, 0.65);
  assert.match(safe.decisionReason, /do not establish enough current website evidence to justify a custom rebuild/i);
  assert.match(safe.decisionReason, /optimization is outside the service/i);
});

test("severe performance alone does not turn a fallback lead into a service opportunity", () => {
  const safe = applyCrawlerFailureSafety({
    ...crownStyleResult,
    decision: "no_material_opportunity",
    assetStrength: "adequate",
    findings: [],
    decisionReason: "The supplied evidence does not establish a custom rebuild opportunity.",
  }, crownStyleWebsite, severePerformance);
  assert.equal(safe.decision, "no_material_opportunity");
  assert.equal(safe.assetStrength, "adequate");
});

test("optimization is not a valid current research decision", () => {
  const parsed = ResearchResultSchema.safeParse({
    ...crownStyleResult,
    decision: "optimization_candidate",
  });
  assert.equal(parsed.success, false);
});

test("direct rebuild decision is preserved when direct evidence supports it", () => {
  const website = { finalUrl: "https://example.com/", fetchError: null } as any;
  const safe = applyCrawlerFailureSafety(crownStyleResult, website, severePerformance);
  assert.equal(safe.decision, "rebuild_candidate");
});

test("current provider plus index plus independent material limitations can preserve rebuild", () => {
  const result: ResearchResult = {
    ...crownStyleResult,
    findings: [
      crownStyleResult.findings[2]!,
      {
        category: "business_representation",
        title: "Current page extraction shows materially weak service representation",
        evidence: "The current extracted page has little substantive service explanation.",
        assetCapability: "The site underrepresents the business and its services.",
        confidence: 0.8,
        significance: "medium",
        evidenceSources: ["provider_scrape"],
      },
    ],
  };
  const website = {
    finalUrl: null,
    fetchError: "TLS chain error",
    providerScrapeEvidence: { succeeded: true, wordCount: 300 },
    searchIndexEvidence: { succeeded: true, pages: [{ url: "a" }, { url: "b" }, { url: "c" }, { url: "d" }] },
  } as any;
  const safe = applyCrawlerFailureSafety(result, website, severePerformance);
  assert.equal(safe.decision, "rebuild_candidate");
  assert.equal(safe.assetStrength, "weak");
  assert.equal(safe.confidence, 0.8);
});

test("crawler uncertainty is not stored as a material finding", () => {
  const safe = applyCrawlerFailureSafety(crownStyleResult, crownStyleWebsite, severePerformance);
  assert.deepEqual(safe.findings.map((finding) => finding.title), ["Measured loading and interaction performance is severely slow"]);
});

test("research narratives remove outreach-style conversation language", () => {
  const safe = applyCrawlerFailureSafety(crownStyleResult, crownStyleWebsite, severePerformance);
  assert.doesNotMatch(safe.researchSummary, /conversation/i);
  assert.match(safe.researchSummary, /support further evaluation/i);
});