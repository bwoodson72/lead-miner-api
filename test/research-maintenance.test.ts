import test from "node:test";
import assert from "node:assert/strict";
import { refreshStaleResearch } from "../src/lib/research-maintenance-routes.js";

function makePrisma(staleMessages: Array<{ id: number }> = [{ id: 10 }]) {
  let updateCalls = 0;
  const activities: any[] = [];
  return {
    prisma: {
      lead: {
        async findMany() { return [{ id: 1 }]; },
        async count() { return 0; },
      },
      outreachMessage: {
        async findMany() { return staleMessages; },
        async updateMany() { updateCalls += 1; return { count: staleMessages.length }; },
      },
      activity: {
        async create(args: any) { activities.push(args.data); return args.data; },
      },
    } as any,
    get updateCalls() { return updateCalls; },
    activities,
  };
}

test("v3 refresh cancels only snapshotted unsent outreach after successful research and regenerates qualified draft", async () => {
  const state = makePrisma([{ id: 10 }]);
  let draftCalls = 0;
  const result = await refreshStaleResearch(
    state.prisma,
    10,
    (async () => ({ result: { decision: "qualified" }, priorityScore: 80, draft: { id: 10 } })) as any,
    (async () => { draftCalls += 1; return { id: 20 }; }) as any,
  );

  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.staleDraftsCancelled, 1);
  assert.equal(result.replacementDraftsGenerated, 1);
  assert.equal(result.results[0]?.replacementDraftId, 20);
  assert.equal(state.updateCalls, 1);
  assert.equal(draftCalls, 1);
  assert.equal(state.activities[0]?.type, "stale_research_outreach_cancelled");
});

test("v3 refresh leaves old unsent outreach intact when research fails", async () => {
  const state = makePrisma([{ id: 10 }]);
  let draftCalls = 0;
  const result = await refreshStaleResearch(
    state.prisma,
    10,
    (async () => { throw new Error("research failed"); }) as any,
    (async () => { draftCalls += 1; return { id: 20 }; }) as any,
  );

  assert.equal(result.refreshed, 0);
  assert.equal(result.failed, 1);
  assert.equal(state.updateCalls, 0);
  assert.equal(draftCalls, 0);
  assert.equal(state.activities.length, 0);
});

test("v3 refresh does not cancel or regenerate when there was no stale unsent draft", async () => {
  const state = makePrisma([]);
  let draftCalls = 0;
  const result = await refreshStaleResearch(
    state.prisma,
    10,
    (async () => ({ result: { decision: "qualified" }, priorityScore: 80, draft: { id: 30 } })) as any,
    (async () => { draftCalls += 1; return { id: 40 }; }) as any,
  );

  assert.equal(result.refreshed, 1);
  assert.equal(result.staleDraftsCancelled, 0);
  assert.equal(state.updateCalls, 0);
  assert.equal(draftCalls, 0);
});
