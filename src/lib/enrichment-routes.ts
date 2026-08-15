import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { enrichLeadFromSite } from "./enrichment.js";

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [86_400_000, 7 * 86_400_000];

function retryState(attempts: number) {
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    return { emailEnrichmentStatus: "exhausted", nextEmailEnrichmentAt: null, emailEnrichmentReason: "fetch_failed_max_attempts" };
  }
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 7 * 86_400_000;
  return { emailEnrichmentStatus: "retry", nextEmailEnrichmentAt: new Date(Date.now() + delay), emailEnrichmentReason: "site_fetch_failed" };
}

export async function enrichLeadEmail(prisma: PrismaClient, leadId: number) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error("Lead not found");
  if (lead.email) {
    if (lead.emailEnrichmentStatus !== "found") {
      await prisma.lead.update({ where: { id: leadId }, data: { emailEnrichmentStatus: "found", nextEmailEnrichmentAt: null, emailEnrichmentReason: "email_present" } });
    }
    return { leadId, email: lead.email, found: true, alreadyPresent: true, status: "found" };
  }

  const attempts = lead.emailEnrichmentAttempts + 1;
  const attemptedAt = new Date();

  try {
    const enrichment = await enrichLeadFromSite({ url: lead.landingPageUrl, existingBusinessName: lead.businessName ?? undefined });
    const email = enrichment.email?.toLowerCase() ?? null;
    const state = email
      ? { emailEnrichmentStatus: "found", nextEmailEnrichmentAt: null, emailEnrichmentReason: "email_discovered" }
      : enrichment.enrichmentStatus === "failed"
        ? retryState(attempts)
        : { emailEnrichmentStatus: "exhausted", nextEmailEnrichmentAt: null, emailEnrichmentReason: "search_exhausted" };

    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          email: email ?? undefined,
          phone: enrichment.phone ?? undefined,
          contactPageUrl: enrichment.contactPageUrl ?? undefined,
          businessName: enrichment.businessName ?? undefined,
          enrichmentStatus: enrichment.enrichmentStatus,
          enrichmentNotes: enrichment.enrichmentNotes,
          emailEnrichmentStatus: state.emailEnrichmentStatus,
          emailEnrichmentAttempts: attempts,
          lastEmailEnrichmentAt: attemptedAt,
          nextEmailEnrichmentAt: state.nextEmailEnrichmentAt,
          emailEnrichmentReason: state.emailEnrichmentReason,
          isAgencyManaged: enrichment.isAgencyManaged ?? undefined,
          agencyName: enrichment.agencyName ?? undefined,
          isNationalChain: enrichment.isNationalChain ?? undefined,
          chainReason: enrichment.chainReason ?? undefined,
        },
      });
      if (email) {
        await tx.contact.upsert({
          where: { leadId_type_value: { leadId, type: "email", value: email } },
          update: { isPrimary: true, source: "email_enrichment", verificationStatus: "discovered" },
          create: { leadId, type: "email", value: email, isPrimary: true, source: "email_enrichment", verificationStatus: "discovered" },
        });
      }
      if (enrichment.phone) {
        await tx.contact.upsert({
          where: { leadId_type_value: { leadId, type: "phone", value: enrichment.phone } },
          update: { isPrimary: true, source: "email_enrichment" },
          create: { leadId, type: "phone", value: enrichment.phone, isPrimary: true, source: "email_enrichment" },
        });
      }
      await tx.activity.create({
        data: {
          leadId,
          type: email ? "email_enriched" : state.emailEnrichmentStatus === "retry" ? "email_enrichment_retry_scheduled" : "email_enrichment_exhausted",
          summary: email
            ? `Email discovered before AI research: ${email}`
            : state.emailEnrichmentStatus === "retry"
              ? `Email enrichment fetch failed; retry ${attempts + 1} scheduled`
              : "Email enrichment exhausted with no usable address",
          metadata: { email, attempts, status: state.emailEnrichmentStatus, reason: state.emailEnrichmentReason, nextRetryAt: state.nextEmailEnrichmentAt?.toISOString() ?? null, contactPageUrl: enrichment.contactPageUrl ?? null },
        },
      });
    });
    return { leadId, email, found: Boolean(email), alreadyPresent: false, status: state.emailEnrichmentStatus, attempts, nextRetryAt: state.nextEmailEnrichmentAt };
  } catch (error) {
    const state = retryState(attempts);
    const text = error instanceof Error ? error.message : String(error);
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { emailEnrichmentStatus: state.emailEnrichmentStatus, emailEnrichmentAttempts: attempts, lastEmailEnrichmentAt: attemptedAt, nextEmailEnrichmentAt: state.nextEmailEnrichmentAt, emailEnrichmentReason: text } });
      await tx.activity.create({ data: { leadId, type: state.emailEnrichmentStatus === "retry" ? "email_enrichment_retry_scheduled" : "email_enrichment_exhausted", summary: state.emailEnrichmentStatus === "retry" ? `Email enrichment errored; retry ${attempts + 1} scheduled` : "Email enrichment exhausted after repeated errors", metadata: { attempts, error: text, nextRetryAt: state.nextEmailEnrichmentAt?.toISOString() ?? null } } });
    });
    throw error;
  }
}

export async function enrichMissingEmails(prisma: PrismaClient, limit = 25) {
  const now = new Date();
  const leads = await prisma.lead.findMany({
    where: {
      email: null,
      status: { in: ["new", "research_pending", "qualified"] },
      OR: [
        { emailEnrichmentStatus: "pending" },
        { emailEnrichmentStatus: "retry", nextEmailEnrichmentAt: { lte: now } },
      ],
    },
    orderBy: [{ nextEmailEnrichmentAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });
  const results: Array<{ leadId: number; email?: string | null; found: boolean; alreadyPresent?: boolean; status?: string; attempts?: number; nextRetryAt?: Date | null; error?: string }> = [];
  for (const lead of leads) {
    try { results.push(await enrichLeadEmail(prisma, lead.id)); }
    catch (error) { results.push({ leadId: lead.id, found: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export function registerEnrichmentRoutes(app: Express, prisma: PrismaClient) {
  app.post("/api/leads/:id/enrich-email", async (req, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    try { res.json(await enrichLeadEmail(prisma, id)); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/leads/enrich-missing-emails", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.body?.limit ?? 25), 1), 100);
    try {
      const results = await enrichMissingEmails(prisma, limit);
      res.json({ processed: results.length, found: results.filter((r) => r.found).length, retryScheduled: results.filter((r) => r.status === "retry").length, exhausted: results.filter((r) => r.status === "exhausted").length, failed: results.filter((r) => r.error).length, results });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
