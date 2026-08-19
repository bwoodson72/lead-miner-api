import test from "node:test";
import assert from "node:assert/strict";
import { refreshLeadPriorityForDecision } from "../src/lib/priority-refresh.js";

function fakePrisma(email: string | null = "hello@example.com") {
  const updates: any[] = [];
  return {
    prisma: {
      lead: {
        async findUnique() { return { email }; },
        async update(args: any) { updates.push(args); return args; },
      },
    } as any,
    updates,
  };
}

test("contactable rebuild candidate calculates priority immediately when enabled", async () => {
  const state = fakePrisma();
  let calls = 0;
  const score = await refreshLeadPriorityForDecision(state.prisma, 42, "rebuild_candidate", {
    enabled: true,
    calculator: (async () => {
      calls += 1;
      return { score: 73 } as any;
    }) as any,
  });

  assert.equal(score, 73);
  assert.equal(calls, 1);
  assert.equal(state.updates.length, 0);
});

test("qualified rebuild without email waits for contact enrichment instead of failing priority", async () => {
  const state = fakePrisma(null);
  let calls = 0;
  const score = await refreshLeadPriorityForDecision(state.prisma, 42, "rebuild_candidate", {
    enabled: true,
    calculator: (async () => { calls += 1; return { score: 73 } as any; }) as any,
  });

  assert.equal(score, null);
  assert.equal(calls, 0);
  assert.deepEqual(state.updates, [{ where: { id: 42 }, data: { priorityScore: null, priorityBreakdown: {} } }]);
});

test("disabled automatic prioritization leaves rebuild score pending", async () => {
  const state = fakePrisma();
  let calls = 0;
  const score = await refreshLeadPriorityForDecision(state.prisma, 42, "rebuild_candidate", {
    enabled: false,
    calculator: (async () => { calls += 1; return { score: 73 } as any; }) as any,
  });

  assert.equal(score, null);
  assert.equal(calls, 0);
  assert.equal(state.updates.length, 0);
});

test("non-rebuild decisions clear stale priority instead of retaining it", async () => {
  const state = fakePrisma();
  const score = await refreshLeadPriorityForDecision(state.prisma, 42, "no_material_opportunity");

  assert.equal(score, null);
  assert.deepEqual(state.updates, [{ where: { id: 42 }, data: { priorityScore: null, priorityBreakdown: {} } }]);
});
