import type { PrismaClient } from "../generated/prisma/client.js";
import { enrichLeadEmail } from "./enrichment-routes.js";

export type ResearchPreparationStatus =
  | "ready"
  | "email_found"
  | "exhausted"
  | "deferred"
  | "failed"
  | "missing";

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

type EnrichLeadEmailFn = typeof enrichLeadEmail;

export class ResearchPreparationError extends Error {
  constructor(public readonly preparation: ResearchPreparationResult) {
    super(preparation.reason ?? `Lead is not research-ready (${preparation.status})`);
    this.name = "ResearchPreparationError";
  }
}

/**
 * Ensures contact discovery has had an eligible chance to run before AI research.
 * Background/automatic work respects exhausted and future retry states. A manual
 * research action may explicitly force one enrichment pass now.
 */
export async function prepareLeadForResearch(
  prisma: PrismaClient,
  leadId: number,
  enrich: EnrichLeadEmailFn = enrichLeadEmail,
  now = new Date(),
  forceEmailEnrichment = false,
): Promise<ResearchPreparationResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      email: true,
      enrichmentNotes: true,
      emailEnrichmentStatus: true,
      emailEnrichmentReason: true,
      nextEmailEnrichmentAt: true,
    },
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

  if (lead.email) {
    return {
      leadId,
      ready: true,
      status: "ready",
      email: lead.email,
      alreadyHadEmail: true,
      enrichmentAttempted: false,
    };
  }

  if (!forceEmailEnrichment && lead.emailEnrichmentStatus === "exhausted") {
    return {
      leadId,
      ready: false,
      status: "exhausted",
      email: null,
      alreadyHadEmail: false,
      enrichmentAttempted: false,
      reason: lead.emailEnrichmentReason,
      enrichmentNotes: lead.enrichmentNotes,
    };
  }

  if (
    !forceEmailEnrichment &&
    lead.emailEnrichmentStatus === "retry" &&
    lead.nextEmailEnrichmentAt &&
    lead.nextEmailEnrichmentAt > now
  ) {
    return {
      leadId,
      ready: false,
      status: "deferred",
      email: null,
      alreadyHadEmail: false,
      enrichmentAttempted: false,
      reason: lead.emailEnrichmentReason,
      enrichmentNotes: lead.enrichmentNotes,
      nextRetryAt: lead.nextEmailEnrichmentAt,
    };
  }

  if (!forceEmailEnrichment && lead.emailEnrichmentStatus === "found") {
    return {
      leadId,
      ready: false,
      status: "failed",
      email: null,
      alreadyHadEmail: false,
      enrichmentAttempted: false,
      reason: "Email enrichment is marked found but the lead has no email address",
      enrichmentNotes: lead.enrichmentNotes,
    };
  }

  try {
    const result = await enrich(prisma, leadId);
    if (result.found && result.email) {
      return {
        leadId,
        ready: true,
        status: "email_found",
        email: result.email,
        alreadyHadEmail: false,
        enrichmentAttempted: true,
        enrichmentNotes: result.enrichmentNotes ?? null,
      };
    }

    if (result.status === "exhausted") {
      return {
        leadId,
        ready: false,
        status: "exhausted",
        email: null,
        alreadyHadEmail: false,
        enrichmentAttempted: true,
        reason: "Email enrichment exhausted with no identity-verified usable address",
        enrichmentNotes: result.enrichmentNotes ?? null,
      };
    }

    return {
      leadId,
      ready: false,
      status: "deferred",
      email: null,
      alreadyHadEmail: false,
      enrichmentAttempted: true,
      reason: "Email enrichment did not produce an address; retry is scheduled",
      enrichmentNotes: result.enrichmentNotes ?? null,
      nextRetryAt: result.nextRetryAt ?? null,
    };
  } catch (error) {
    return {
      leadId,
      ready: false,
      status: "failed",
      email: null,
      alreadyHadEmail: false,
      enrichmentAttempted: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Core research contact gate. Every research path should use this instead of
 * assuming Lead.email was already populated by an outer route or batch worker.
 * Starting research is an explicit request to prepare the lead now, so contact
 * enrichment is forced for no-email leads even if a background retry is deferred
 * or the previous automated pass was exhausted.
 */
export async function getPreparedLeadForResearch(
  prisma: PrismaClient,
  leadId: number,
  enrich: EnrichLeadEmailFn = enrichLeadEmail,
  now = new Date(),
  forceEmailEnrichment = true,
) {
  const preparation = await prepareLeadForResearch(prisma, leadId, enrich, now, forceEmailEnrichment);
  if (!preparation.ready) throw new ResearchPreparationError(preparation);

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    throw new ResearchPreparationError({
      leadId,
      ready: false,
      status: "missing",
      email: null,
      alreadyHadEmail: preparation.alreadyHadEmail,
      enrichmentAttempted: preparation.enrichmentAttempted,
      reason: "Lead not found after contact preparation",
    });
  }

  if (!lead.email) {
    throw new ResearchPreparationError({
      ...preparation,
      ready: false,
      status: "failed",
      email: null,
      reason: "Contact enrichment reported the lead as research-ready, but no email was persisted",
    });
  }

  return { lead, preparation };
}
