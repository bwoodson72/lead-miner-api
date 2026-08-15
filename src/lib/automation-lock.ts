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

export async function releaseAutomationLease(prisma: PrismaClient, lease: AutomationLease) {
  await prisma.automationLock.deleteMany({ where: { name: lease.name, token: lease.token } });
}
