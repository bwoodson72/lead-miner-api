import test from "node:test";
import assert from "node:assert/strict";
import { isResearchQueueEligible, resolveContactPipelineState } from "../src/lib/candidate-pipeline-routes.js";

test("research eligibility depends on screening and research state, not email", () => {
  assert.equal(isResearchQueueEligible({ status: "research_pending", lastResearchedAt: null, screeningStatus: "complete" }), true);
  assert.equal(isResearchQueueEligible({ status: "new", lastResearchedAt: null, screeningStatus: "partial" }), true);
  assert.equal(isResearchQueueEligible({ status: "new", lastResearchedAt: null, screeningStatus: "pending" }), false);
  assert.equal(isResearchQueueEligible({ status: "qualified", lastResearchedAt: new Date(), screeningStatus: "complete" }), false);
});

test("contact state only becomes required after rebuild qualification", () => {
  const now = new Date("2026-08-19T20:00:00Z");
  assert.equal(resolveContactPipelineState({ qualificationDecision: null, email: null, emailEnrichmentStatus: "pending", nextEmailEnrichmentAt: null }, now), "not_required");
  assert.equal(resolveContactPipelineState({ qualificationDecision: "no_material_opportunity", email: null, emailEnrichmentStatus: "pending", nextEmailEnrichmentAt: null }, now), "not_required");
  assert.equal(resolveContactPipelineState({ qualificationDecision: "rebuild_candidate", email: null, emailEnrichmentStatus: "pending", nextEmailEnrichmentAt: null }, now), "waiting");
  assert.equal(resolveContactPipelineState({ qualificationDecision: "rebuild_candidate", email: "hello@example.com", emailEnrichmentStatus: "found", nextEmailEnrichmentAt: null }, now), "ready");
});

test("qualified contact retry and exhaustion remain visible states", () => {
  const now = new Date("2026-08-19T20:00:00Z");
  assert.equal(resolveContactPipelineState({ qualificationDecision: "rebuild_candidate", email: null, emailEnrichmentStatus: "retry", nextEmailEnrichmentAt: new Date("2026-08-20T20:00:00Z") }, now), "retry_scheduled");
  assert.equal(resolveContactPipelineState({ qualificationDecision: "rebuild_candidate", email: null, emailEnrichmentStatus: "exhausted", nextEmailEnrichmentAt: null }, now), "exhausted");
});
