import test from "node:test";
import assert from "node:assert/strict";
import {
  automaticOutreachCandidates,
  decodeOutreachPsychology,
  encodeOperatorNotesSelection,
  isLikelyHousekeepingFinding,
  outreachCandidates,
} from "../src/lib/ai-outreach-angle.js";

function finding(overrides: Partial<{ id:number; category:string; title:string; evidence:string; assetCapability:string; confidence:number; significance:string; evidenceSources:string[] }> = {}) {
  return {
    id: overrides.id ?? 1,
    category: overrides.category ?? "content_depth",
    title: overrides.title ?? "Thin service page",
    evidence: overrides.evidence ?? "The service page contains one short paragraph.",
    assetCapability: overrides.assetCapability ?? "Visitors get little service-specific detail.",
    confidence: overrides.confidence ?? 0.9,
    significance: overrides.significance ?? "high",
    evidenceSources: overrides.evidenceSources ?? ["https://example.com/services"],
  };
}

test("contact-detail cleanup is recognized as housekeeping rather than a preferred automatic angle", () => {
  assert.equal(isLikelyHousekeepingFinding({
    category: "customer_action",
    title: "Multiple phone numbers and placeholder email addresses",
    evidence: "The site presents several phone numbers and placeholder email text.",
    assetCapability: "Contact details should be made consistent.",
  }), true);
});

test("automatic selection excludes performance when a meaningful non-performance finding exists", () => {
  const performance = finding({ id: 1, category: "performance", title: "Very slow load", confidence: 0.99 });
  const content = finding({ id: 2, category: "content_depth", title: "Incomplete service page", confidence: 0.88 });
  assert.deepEqual(automaticOutreachCandidates([performance, content]).map((item) => item.id), [2]);
});

test("automatic selection falls back to performance when it is the only meaningful finding", () => {
  const performance = finding({ id: 1, category: "performance", title: "Very slow load", confidence: 0.99 });
  assert.deepEqual(automaticOutreachCandidates([performance]).map((item) => item.id), [1]);
});

test("operator-selected finding bypasses automatic materiality and housekeeping preference", () => {
  const performance = finding({ id: 1, category: "performance", title: "Very slow load" });
  const contact = finding({ id: 2, category: "business_representation", title: "Two different phone numbers", significance: "low" });
  assert.deepEqual(outreachCandidates([performance, contact], 2).map((item) => item.id), [2]);
});

test("My Notes selection marker is persisted and decoded as an operator override", () => {
  const decoded = decodeOutreachPsychology(encodeOperatorNotesSelection("Lead with the unfinished kitchen page, not speed."));
  assert.equal(decoded?.selectionSource, "operator_notes");
  assert.equal(decoded?.version, "outreach-angle-v4");
});
