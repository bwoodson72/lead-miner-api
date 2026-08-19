import type { PrismaClient } from "../generated/prisma/client.js";

export type ResearchQueueBreakdown = {
  acquisitionIntent: number;
  performanceSignal: number;
  screeningCompleteness: number;
  listingIdentity: number;
  aging: number;
  ageDays: number;
  total: number;
};

export type ResearchQueueCandidate = {
  adSource: string;
  performanceOpportunity: string;
  screeningStatus: string;
  businessName: string | null;
  phone: string | null;
  address: string | null;
  createdAt: Date;
  researchQueuedAt?: Date | null;
};

function acquisitionIntentScore(adSource: string) {
  return adSource === "paid_ad" ? 30 : 15;
}

function performanceSignalScore(performanceOpportunity: string) {
  if (performanceOpportunity === "strong") return 20;
  if (performanceOpportunity === "moderate") return 10;
  if (performanceOpportunity === "unknown") return 5;
  return 0;
}

function screeningCompletenessScore(screeningStatus: string) {
  if (screeningStatus === "complete") return 10;
  if (screeningStatus === "partial") return 5;
  if (screeningStatus === "failed") return 3;
  return 0;
}

function listingIdentityScore(candidate: ResearchQueueCandidate) {
  return (candidate.businessName ? 5 : 0)
    + (candidate.phone ? 5 : 0)
    + (candidate.address ? 5 : 0);
}

export function calculateResearchQueueScore(
  candidate: ResearchQueueCandidate,
  now = new Date(),
): ResearchQueueBreakdown {
  const queuedAt = candidate.researchQueuedAt ?? candidate.createdAt;
  const ageMs = Math.max(0, now.getTime() - queuedAt.getTime());
  const ageDays = Math.floor(ageMs / 86_400_000);
  const aging = Math.min(20, ageDays);
  const acquisitionIntent = acquisitionIntentScore(candidate.adSource);
  const performanceSignal = performanceSignalScore(candidate.performanceOpportunity);
  const screeningCompleteness = screeningCompletenessScore(candidate.screeningStatus);
  const listingIdentity = listingIdentityScore(candidate);
  const total = Math.min(100, acquisitionIntent + performanceSignal + screeningCompleteness + listingIdentity + aging);

  return {
    acquisitionIntent,
    performanceSignal,
    screeningCompleteness,
    listingIdentity,
    aging,
    ageDays,
    total,
  };
}

export async function refreshResearchQueueScores(
  prisma: PrismaClient,
  options: { leadIds?: number[]; now?: Date; limit?: number } = {},
) {
  const now = options.now ?? new Date();
  const leadIds = options.leadIds?.length ? Array.from(new Set(options.leadIds)) : null;
  const leads = await prisma.lead.findMany({
    where: {
      ...(leadIds ? { id: { in: leadIds } } : {}),
      status: { in: ["new", "research_pending"] },
      lastResearchedAt: null,
      screeningStatus: { in: ["complete", "partial", "failed"] },
      aiJobs: { none: { type: "lead_research", status: { in: ["running", "complete"] } } },
    },
    orderBy: { researchQueuedAt: "asc" },
    take: options.limit ?? 2000,
    select: {
      id: true,
      adSource: true,
      performanceOpportunity: true,
      screeningStatus: true,
      businessName: true,
      phone: true,
      address: true,
      createdAt: true,
      researchQueuedAt: true,
    },
  });

  const results: Array<{ leadId: number; score: number; breakdown: ResearchQueueBreakdown }> = [];
  for (const lead of leads) {
    const breakdown = calculateResearchQueueScore(lead, now);
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        researchQueueScore: breakdown.total,
        researchQueueBreakdown: breakdown,
        researchQueueScoredAt: now,
      },
    });
    results.push({ leadId: lead.id, score: breakdown.total, breakdown });
  }
  return results;
}
