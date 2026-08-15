import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";

export const ApprovalModeSchema = z.enum(["manual", "shadow", "auto_safe"]);
export const EmailProviderSchema = z.enum(["resend", "gmail"]);

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
  emailProvider: EmailProviderSchema,
});

export const AIInstructionsInputSchema = z.object({
  researchInstructions: z.string().min(20).max(20000),
  outreachInstructions: z.string().min(20).max(20000),
  followUpInstructions: z.string().min(20).max(20000),
  replyInstructions: z.string().min(20).max(20000),
});

export type AppSettingsInput = z.infer<typeof AppSettingsInputSchema>;
export type AIInstructionsInput = z.infer<typeof AIInstructionsInputSchema>;

export async function getAppSettings(prisma: PrismaClient) {
  return prisma.appSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

export async function updateAppSettings(prisma: PrismaClient, input: unknown) {
  const parsed = AppSettingsInputSchema.parse(input);
  return prisma.appSettings.upsert({ where: { id: 1 }, update: parsed, create: { id: 1, ...parsed } });
}

export async function updateAIInstructions(prisma: PrismaClient, input: unknown) {
  const parsed = AIInstructionsInputSchema.parse(input);
  return prisma.appSettings.upsert({
    where: { id: 1 },
    update: parsed,
    create: { id: 1, ...parsed },
  });
}
