import test from "node:test";
import assert from "node:assert/strict";
import { acquireAutomationLease, releaseAutomationLease } from "../src/lib/automation-lock.js";

function makeLockPrisma() {
  let row: { name: string; token: string; expiresAt: Date } | null = null;
  const prisma = {
    automationLock: {
      async updateMany(args: any) {
        const cutoff = args.where.expiresAt.lte as Date;
        if (row && row.name === args.where.name && row.expiresAt <= cutoff) {
          row = { ...row, token: args.data.token, expiresAt: args.data.expiresAt };
          return { count: 1 };
        }
        return { count: 0 };
      },
      async create(args: any) {
        if (row) throw new Error("unique constraint");
        row = { name: args.data.name, token: args.data.token, expiresAt: args.data.expiresAt };
        return row;
      },
      async deleteMany(args: any) {
        if (row && row.name === args.where.name && row.token === args.where.token) {
          row = null;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  return { prisma: prisma as any, current: () => row };
}

test("automation lease prevents overlapping workers and releases cleanly", async () => {
  const fake = makeLockPrisma();
  const first = await acquireAutomationLease(fake.prisma, "automation-tick", 60_000);
  assert.ok(first);

  const overlapping = await acquireAutomationLease(fake.prisma, "automation-tick", 60_000);
  assert.equal(overlapping, null);

  await releaseAutomationLease(fake.prisma, first);
  assert.equal(fake.current(), null);

  const afterRelease = await acquireAutomationLease(fake.prisma, "automation-tick", 60_000);
  assert.ok(afterRelease);
});

test("expired automation lease can be reclaimed", async () => {
  const fake = makeLockPrisma();
  const expired = await acquireAutomationLease(fake.prisma, "outreach-send", -1);
  assert.ok(expired);

  const reclaimed = await acquireAutomationLease(fake.prisma, "outreach-send", 60_000);
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.token, expired.token);
});
