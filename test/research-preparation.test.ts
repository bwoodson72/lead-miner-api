import test from "node:test";
import assert from "node:assert/strict";
import {
  getPreparedLeadForResearch,
  prepareLeadForResearch,
  ResearchPreparationError,
} from "../src/lib/research-preparation.js";

function fakePrisma(lead: any) {
  return {
    lead: {
      async findUnique() { return lead ? { ...lead } : null; },
    },
  } as any;
}

test("lead with an existing email is research-ready without enrichment", async () => {
  let calls = 0;
  const result = await prepareLeadForResearch(
    fakePrisma({ id: 1, email: "hello@example.com", enrichmentNotes: null }),
    1,
    (async () => { calls += 1; throw new Error("should not enrich"); }) as any,
  );

  assert.equal(result.ready, true);
  assert.equal(result.status, "ready");
  assert.equal(result.alreadyHadEmail, true);
  assert.equal(result.enrichmentAttempted, false);
  assert.equal(calls, 0);
});

test("pending no-email lead is research-ready without contact enrichment", async () => {
  let calls = 0;
  const result = await prepareLeadForResearch(
    fakePrisma({ id: 2, email: null, enrichmentNotes: null }),
    2,
    (async () => { calls += 1; throw new Error("contact enrichment must be downstream"); }) as any,
  );

  assert.equal(result.ready, true);
  assert.equal(result.status, "ready");
  assert.equal(result.email, null);
  assert.equal(result.enrichmentAttempted, false);
  assert.equal(calls, 0);
});

test("exhausted or deferred contact state cannot suppress research", async () => {
  for (const emailEnrichmentStatus of ["exhausted", "retry"]) {
    const result = await prepareLeadForResearch(
      fakePrisma({ id: 3, email: null, enrichmentNotes: emailEnrichmentStatus, emailEnrichmentStatus }),
      3,
    );
    assert.equal(result.ready, true);
    assert.equal(result.status, "ready");
    assert.equal(result.enrichmentAttempted, false);
  }
});

test("core research preparation returns the persisted lead even without email", async () => {
  let reads = 0;
  const prisma = {
    lead: {
      async findUnique() {
        reads += 1;
        return { id: 7, email: null, enrichmentNotes: null, businessName: "Example Roofing" };
      },
    },
  } as any;

  const prepared = await getPreparedLeadForResearch(prisma, 7);

  assert.equal(reads, 2);
  assert.equal(prepared.preparation.status, "ready");
  assert.equal(prepared.lead.email, null);
});

test("missing lead remains the only research preparation failure", async () => {
  await assert.rejects(
    () => getPreparedLeadForResearch(fakePrisma(null), 8),
    (error: unknown) => {
      assert.ok(error instanceof ResearchPreparationError);
      assert.equal(error.preparation.status, "missing");
      assert.match(error.message, /lead not found/i);
      return true;
    },
  );
});
