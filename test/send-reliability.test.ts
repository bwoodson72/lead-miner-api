import test from "node:test";
import assert from "node:assert/strict";
import { claimApprovedMessage, reconcileStaleSends } from "../src/lib/outreach-sending.js";

function makeClaimPrisma(initialStatus: string) {
  const message: any = { id: 7, status: initialStatus, idempotencyKey: null, sendAttemptedAt: null, sendError: null };
  return {
    message,
    prisma: {
      outreachMessage: {
        async updateMany(args: any) {
          if (message.id === args.where.id && message.status === args.where.status) {
            Object.assign(message, args.data);
            return { count: 1 };
          }
          return { count: 0 };
        },
        async findUnique() { return { ...message }; },
      },
    } as any,
  };
}

test("concurrent approved-message claims allow exactly one winner", async () => {
  const fake = makeClaimPrisma("approved");
  const attemptedAt = new Date("2026-08-15T20:00:00.000Z");

  const results = await Promise.allSettled([
    claimApprovedMessage(fake.prisma, 7, attemptedAt),
    claimApprovedMessage(fake.prisma, 7, attemptedAt),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((fulfilled[0] as PromiseFulfilledResult<any>).value.state, "claimed");
  assert.equal(fake.message.status, "sending");
  assert.equal(fake.message.idempotencyKey, "lead-miner/outreach/7");
  assert.equal(fake.message.sendAttemptedAt, attemptedAt);
});

test("claim is idempotent when the message is already sent", async () => {
  const fake = makeClaimPrisma("sent");
  const result = await claimApprovedMessage(fake.prisma, 7);
  assert.equal(result.state, "already_sent");
});

function makeReconcilePrisma() {
  const now = Date.now();
  const messages = [
    { id: 1, status: "sending", sendAttemptedAt: new Date(now - 10 * 60_000) },
    { id: 2, status: "sending", sendAttemptedAt: new Date(now - 30_000) },
  ];
  let lock: { name: string; token: string; expiresAt: Date } | null = null;

  const prisma = {
    outreachMessage: {
      async findMany(args: any) {
        const cutoff = args.where.sendAttemptedAt.lte as Date;
        return messages
          .filter((m) => m.status === args.where.status && m.sendAttemptedAt <= cutoff)
          .slice(0, args.take)
          .map((m) => ({ id: m.id }));
      },
      async update(args: any) {
        const message = messages.find((m) => m.id === args.where.id)!;
        Object.assign(message, args.data);
        return { ...message };
      },
    },
    automationLock: {
      async updateMany(args: any) {
        const cutoff = args.where.expiresAt.lte as Date;
        if (lock && lock.name === args.where.name && lock.expiresAt <= cutoff) {
          lock = { ...lock, token: args.data.token, expiresAt: args.data.expiresAt };
          return { count: 1 };
        }
        return { count: 0 };
      },
      async create(args: any) {
        if (lock) throw new Error("unique constraint");
        lock = { name: args.data.name, token: args.data.token, expiresAt: args.data.expiresAt };
        return lock;
      },
      async deleteMany(args: any) {
        if (lock && lock.name === args.where.name && lock.token === args.where.token) {
          lock = null;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };

  return { prisma: prisma as any, messages };
}

test("stale reconciliation retries only old sending messages", async () => {
  const fake = makeReconcilePrisma();
  const resent: number[] = [];

  const results = await reconcileStaleSends(fake.prisma, 10, async (_prisma, messageId) => {
    resent.push(messageId);
  });

  assert.deepEqual(resent, [1]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.success, true);
  assert.ok(fake.messages[0]!.sendAttemptedAt.getTime() > Date.now() - 60_000);
});
