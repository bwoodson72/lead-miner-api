import test from "node:test";
import assert from "node:assert/strict";
import { refreshStaleResearch } from "../src/lib/research-maintenance-routes.js";

function makePrisma(researchVersion = "lead-research-v10") {
  return {
    lead: {
      async findMany() { return [{ id: 1, researchVersion }]; },
      async count() { return 0; },
    },
  } as any;
}

test("stale research refresh upgrades pre-v12 research and reports invalidated unsent outreach", async () => {
  const result = await refreshStaleResearch(
    makePrisma(),
    10,
    (async () => ({
      result: { decision: "rebuild_candidate" },
      priorityScore: null,
      draft: null,
      invalidatedDrafts: 1,
    })) as any,
  );

  assert.equal(result.targetResearchVersion, "lead-research-v12");
  assert.deepEqual(result.staleResearchVersions, ["lead-research-v3", "lead-research-v4", "lead-research-v5", "lead-research-v6", "lead-research-v7", "lead-research-v8", "lead-research-v9", "lead-research-v10", "lead-research-v11"]);
  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.invalidatedDrafts, 1);
  assert.equal(result.replacementDraftsGenerated, 0);
  assert.equal(result.results[0]?.previousResearchVersion, "lead-research-v10");
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

test("v12 research does not generate replacement outreach before prioritization and angle selection", async () => {
  const result = await refreshStaleResearch(
    makePrisma("lead-research-v11"),
    10,
    (async () => ({
      result: { decision: "no_material_opportunity" },
      priorityScore: null,
      draft: null,
      invalidatedDrafts: 0,
    })) as any,
  );

  assert.equal(result.refreshed, 1);
  assert.equal(result.invalidatedDrafts, 0);
  assert.equal(result.replacementDraftsGenerated, 0);
});