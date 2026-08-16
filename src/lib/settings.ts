import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  DEFAULT_FOLLOW_UP_INSTRUCTIONS,
  FOLLOW_UP_COUNT,
  LEGACY_FOLLOW_UP_INSTRUCTIONS,
  TOTAL_OUTREACH_TOUCHES,
  normalizeFollowUpDelays,
} from "./outreach-sequence.js";

export const ApprovalModeSchema = z.enum(["manual", "shadow", "auto_safe"]);
const PriorityWeightsSchema = z.object({
  opportunityType: z.number().min(0).max(100),
  findingStrength: z.number().min(0).max(100),
  contactability: z.number().min(0).max(100),
  businessMaturity: z.number().min(0).max(100),
  acquisitionIntent: z.number().min(0).max(100),
  evidenceQuality: z.number().min(0).max(100),
}).refine((weights) => Object.values(weights).some((value) => value > 0), { message: "At least one priority weight must be greater than zero" });

export const AppSettingsInputSchema = z.object({
  autoEnrich: z.boolean(),
  autoResearch: z.boolean(),
  autoPrioritize: z.boolean(),
  autoSelectOutreachAngle: z.boolean(),
  autoDraftOutreach: z.boolean(),
  autoSyncReplies: z.boolean(),
  autoProcessFollowups: z.boolean(),
  autoSendApproved: z.boolean(),
  autoGenerateSuggestedReplies: z.boolean(),
  approvalMode: ApprovalModeSchema,
  researchModel: z.string().min(1).max(100),
  outreachModel: z.string().min(1).max(100),
  researchInstructions: z.string().min(20).max(20000),
  outreachInstructions: z.string().min(20).max(20000),
  followUpInstructions: z.string().min(20).max(20000),
  replyInstructions: z.string().min(20).max(20000),
  researchBatchSize: z.number().int().min(1).max(100),
  minPriorityScore: z.number().int().min(0).max(100),
  minAutoApprovePriority: z.number().int().min(0).max(100),
  minAutoApproveConfidence: z.number().min(0).max(1),
  minProblemConfidence: z.number().min(0).max(1),
  priorityWeights: PriorityWeightsSchema,
  dailyAiSpendLimit: z.number().min(0.01).max(10000),
  monthlyAiSpendLimit: z.number().min(0.01).max(100000),
  dailySendLimit: z.number().int().min(1).max(1000),
  sendWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sendWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sendTimezone: z.string().min(1).max(100),
  weekendSendingEnabled: z.boolean(),
  reanalysisAgeDays: z.number().int().min(1).max(365),
  followUpDelaysDays: z.array(z.number().int().min(1).max(90)).length(FOLLOW_UP_COUNT),
  senderName: z.string().min(1).max(100),
  senderEmail: z.string().email().max(254),
});

export const AppSettingsPatchSchema = AppSettingsInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one setting is required" },
);

export type AppSettingsInput = z.infer<typeof AppSettingsInputSchema>;
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

async function syncDefaultSequence(prisma: PrismaClient, inputDelays: unknown) {
  const delays = normalizeFollowUpDelays(inputDelays);
  await prisma.outreachSequence.updateMany({ where: { isActive: true, name: { not: "Default outreach sequence" } }, data: { isActive: false } });
  return prisma.outreachSequence.upsert({
    where: { name: "Default outreach sequence" },
    update: { delaysDays: delays, maxTouches: TOTAL_OUTREACH_TOUCHES, isActive: true },
    create: { name: "Default outreach sequence", delaysDays: delays, maxTouches: TOTAL_OUTREACH_TOUCHES, isActive: true },
  });
}

export async function getAppSettings(prisma: PrismaClient) {
  let settings = await prisma.appSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  const delays = normalizeFollowUpDelays(settings.followUpDelaysDays);
  const delaysChanged = JSON.stringify(settings.followUpDelaysDays) !== JSON.stringify(delays);
  const instructionsChanged = settings.followUpInstructions === LEGACY_FOLLOW_UP_INSTRUCTIONS;

  if (delaysChanged || instructionsChanged) {
    settings = await prisma.appSettings.update({
      where: { id: 1 },
      data: {
        ...(delaysChanged ? { followUpDelaysDays: delays } : {}),
        ...(instructionsChanged ? { followUpInstructions: DEFAULT_FOLLOW_UP_INSTRUCTIONS } : {}),
      },
    });
  }

  await syncDefaultSequence(prisma, delays);
  return settings;
}

export async function getActiveOutreachSequence(prisma: PrismaClient) {
  const settings = await getAppSettings(prisma);
  return syncDefaultSequence(prisma, settings.followUpDelaysDays);
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
