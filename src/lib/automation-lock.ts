import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

export type AutomationLease = {
  name: string;
  token: string;
  expiresAt: Date;
};

export async function acquireAutomationLease(
  prisma: PrismaClient,
  name: string,
  ttlMs = 5 * 60_000,
): Promise<AutomationLease | null> {
  const now = new Date();
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const reclaimed = await prisma.automationLock.updateMany({
    where: { name, expiresAt: { lte: now } },
    data: { token, expiresAt },
  });
  if (reclaimed.count === 1) return { name, token, expiresAt };

  try {
    await prisma.automationLock.create({ data: { name, token, expiresAt } });
    return { name, token, expiresAt };
  } catch {
    return null;
  }
}

/** Acquire one lease from a bounded pool. This acts as a distributed semaphore. */
export async function acquireAutomationSlot(
  prisma: PrismaClient,
  poolName: string,
  slots: number,
  ttlMs = 5 * 60_000,
): Promise<AutomationLease | null> {
  const count = Math.max(1, Math.floor(slots));
  const start = Math.floor(Math.random() * count);
  for (let offset = 0; offset < count; offset++) {
    const index = (start + offset) % count;
    const lease = await acquireAutomationLease(prisma, `${poolName}:${index}`, ttlMs);
    if (lease) return lease;
  }
  return null;
}

export async function releaseAutomationLease(prisma: PrismaClient, lease: AutomationLease) {
  await prisma.automationLock.deleteMany({ where: { name: lease.name, token: lease.token } });
}
