import type { PrismaClient } from "../generated/prisma/client.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";
import { processLeadResearch } from "./research-routes.js";
import { rankResearchCandidates, type ResearchQueueBreakdown } from "./research-queue.js";

export async function processScoredResearchQueue(
  prisma: PrismaClient,
  limit = 10,
  now = new Date(),
) {
  const safeLimit = capRequestedLimit(limit, 10, SAFETY_LIMITS.bulkResearchMax);
  const poolSize = Math.min(Math.max(safeLimit * 20, 200), 2000);
  const candidates = await prisma.lead.findMany({
    where: {
      status: { in: ["new", "research_pending"] },
      lastResearchedAt: null,
      screeningStatus: { in: ["complete", "partial", "failed"] },
      aiJobs: { none: { type: "lead_research", status: { in: ["running", "complete"] } } },
    },
    orderBy: { createdAt: "asc" },
    take: poolSize,
    select: {
      id: true,
      adSource: true,
      performanceOpportunity: true,
      screeningStatus: true,
      businessName: true,
      phone: true,
      address: true,
      createdAt: true,
    },
  });

  const ranked = rankResearchCandidates(candidates, now).slice(0, safeLimit);
  const results: Array<{
    id: number;
    success: boolean;
    researchQueueScore: number;
    researchQueueBreakdown: ResearchQueueBreakdown;
    decision?: string;
    priorityScore?: number | null;
    error?: string;
  }> = [];

  for (const entry of ranked) {
    const id = entry.candidate.id;
    try {
      const processed = await processLeadResearch(prisma, id);
      results.push({
        id,
        success: true,
        researchQueueScore: entry.score.total,
        researchQueueBreakdown: entry.score,
        decision: processed.result.decision,
        priorityScore: processed.priorityScore,
      });
    } catch (error) {
      results.push({
        id,
        success: false,
        researchQueueScore: entry.score.total,
        researchQueueBreakdown: entry.score,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
