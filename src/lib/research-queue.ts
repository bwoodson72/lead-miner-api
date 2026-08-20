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
  id?: number;
  adSource: string;
  performanceOpportunity: string;
  screeningStatus: string;
  businessName: string | null;
  phone: string | null;
  address: string | null;
  createdAt: Date;
};

export function isResearchQueueEligible(lead: {
  status: string;
  lastResearchedAt: Date | null;
  screeningStatus: string;
}) {
  return ["new", "research_pending"].includes(lead.status)
    && lead.lastResearchedAt === null
    && ["complete", "partial", "failed"].includes(lead.screeningStatus);
}

export function researchQueueWhere() {
  return {
    status: { in: ["new", "research_pending"] },
    lastResearchedAt: null,
    screeningStatus: { in: ["complete", "partial", "failed"] },
    aiJobs: { none: { type: "lead_research", status: { in: ["running", "complete"] } } },
  } as const;
}

function acquisitionIntentScore(adSource: string) {
  if (adSource === "paid_ad") return 30;
  if (adSource === "local_organic") return 15;
  return 0;
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
  const ageMs = Math.max(0, now.getTime() - candidate.createdAt.getTime());
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

export function rankResearchCandidates<T extends ResearchQueueCandidate>(
  candidates: T[],
  now = new Date(),
) {
  return candidates
    .map((candidate) => ({ candidate, score: calculateResearchQueueScore(candidate, now) }))
    .sort((a, b) => {
      if (b.score.total !== a.score.total) return b.score.total - a.score.total;
      const createdDelta = a.candidate.createdAt.getTime() - b.candidate.createdAt.getTime();
      if (createdDelta !== 0) return createdDelta;
      return (a.candidate.id ?? 0) - (b.candidate.id ?? 0);
    });
}
