import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";

export const ApprovalModeSchema = z.enum(["manual", "shadow", "auto_safe"]);

export const AppSettingsInputSchema = z.object({
  autoResearch: z.boolean(),
  autoDraftOutreach: z.boolean(),
  approvalMode: ApprovalModeSchema,
  researchModel: z.string().min(1).max(100),
  outreachModel: z.string().min(1).max(100),
  researchInstructions: z.string().min(20).max(20000),
  outreachInstructions: z.string().min(20).max(20000),
  followUpInstructions: z.string().min(20).max(20000),
  replyInstructions: z.string().min(20).max(20000),
  researchBatchSize: z.number().int().min(1).max(100),
  minAutoApprovePriority: z.number().int().min(0).max(100),
  minAutoApproveConfidence: z.number().min(0).max(1),
  minProblemConfidence: z.number().min(0).max(1),
  dailySendLimit: z.number().int().min(1).max(1000),
  sendWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sendWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  followUpDelaysDays: z.array(z.number().int().min(1).max(90)).min(1).max(10),
  senderName: z.string().min(1).max(100),
  senderEmail: z.string().email().max(254),
});

export const AppSettingsPatchSchema = AppSettingsInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one setting is required" },
);

export type AppSettingsInput = z.infer<typeof AppSettingsInputSchema>;
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

async function syncDefaultSequence(prisma: PrismaClient, delays: number[]) {
  await prisma.outreachSequence.updateMany({ where: { isActive: true, name: { not: "Default outreach sequence" } }, data: { isActive: false } });
  return prisma.outreachSequence.upsert({
    where: { name: "Default outreach sequence" },
    update: { delaysDays: delays, maxTouches: delays.length + 1, isActive: true },
    create: { name: "Default outreach sequence", delaysDays: delays, maxTouches: delays.length + 1, isActive: true },
  });
}

export async function getAppSettings(prisma: PrismaClient) {
  const settings = await prisma.appSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  const delays = Array.isArray(settings.followUpDelaysDays) ? settings.followUpDelaysDays.filter((v): v is number => Number.isInteger(v) && Number(v) > 0) : [];
  if (delays.length) await syncDefaultSequence(prisma, delays);
  return settings;
}

export async function getActiveOutreachSequence(prisma: PrismaClient) {
  const active = await prisma.outreachSequence.findFirst({ where: { isActive: true }, orderBy: { updatedAt: "desc" } });
  if (active) return active;
  const settings = await getAppSettings(prisma);
  const delays = Array.isArray(settings.followUpDelaysDays) ? settings.followUpDelaysDays.filter((v): v is number => Number.isInteger(v) && Number(v) > 0) : [];
  return syncDefaultSequence(prisma, delays.length ? delays : [4, 6, 10]);
}

export async function updateAppSettings(prisma: PrismaClient, input: unknown) {
  const parsed = AppSettingsInputSchema.parse(input);
  const settings = await prisma.appSettings.upsert({ where: { id: 1 }, update: parsed, create: { id: 1, ...parsed } });
  await syncDefaultSequence(prisma, parsed.followUpDelaysDays);
  return settings;
}

export async function patchAppSettings(prisma: PrismaClient, input: unknown) {
  const parsed = AppSettingsPatchSchema.parse(input);
  const settings = await prisma.appSettings.upsert({
    where: { id: 1 },
    update: parsed,
    create: { id: 1, ...parsed },
  });
  if (parsed.followUpDelaysDays) await syncDefaultSequence(prisma, parsed.followUpDelaysDays);
  return settings;
}
