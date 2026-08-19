import type { PrismaClient } from "../generated/prisma/client.js";

export async function getGmailSendState(prisma: PrismaClient) {
  return prisma.gmailSendState.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

export async function setGmailQuotaCooldownState(prisma: PrismaClient, until: Date, reason: string) {
  return prisma.gmailSendState.upsert({
    where: { id: 1 },
    update: { cooldownUntil: until, cooldownReason: reason },
    create: { id: 1, cooldownUntil: until, cooldownReason: reason },
  });
}

export async function clearGmailQuotaCooldownState(prisma: PrismaClient) {
  return prisma.gmailSendState.upsert({
    where: { id: 1 },
    update: { cooldownUntil: null, cooldownReason: null },
    create: { id: 1 },
  });
}
