import test from "node:test";
import assert from "node:assert/strict";
import { acquireAutomationSlot, releaseAutomationLease } from "../src/lib/automation-lock.js";
import { capRequestedLimit } from "../src/lib/safety-limits.js";
import { fetchWithProviderBackoff } from "../src/lib/provider-retry.js";

function makeMultiLockPrisma() {
  const rows = new Map<string, { name: string; token: string; expiresAt: Date }>();
  const prisma = {
    automationLock: {
      async updateMany(args: any) {
        const row = rows.get(args.where.name);
        const cutoff = args.where.expiresAt.lte as Date;
        if (row && row.expiresAt <= cutoff) {
          rows.set(row.name, { ...row, token: args.data.token, expiresAt: args.data.expiresAt });
          return { count: 1 };
        }
        return { count: 0 };
      },
      async create(args: any) {
        if (rows.has(args.data.name)) throw new Error("unique constraint");
        const row = { name: args.data.name, token: args.data.token, expiresAt: args.data.expiresAt };
        rows.set(row.name, row);
        return row;
      },
      async deleteMany(args: any) {
        const row = rows.get(args.where.name);
        if (row && row.token === args.where.token) {
          rows.delete(row.name);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  return { prisma: prisma as any, rows };
}

test("distributed slot pool enforces configured concurrency", async () => {
  const fake = makeMultiLockPrisma();
  const first = await acquireAutomationSlot(fake.prisma, "ai-work", 2, 60_000);
  const second = await acquireAutomationSlot(fake.prisma, "ai-work", 2, 60_000);
  const third = await acquireAutomationSlot(fake.prisma, "ai-work", 2, 60_000);
  assert.ok(first);
  assert.ok(second);
  assert.equal(third, null);
  assert.equal(fake.rows.size, 2);

  await releaseAutomationLease(fake.prisma, first);
  const replacement = await acquireAutomationSlot(fake.prisma, "ai-work", 2, 60_000);
  assert.ok(replacement);
  assert.equal(fake.rows.size, 2);
});

test("requested limits are clamped to hard server ceilings", () => {
  assert.equal(capRequestedLimit(500, 10, 20), 20);
  assert.equal(capRequestedLimit(0, 10, 20), 1);
  assert.equal(capRequestedLimit("7", 10, 20), 7);
  assert.equal(capRequestedLimit("not-a-number", 10, 20), 10);
});

test("provider retry retries transient responses and respects non-retryable failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let transientCalls = 0;
    globalThis.fetch = (async () => {
      transientCalls++;
      if (transientCalls === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const recovered = await fetchWithProviderBackoff("https://example.test", undefined, "test provider");
    assert.equal(recovered.status, 200);
    assert.equal(transientCalls, 2);

    let badRequestCalls = 0;
    globalThis.fetch = (async () => {
      badRequestCalls++;
      return new Response("bad", { status: 400 });
    }) as typeof fetch;
    const failed = await fetchWithProviderBackoff("https://example.test", undefined, "test provider");
    assert.equal(failed.status, 400);
    assert.equal(badRequestCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
