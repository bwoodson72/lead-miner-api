import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";

export const DEFAULT_GMAIL_ROLLING_24H_SAFETY_LIMIT = 100;
export const DEFAULT_MINIMUM_SEND_INTERVAL_MINUTES = 10;
export const DEFAULT_GMAIL_QUOTA_COOLDOWN_HOURS = 24;

export const GmailSendPolicyPatchSchema = z.object({
  gmailRolling24hSafetyLimit: z.number().int().min(1).max(2000).optional(),
  minimumSendIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  gmailQuotaCooldownHours: z.number().int().min(1).max(72).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "At least one Gmail send-safety setting is required" });

export const GMAIL_SEND_POLICY_KEYS = [
  "gmailRolling24hSafetyLimit",
  "minimumSendIntervalMinutes",
  "gmailQuotaCooldownHours",
] as const;

export type GmailSendPolicy = {
  gmailRolling24hSafetyLimit: number;
  minimumSendIntervalMinutes: number;
  gmailQuotaCooldownHours: number;
  gmailQuotaCooldownUntil: Date | null;
  gmailQuotaCooldownReason: string | null;
};

type RawPolicy = {
  rolling_24h_safety_limit: number;
  minimum_send_interval_minutes: number;
  quota_cooldown_hours: number;
  cooldown_until: Date | null;
  cooldown_reason: string | null;
};

async function ensurePolicyRow(prisma: PrismaClient) {
  await prisma.$executeRaw`
    INSERT INTO "gmail_send_policy" (
      "id",
      "rolling_24h_safety_limit",
      "minimum_send_interval_minutes",
      "quota_cooldown_hours"
    ) VALUES (
      1,
      ${DEFAULT_GMAIL_ROLLING_24H_SAFETY_LIMIT},
      ${DEFAULT_MINIMUM_SEND_INTERVAL_MINUTES},
      ${DEFAULT_GMAIL_QUOTA_COOLDOWN_HOURS}
    )
    ON CONFLICT ("id") DO NOTHING
  `;
}

export async function getGmailSendPolicy(prisma: PrismaClient): Promise<GmailSendPolicy> {
  await ensurePolicyRow(prisma);
  const rows = await prisma.$queryRaw<RawPolicy[]>`
    SELECT
      "rolling_24h_safety_limit",
      "minimum_send_interval_minutes",
      "quota_cooldown_hours",
      "cooldown_until",
      "cooldown_reason"
    FROM "gmail_send_policy"
    WHERE "id" = 1
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Gmail send policy row is missing");
  return {
    gmailRolling24hSafetyLimit: Number(row.rolling_24h_safety_limit),
    minimumSendIntervalMinutes: Number(row.minimum_send_interval_minutes),
    gmailQuotaCooldownHours: Number(row.quota_cooldown_hours),
    gmailQuotaCooldownUntil: row.cooldown_until ? new Date(row.cooldown_until) : null,
    gmailQuotaCooldownReason: row.cooldown_reason ?? null,
  };
}

export async function patchGmailSendPolicy(prisma: PrismaClient, input: unknown) {
  const parsed = GmailSendPolicyPatchSchema.parse(input);
  await ensurePolicyRow(prisma);
  if (parsed.gmailRolling24hSafetyLimit !== undefined) {
    await prisma.$executeRaw`
      UPDATE "gmail_send_policy"
      SET "rolling_24h_safety_limit" = ${parsed.gmailRolling24hSafetyLimit}, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = 1
    `;
  }
  if (parsed.minimumSendIntervalMinutes !== undefined) {
    await prisma.$executeRaw`
      UPDATE "gmail_send_policy"
      SET "minimum_send_interval_minutes" = ${parsed.minimumSendIntervalMinutes}, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = 1
    `;
  }
  if (parsed.gmailQuotaCooldownHours !== undefined) {
    await prisma.$executeRaw`
      UPDATE "gmail_send_policy"
      SET "quota_cooldown_hours" = ${parsed.gmailQuotaCooldownHours}, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = 1
    `;
  }
  return getGmailSendPolicy(prisma);
}

export async function setGmailQuotaCooldown(prisma: PrismaClient, until: Date, reason: string) {
  await ensurePolicyRow(prisma);
  await prisma.$executeRaw`
    UPDATE "gmail_send_policy"
    SET
      "cooldown_until" = ${until},
      "cooldown_reason" = ${reason},
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 1
  `;
  return getGmailSendPolicy(prisma);
}

export async function clearGmailQuotaCooldown(prisma: PrismaClient) {
  await ensurePolicyRow(prisma);
  await prisma.$executeRaw`
    UPDATE "gmail_send_policy"
    SET
      "cooldown_until" = NULL,
      "cooldown_reason" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 1
  `;
}
