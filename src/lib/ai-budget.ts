import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function hashAiPacket(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function utcDayStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcMonthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getAiBudgetStatus(
  prisma: PrismaClient,
  settings: { dailyAiSpendLimit: number; monthlyAiSpendLimit: number },
  now = new Date(),
) {
  const dayStart = utcDayStart(now);
  const monthStart = utcMonthStart(now);
  const [daily, monthly] = await Promise.all([
    prisma.aIJob.aggregate({ where: { createdAt: { gte: dayStart }, status: "complete" }, _sum: { estimatedCost: true } }),
    prisma.aIJob.aggregate({ where: { createdAt: { gte: monthStart }, status: "complete" }, _sum: { estimatedCost: true } }),
  ]);
  const dailySpent = daily._sum.estimatedCost ?? 0;
  const monthlySpent = monthly._sum.estimatedCost ?? 0;
  return {
    dailySpent,
    monthlySpent,
    dailyLimit: settings.dailyAiSpendLimit,
    monthlyLimit: settings.monthlyAiSpendLimit,
    dailyRemaining: Math.max(0, settings.dailyAiSpendLimit - dailySpent),
    monthlyRemaining: Math.max(0, settings.monthlyAiSpendLimit - monthlySpent),
    reached: dailySpent >= settings.dailyAiSpendLimit || monthlySpent >= settings.monthlyAiSpendLimit,
    reason: dailySpent >= settings.dailyAiSpendLimit
      ? "Daily AI budget reached"
      : monthlySpent >= settings.monthlyAiSpendLimit
        ? "Monthly AI budget reached"
        : null,
  };
}

export async function assertAiBudgetAvailable(
  prisma: PrismaClient,
  settings: { dailyAiSpendLimit: number; monthlyAiSpendLimit: number },
) {
  const status = await getAiBudgetStatus(prisma, settings);
  if (status.reached) throw new Error(status.reason ?? "AI budget reached");
  return status;
}
