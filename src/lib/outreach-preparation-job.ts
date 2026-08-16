import type { PrismaClient } from "../generated/prisma/client.js";
import { getAppSettings } from "./settings.js";
import { prepareLeadForOutreach } from "./outreach-preparation.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

export async function processQualifiedOutreachPreparation(prisma: PrismaClient, limit = 10) {
  const settings = await getAppSettings(prisma);
  if (!settings.autoPrioritize) return [];
  const safeLimit = capRequestedLimit(limit, 10, SAFETY_LIMITS.bulkResearchMax);
  const leads = await prisma.lead.findMany({
    where: {
      email: { not: null },
      qualificationDecision: { in: ["rebuild_candidate", "optimization_candidate"] },
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
