import type { PrismaClient } from "../generated/prisma/client.js";
import { enrichLeadEmail } from "./enrichment-routes.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

export function qualifiedContactWhere(now = new Date()) {
  return {
    email: null,
    qualificationDecision: "rebuild_candidate",
    status: { in: ["qualified", "ready_for_outreach"] },
    OR: [
      { emailEnrichmentStatus: "pending" },
      { emailEnrichmentStatus: "retry", nextEmailEnrichmentAt: { lte: now } },
    ],
  } as const;
}

export async function enrichQualifiedRebuildCandidates(prisma: PrismaClient, limit = 25) {
  const safeLimit = capRequestedLimit(limit, 25, SAFETY_LIMITS.bulkEnrichmentMax);
  const now = new Date();
  const leads = await prisma.lead.findMany({
    where: qualifiedContactWhere(now) as any,
    orderBy: [
      { nextEmailEnrichmentAt: { sort: "asc", nulls: "first" } },
      { updatedAt: "asc" },
    ],
    take: safeLimit,
    select: { id: true },
  });

  const results: Array<{
    leadId: number;
    email?: string | null;
    found: boolean;
    alreadyPresent?: boolean;
    status?: string;
    attempts?: number;
    nextRetryAt?: Date | null;
    error?: string;
  }> = [];

  for (const lead of leads) {
    try {
      results.push(await enrichLeadEmail(prisma, lead.id));
    } catch (error) {
      results.push({
        leadId: lead.id,
        found: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
