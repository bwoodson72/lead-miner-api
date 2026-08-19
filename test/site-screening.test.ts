import test from "node:test";
import assert from "node:assert/strict";
import { buildLeadRecord } from "../src/lib/filters.js";
import { buildPerformanceScreen, classifyPerformanceOpportunity } from "../src/lib/site-screening.js";

const thresholds = {
  performanceScore: 60,
  lcp: 4000,
  cls: 0.25,
  tbt: 300,
};

function result(overrides: Partial<{
  performanceScore: number;
  lcp: number;
  cls: number;
  tbt: number;
}> = {}) {
  return {
    performanceScore: 95,
    lcp: 1800,
    cls: 0.05,
    tbt: 80,
    url: "https://example.com",
    strategy: "mobile" as const,
    testedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("the old slow-site rule becomes a strong performance opportunity", () => {
  assert.equal(classifyPerformanceOpportunity(result({ lcp: 5200, performanceScore: 45 }), thresholds), "strong");
  assert.equal(classifyPerformanceOpportunity(result({ lcp: 5200, cls: 0.4 }), thresholds), "strong");
});

test("a single threshold breach is moderate rather than disqualifying", () => {
  assert.equal(classifyPerformanceOpportunity(result({ performanceScore: 50 }), thresholds), "moderate");
  assert.equal(classifyPerformanceOpportunity(result({ lcp: 5200 }), thresholds), "moderate");
});

test("healthy performance is retained with no performance opportunity", () => {
  assert.equal(classifyPerformanceOpportunity(result(), thresholds), "none");
});

test("missing PageSpeed data is unknown and produces a partial screen", () => {
  assert.equal(classifyPerformanceOpportunity(null, thresholds), "unknown");
  const screen = buildPerformanceScreen(null, thresholds, true);
  assert.equal(screen.screeningStatus, "partial");
  assert.equal(screen.performanceOpportunity, "unknown");
});

test("a discovered candidate can be marked pending before PageSpeed runs", () => {
  const screen = buildPerformanceScreen(null, thresholds, false);
  assert.deepEqual(screen, {
    screeningStatus: "pending",
    performanceOpportunity: "unknown",
    lastScreenedAt: null,
  });
});

test("a healthy fast site still builds a persistent lead candidate", () => {
  const lead = buildLeadRecord({
    keyword: "roofing contractor",
    domain: "fastroofer.example",
    landingPageUrl: "https://fastroofer.example/",
    pageSpeed: result(),
    thresholds,
    adSource: "paid_ad",
  });

  assert.equal(lead.domain, "fastroofer.example");
  assert.equal(lead.performanceOpportunity, "none");
  assert.equal(lead.screeningStatus, "complete");
  assert.equal(lead.performanceScore, 95);
});

test("a PageSpeed failure still builds a persistent lead candidate with unknown performance", () => {
  const lead = buildLeadRecord({
    keyword: "plumber",
    domain: "unknownspeed.example",
    landingPageUrl: "https://unknownspeed.example/",
    pageSpeed: null,
    thresholds,
    screeningStatus: "partial",
    adSource: "local_organic",
  });

  assert.equal(lead.domain, "unknownspeed.example");
  assert.equal(lead.performanceOpportunity, "unknown");
  assert.equal(lead.screeningStatus, "partial");
  assert.equal(lead.performanceScore, null);
  assert.equal(lead.lcp, null);
});
