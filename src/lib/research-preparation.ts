import type { PrismaClient } from "../generated/prisma/client.js";

export type ResearchPreparationStatus = "ready" | "missing";

export type ResearchPreparationResult = {
  leadId: number;
  ready: boolean;
  status: ResearchPreparationStatus;
  email: string | null;
  alreadyHadEmail: boolean;
  enrichmentAttempted: boolean;
  reason?: string | null;
  enrichmentNotes?: string | null;
  nextRetryAt?: Date | null;
};

export class ResearchPreparationError extends Error {
  constructor(public readonly preparation: ResearchPreparationResult) {
    super(preparation.reason ?? `Lead is not research-ready (${preparation.status})`);
    this.name = "ResearchPreparationError";
  }
}

/**
 * Research preparation is deliberately contact-neutral. A candidate only needs
 * to exist before AI research begins. Contact discovery belongs after website
 * qualification, where it cannot suppress otherwise valuable candidates.
 *
 * Legacy optional arguments remain accepted so older callers cannot accidentally
 * reintroduce email enrichment by passing the previous preparation dependencies.
 */
export async function prepareLeadForResearch(
  prisma: PrismaClient,
  leadId: number,
  _legacyEnrich?: unknown,
  _now = new Date(),
  _legacyForceEmailEnrichment = false,
): Promise<ResearchPreparationResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, email: true, enrichmentNotes: true },
  });

  if (!lead) {
    return {
      leadId,
      ready: false,
      status: "missing",
      email: null,
      alreadyHadEmail: false,
      enrichmentAttempted: false,
      reason: "Lead not found",
    };
  }

  return {
    leadId,
    ready: true,
    status: "ready",
    email: lead.email,
    alreadyHadEmail: Boolean(lead.email),
    enrichmentAttempted: false,
    enrichmentNotes: lead.enrichmentNotes,
  };
}

export async function getPreparedLeadForResearch(
  prisma: PrismaClient,
  leadId: number,
  legacyEnrich?: unknown,
  now = new Date(),
  legacyForceEmailEnrichment = false,
) {
  const preparation = await prepareLeadForResearch(
    prisma,
    leadId,
    legacyEnrich,
    now,
    legacyForceEmailEnrichment,
  );
  if (!preparation.ready) throw new ResearchPreparationError(preparation);

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    throw new ResearchPreparationError({
      leadId,
      ready: false,
      status: "missing",
      email: null,
      alreadyHadEmail: preparation.alreadyHadEmail,
      enrichmentAttempted: false,
      reason: "Lead not found after research preparation",
    });
  }

  return { lead, preparation };
}
