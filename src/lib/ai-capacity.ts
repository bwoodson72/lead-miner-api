import type { PrismaClient } from "../generated/prisma/client.js";
import { acquireAutomationSlot, releaseAutomationLease } from "./automation-lock.js";
import { SAFETY_LIMITS } from "./safety-limits.js";

export async function withAiCapacity<T>(prisma: PrismaClient, operation: () => Promise<T>): Promise<T> {
  const slot = await acquireAutomationSlot(prisma, "ai-work", SAFETY_LIMITS.aiResearchConcurrency, 10 * 60_000);
  if (!slot) throw new Error(`AI concurrency limit reached (${SAFETY_LIMITS.aiResearchConcurrency})`);
  try { return await operation(); }
  finally { await releaseAutomationLease(prisma, slot); }
}
