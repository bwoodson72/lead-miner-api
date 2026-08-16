import test from "node:test";
import assert from "node:assert/strict";
import { assessPerformance } from "../src/lib/performance-assessment.js";

test("classifies Google performance bands deterministically", () => {
  assert.deepEqual(assessPerformance({ lighthouseScore: 49, lcp: 4001, tbt: 601, cls: 0.251 }), {
    overall: "poor",
    scoreBand: "poor",
    lcpBand: "poor",
    tbtBand: "poor",
    clsBand: "poor",
    poorMetricCount: 4,
    needsImprovementMetricCount: 0,
    strongPerformanceSignal: true,
  });
});

test("boundary values remain in the better Google band", () => {
  const result = assessPerformance({ lighthouseScore: 90, lcp: 2500, tbt: 200, cls: 0.1 });
  assert.equal(result.overall, "good");
  assert.equal(result.poorMetricCount, 0);
  assert.equal(result.needsImprovementMetricCount, 0);
  assert.equal(result.strongPerformanceSignal, false);
});

test("one poor LCP is a strong performance signal", () => {
  const result = assessPerformance({ lighthouseScore: 72, lcp: 5200, tbt: 250, cls: 0.05 });
  assert.equal(result.overall, "poor");
  assert.equal(result.lcpBand, "poor");
  assert.equal(result.strongPerformanceSignal, true);
});
