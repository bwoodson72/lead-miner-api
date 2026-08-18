import test from "node:test";
import assert from "node:assert/strict";
import { getPreparedLeadForResearch } from "../src/lib/research-preparation.js";

function makePrisma(initialLead: any) {
  let storedLead = { ...initialLead };
  return {
    prisma: {
      lead: {
        async findUnique() { return { ...storedLead }; },
      },
    } as any,
    updateLead(updates: Record<string, unknown>) {
      storedLead = { ...storedLead, ...updates };
    },
  };
}

test("manual research forces enrichment even when retry is scheduled in the future", async () => {
  const state = makePrisma({
    id: 101,
    email: null,
    emailEnrichmentStatus: "retry",
    emailEnrichmentReason: "site_fetch_failed",
    nextEmailEnrichmentAt: new Date("2026-08-20T12:00:00Z"),
  });
  let enrichmentCalls = 0;

  const prepared = await getPreparedLeadForResearch(
    state.prisma,
    101,
    (async () => {
      enrichmentCalls += 1;
      state.updateLead({
        email: "hello@example.com",
        emailEnrichmentStatus: "found",
        emailEnrichmentReason: "email_discovered",
        nextEmailEnrichmentAt: null,
      });
      return { leadId: 101, email: "hello@example.com", found: true, alreadyPresent: false, status: "found", attempts: 2, nextRetryAt: null };
    }) as any,
    new Date("2026-08-15T12:00:00Z"),
  );

  assert.equal(enrichmentCalls, 1);
  assert.equal(prepared.preparation.status, "email_found");
  assert.equal(prepared.lead.email, "hello@example.com");
});

test("manual research forces one new enrichment attempt for an exhausted no-email lead", async () => {
  const state = makePrisma({
    id: 102,
    email: null,
    emailEnrichmentStatus: "exhausted",
    emailEnrichmentReason: "search_exhausted",
    nextEmailEnrichmentAt: null,
  });
  let enrichmentCalls = 0;

  const prepared = await getPreparedLeadForResearch(
    state.prisma,
    102,
    (async () => {
      enrichmentCalls += 1;
      state.updateLead({
        email: "contact@example.com",
        emailEnrichmentStatus: "found",
        emailEnrichmentReason: "email_discovered",
      });
      return { leadId: 102, email: "contact@example.com", found: true, alreadyPresent: false, status: "found", attempts: 4, nextRetryAt: null };
    }) as any,
  );

  assert.equal(enrichmentCalls, 1);
  assert.equal(prepared.preparation.status, "email_found");
  assert.equal(prepared.lead.email, "contact@example.com");
});
