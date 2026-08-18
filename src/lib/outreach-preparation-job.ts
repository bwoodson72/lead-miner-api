import type { PrismaClient } from "../generated/prisma/client.js";
import { getAppSettings } from "./settings.js";
import { prepareLeadForOutreach } from "./outreach-preparation.js";
import { outreachDraftNeedsRegeneration } from "./ai-outreach.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

async function cancelUnsafeInitialDrafts(prisma: PrismaClient, limit: number) {
  const messages = await prisma.outreachMessage.findMany({
    where: { kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved"] } },
    orderBy: { generatedAt: "asc" },
    take: Math.max(20, Math.min(limit * 2, 200)),
    select: { id: true, leadId: true, subject: true, bodyText: true, cta: true, status: true },
  });
  let cancelled = 0;
  for (const message of messages) {
    if (!outreachDraftNeedsRegeneration(message.bodyText, message.subject, message.cta ?? "")) continue;
    await prisma.$transaction(async (tx) => {
      await tx.outreachMessage.update({
        where: { id: message.id },
        data: {
          status: "cancelled",
          requiresReview: true,
          sendError: "Cancelled by current Touch 1 quality and service-offer guard",
        },
      });
      await tx.activity.create({
        data: {
          leadId: message.leadId,
          type: "outreach_draft_invalidated",
          summary: "Cancelled an unsent outreach draft that failed current Touch 1 quality or service-offer checks",
          metadata: { messageId: message.id, previousStatus: message.status },
        },
      });
    });
    cancelled += 1;
  }
  return cancelled;
}

export async function processQualifiedOutreachPreparation(prisma: PrismaClient, limit = 10) {
  const settings = await getAppSettings(prisma);
  if (!settings.autoPrioritize) return [];
  const safeLimit = capRequestedLimit(limit, 10, SAFETY_LIMITS.bulkResearchMax);
  await cancelUnsafeInitialDrafts(prisma, safeLimit);
  const leads = await prisma.lead.findMany({
    where: {
      email: { not: null },
      qualificationDecision: "rebuild_candidate",
      status: { in: ["qualified", "ready_for_outreach"] },
      OR: [
        { priorityScore: null },
        { primaryOutreachAngle: null },
        { outreachMessages: { none: { kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved", "sending", "sent"] } } } },
      ],
    },
    orderBy: [{ priorityScore: { sort: "desc", nulls: "last" } }, { lastResearchedAt: "asc" }],
    take: safeLimit,
    select: { id: true },
  });
  const results: Array<{ leadId: number; success: boolean; priorityScore?: number; draftId?: number; held?: boolean; error?: string }> = [];
  for (const lead of leads) {
    try {
      const prepared = await prepareLeadForOutreach(prisma, lead.id, { generateDraft: settings.autoDraftOutreach });
      results.push({ leadId: lead.id, success: true, priorityScore: prepared.priority.score, draftId: prepared.draft?.id, held: prepared.held });
    } catch (error) {
      results.push({ leadId: lead.id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}