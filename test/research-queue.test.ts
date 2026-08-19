import test from "node:test";
import assert from "node:assert/strict";
import { calculateResearchQueueScore, rankResearchCandidates } from "../src/lib/research-queue.js";

const now = new Date("2026-08-19T12:00:00Z");

function candidate(overrides: Partial<Parameters<typeof calculateResearchQueueScore>[0]> = {}) {
  return {
    adSource: "local_organic",
    performanceOpportunity: "none",
    screeningStatus: "complete",
    businessName: "Example Services",
    phone: null,
    address: null,
    createdAt: new Date("2026-08-19T12:00:00Z"),
    ...overrides,
  };
}

test("paid acquisition intent and strong performance move a candidate up the research queue", () => {
  const ordinary = calculateResearchQueueScore(candidate(), now);
  const stronger = calculateResearchQueueScore(candidate({ adSource: "paid_ad", performanceOpportunity: "strong" }), now);
  assert.equal(ordinary.total, 30);
  assert.equal(stronger.total, 65);
  assert.ok(stronger.total > ordinary.total);
});

test("email availability is intentionally absent from research queue scoring", () => {
  const input = candidate({ phone: "817-555-0100", address: "100 Main St" });
  const score = calculateResearchQueueScore(input, now);
  assert.deepEqual(score, {
    acquisitionIntent: 15,
    performanceSignal: 0,
    screeningCompleteness: 10,
    listingIdentity: 15,
    aging: 0,
    ageDays: 0,
    total: 40,
  });
});

test("queue aging is one point per day and capped at twenty points", () => {
  const tenDays = calculateResearchQueueScore(candidate({ createdAt: new Date("2026-08-09T12:00:00Z") }), now);
  const fortyDays = calculateResearchQueueScore(candidate({ createdAt: new Date("2026-07-10T12:00:00Z") }), now);
  assert.equal(tenDays.aging, 10);
  assert.equal(fortyDays.aging, 20);
});

test("partial or failed screening remains research-eligible but receives less completeness credit", () => {
  const complete = calculateResearchQueueScore(candidate({ screeningStatus: "complete" }), now);
  const partial = calculateResearchQueueScore(candidate({ screeningStatus: "partial" }), now);
  const failed = calculateResearchQueueScore(candidate({ screeningStatus: "failed" }), now);
  assert.equal(complete.screeningCompleteness, 10);
  assert.equal(partial.screeningCompleteness, 5);
  assert.equal(failed.screeningCompleteness, 3);
});

test("research candidates are ranked by score then oldest candidate", () => {
  const ranked = rankResearchCandidates([
    candidate({ id: 2, adSource: "local_organic", createdAt: new Date("2026-08-18T12:00:00Z") }),
    candidate({ id: 1, adSource: "paid_ad" }),
    candidate({ id: 3, adSource: "local_organic", createdAt: new Date("2026-08-17T12:00:00Z") }),
  ], now);
  assert.deepEqual(ranked.map((entry) => entry.candidate.id), [1, 3, 2]);
});
