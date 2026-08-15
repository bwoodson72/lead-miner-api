import test from "node:test";
import assert from "node:assert/strict";
import { prepareLeadForResearch } from "../src/lib/research-preparation.js";

function fakePrisma(lead: any) {
  return {
    lead: {
      async findUnique() { return lead; },
    },
  } as any;
}

test("lead with an existing email is research-ready without enrichment", async () => {
  let calls = 0;
  const result = await prepareLeadForResearch(
    fakePrisma({ id: 1, email: "hello@example.com", emailEnrichmentStatus: "found", emailEnrichmentReason: "email_present", nextEmailEnrichmentAt: null }),
    1,
    (async () => { calls += 1; throw new Error("should not enrich"); }) as any,
  );

  assert.equal(result.ready, true);
  assert.equal(result.status, "ready");
  assert.equal(result.alreadyHadEmail, true);
  assert.equal(result.enrichmentAttempted, false);
  assert.equal(calls, 0);
});

test("pending no-email lead is enriched before becoming research-ready", async () => {
  let calls = 0;
  const result = await prepareLeadForResearch(
    fakePrisma({ id: 2, email: null, emailEnrichmentStatus: "pending", emailEnrichmentReason: null, nextEmailEnrichmentAt: null }),
    2,
    (async () => {
      calls += 1;
      return { leadId: 2, email: "sales@contractor.com", found: true, alreadyPresent: false, status: "found", attempts: 1, nextRetryAt: null };
    }) as any,
  );

  assert.equal(result.ready, true);
  assert.equal(result.status, "email_found");
  assert.equal(result.email, "sales@contractor.com");
  assert.equal(result.enrichmentAttempted, true);
  assert.equal(calls, 1);
});

test("exhausted no-email lead is skipped without spending another enrichment attempt", async () => {
  let calls = 0;
  const result = await prepareLeadForResearch(
    fakePrisma({ id: 3, email: null, emailEnrichmentStatus: "exhausted", emailEnrichmentReason: "search_exhausted", nextEmailEnrichmentAt: null }),
    3,
    (async () => { calls += 1; throw new Error("should not enrich"); }) as any,
  );

  assert.equal(result.ready, false);
  assert.equal(result.status, "exhausted");
  assert.equal(result.enrichmentAttempted, false);
  assert.equal(calls, 0);
});

test("future retry is deferred until its scheduled time", async () => {
  let calls = 0;
  const now = new Date("2026-08-15T21:00:00Z");
  const retryAt = new Date("2026-08-16T21:00:00Z");
  const result = await prepareLeadForResearch(
    fakePrisma({ id: 4, email: null, emailEnrichmentStatus: "retry", emailEnrichmentReason: "site_fetch_failed", nextEmailEnrichmentAt: retryAt }),
    4,
    (async () => { calls += 1; throw new Error("should not enrich yet"); }) as any,
    now,
  );

  assert.equal(result.ready, false);
  assert.equal(result.status, "deferred");
  assert.equal(result.nextRetryAt?.toISOString(), retryAt.toISOString());
  assert.equal(calls, 0);
});

test("due retry gets a new enrichment pass and can proceed to research", async () => {
  let calls = 0;
  const now = new Date("2026-08-15T21:00:00Z");
  const result = await prepareLeadForResearch(
    fakePrisma({ id: 5, email: null, emailEnrichmentStatus: "retry", emailEnrichmentReason: "site_fetch_failed", nextEmailEnrichmentAt: new Date("2026-08-14T21:00:00Z") }),
    5,
    (async () => {
      calls += 1;
      return { leadId: 5, email: "info@roofer.com", found: true, alreadyPresent: false, status: "found", attempts: 2, nextRetryAt: null };
    }) as any,
    now,
  );

  assert.equal(result.ready, true);
  assert.equal(result.status, "email_found");
  assert.equal(calls, 1);
});

test("completed enrichment with no email blocks AI research", async () => {
  const result = await prepareLeadForResearch(
    fakePrisma({ id: 6, email: null, emailEnrichmentStatus: "pending", emailEnrichmentReason: null, nextEmailEnrichmentAt: null }),
    6,
    (async () => ({ leadId: 6, email: null, found: false, alreadyPresent: false, status: "exhausted", attempts: 1, nextRetryAt: null })) as any,
  );

  assert.equal(result.ready, false);
  assert.equal(result.status, "exhausted");
  assert.equal(result.enrichmentAttempted, true);
});
