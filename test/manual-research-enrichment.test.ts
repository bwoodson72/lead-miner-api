import test from "node:test";
import assert from "node:assert/strict";
import { getPreparedLeadForResearch } from "../src/lib/research-preparation.js";

function makePrisma(initialLead: any) {
  const storedLead = { ...initialLead };
  return {
    lead: {
      async findUnique() { return { ...storedLead }; },
    },
  } as any;
}

test("manual research never invokes email enrichment for a no-email lead", async () => {
  const prisma = makePrisma({
    id: 101,
    email: null,
    enrichmentNotes: "No contact address found yet",
    emailEnrichmentStatus: "retry",
  });
  let enrichmentCalls = 0;

  const prepared = await getPreparedLeadForResearch(
    prisma,
    101,
    (async () => {
      enrichmentCalls += 1;
      throw new Error("Research must not call contact enrichment");
    }) as any,
  );

  assert.equal(enrichmentCalls, 0);
  assert.equal(prepared.preparation.status, "ready");
  assert.equal(prepared.preparation.email, null);
  assert.equal(prepared.preparation.enrichmentAttempted, false);
  assert.equal(prepared.lead.email, null);
});

test("exhausted contact discovery does not block website research", async () => {
  const prisma = makePrisma({
    id: 102,
    email: null,
    enrichmentNotes: "Search exhausted",
    emailEnrichmentStatus: "exhausted",
  });

  const prepared = await getPreparedLeadForResearch(prisma, 102);

  assert.equal(prepared.preparation.status, "ready");
  assert.equal(prepared.preparation.alreadyHadEmail, false);
  assert.equal(prepared.preparation.enrichmentAttempted, false);
});

test("an existing email is retained as metadata but is not a research requirement", async () => {
  const prisma = makePrisma({
    id: 103,
    email: "hello@example.com",
    enrichmentNotes: null,
  });

  const prepared = await getPreparedLeadForResearch(prisma, 103);

  assert.equal(prepared.preparation.status, "ready");
  assert.equal(prepared.preparation.alreadyHadEmail, true);
  assert.equal(prepared.preparation.email, "hello@example.com");
});
