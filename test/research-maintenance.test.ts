import test from "node:test";
import assert from "node:assert/strict";
import { refreshStaleResearch } from "../src/lib/research-maintenance-routes.js";

function makePrisma(researchVersion = "lead-research-v4") {
  return {
    lead: {
      async findMany() { return [{ id: 1, researchVersion }]; },
      async count() { return 0; },
    },
  } as any;
}

test("stale research refresh reports invalidated unsent outreach and replacement draft from core research", async () => {
  const result = await refreshStaleResearch(
    makePrisma(),
    10,
    (async () => ({
      result: { decision: "qualified" },
      priorityScore: 80,
      draft: { id: 20 },
      invalidatedDrafts: 1,
    })) as any,
  );

  assert.equal(result.targetResearchVersion, "lead-research-v5");
  assert.deepEqual(result.staleResearchVersions, ["lead-research-v3", "lead-research-v4"]);
  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.invalidatedDrafts, 1);
  assert.equal(result.replacementDraftsGenerated, 1);
  assert.equal(result.results[0]?.previousResearchVersion, "lead-research-v4");
  assert.equal(result.results[0]?.replacementDraftId, 20);
});

test("stale research refresh leaves draft handling to core research when research fails", async () => {
  const result = await refreshStaleResearch(
    makePrisma("lead-research-v3"),
    10,
    (async () => { throw new Error("research failed"); }) as any,
  );

  assert.equal(result.refreshed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.invalidatedDrafts, 0);
  assert.equal(result.replacementDraftsGenerated, 0);
  assert.equal(result.results[0]?.previousResearchVersion, "lead-research-v3");
  assert.match(result.results[0]?.error ?? "", /research failed/);
});

test("stale research refresh reports zero invalidations when no old unsent draft existed", async () => {
  const result = await refreshStaleResearch(
    makePrisma(),
    10,
    (async () => ({
      result: { decision: "qualified" },
      priorityScore: 80,
      draft: { id: 30 },
      invalidatedDrafts: 0,
    })) as any,
  );

  assert.equal(result.refreshed, 1);
  assert.equal(result.invalidatedDrafts, 0);
  assert.equal(result.replacementDraftsGenerated, 1);
  assert.equal(result.results[0]?.replacementDraftId, 30);
});
