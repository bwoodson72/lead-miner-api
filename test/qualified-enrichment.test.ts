import test from "node:test";
import assert from "node:assert/strict";
import { qualifiedContactWhere } from "../src/lib/qualified-enrichment.js";

test("automatic contact enrichment targets only qualified rebuild candidates", () => {
  const now = new Date("2026-08-19T20:00:00Z");
  const where = qualifiedContactWhere(now);
  assert.equal(where.email, null);
  assert.equal(where.qualificationDecision, "rebuild_candidate");
  assert.deepEqual(where.status, { in: ["qualified", "ready_for_outreach"] });
  assert.deepEqual(where.OR, [
    { emailEnrichmentStatus: "pending" },
    { emailEnrichmentStatus: "retry", nextEmailEnrichmentAt: { lte: now } },
  ]);
});

test("research-stage states are absent from the automatic contact selector", () => {
  const where = qualifiedContactWhere();
  assert.ok(!where.status.in.includes("new" as any));
  assert.ok(!where.status.in.includes("research_pending" as any));
  assert.ok(!Object.prototype.hasOwnProperty.call(where, "screeningStatus"));
});
