import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { enrichLeadFromSite } from "./enrichment.js";
import { acquireAutomationLease, acquireAutomationSlot, releaseAutomationLease } from "./automation-lock.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [86_400_000, 7 * 86_400_000];
const ENRICHMENT_CONTACT_SOURCES = ["enrichment", "email_enrichment"];

type EnrichLeadEmailOptions = { forceRevalidate?: boolean };

function retryState(attempts: number) {
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    return { emailEnrichmentStatus: "exhausted", nextEmailEnrichmentAt: null, emailEnrichmentReason: "fetch_failed_max_attempts" };
  }
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 7 * 86_400_000;
  return { emailEnrichmentStatus: "retry", nextEmailEnrichmentAt: new Date(Date.now() + delay), emailEnrichmentReason: "site_fetch_failed" };
}

export async function enrichLeadEmail(prisma: PrismaClient, leadId: number, options: EnrichLeadEmailOptions = {}) {
  const leadLease = await acquireAutomationLease(prisma, `email-enrichment-lead:${leadId}`, 3 * 60_000);
  if (!leadLease) throw new Error("Email enrichment is already running for this lead");
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new Error("Lead not found");
    const currentEmail = lead.email?.toLowerCase() ?? null;

    if (currentEmail && !options.forceRevalidate) {
      if (lead.emailEnrichmentStatus !== "found") {
        await prisma.lead.update({ where: { id: leadId }, data: { emailEnrichmentStatus: "found", nextEmailEnrichmentAt: null, emailEnrichmentReason: "email_present" } });
      }
      return { leadId, email: currentEmail, found: true, alreadyPresent: true, status: "found" };
    }

    if (currentEmail && options.forceRevalidate) {
      const enrichmentOwnedContact = await prisma.contact.findFirst({
        where: { leadId, type: "email", value: currentEmail, source: { in: ENRICHMENT_CONTACT_SOURCES } },
        select: { id: true },
      });
      if (!enrichmentOwnedContact) {
        return { leadId, email: currentEmail, found: true, alreadyPresent: true, protected: true, status: "found", reason: "Existing email is not enrichment-sourced" };
      }
    }

    const attempts = lead.emailEnrichmentAttempts + 1;
    const attemptedAt = new Date();
    const slot = await acquireAutomationSlot(prisma, "email-enrichment", SAFETY_LIMITS.emailEnrichmentConcurrency, 3 * 60_000);
    if (!slot) throw new Error(`Email enrichment concurrency limit reached (${SAFETY_LIMITS.emailEnrichmentConcurrency})`);

    try {
      const enrichment = await enrichLeadFromSite({
        url: lead.landingPageUrl,
        existingBusinessName: lead.businessName ?? undefined,
        existingPhone: lead.phone ?? undefined,
        existingAddress: lead.address ?? undefined,
      });
      const email = enrichment.email?.toLowerCase() ?? null;
      const identityChanged = Boolean(options.forceRevalidate && currentEmail && currentEmail !== email);
      const state = email
        ? { emailEnrichmentStatus: "found", nextEmailEnrichmentAt: null, emailEnrichmentReason: options.forceRevalidate ? "email_identity_revalidated" : "email_discovered" }
        : enrichment.enrichmentStatus === "failed"
          ? retryState(attempts)
          : { emailEnrichmentStatus: "exhausted", nextEmailEnrichmentAt: null, emailEnrichmentReason: options.forceRevalidate && currentEmail ? "email_identity_rejected" : "search_exhausted" };

      await prisma.$transaction(async (tx) => {
        await tx.lead.update({
          where: { id: leadId },
          data: {
            email: options.forceRevalidate ? email : email ?? undefined,
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

        if (identityChanged && currentEmail) {
          await tx.contact.updateMany({
            where: { leadId, type: "email", value: currentEmail, source: { in: ENRICHMENT_CONTACT_SOURCES } },
            data: { isPrimary: false, verificationStatus: "rejected_identity_mismatch" },
          });
          await tx.outreachMessage.updateMany({
            where: { leadId, status: { in: ["draft", "approved"] } },
            data: { status: "cancelled" },
          });
        }

        if (email) {
          await tx.contact.upsert({
            where: { leadId_type_value: { leadId, type: "email", value: email } },
            update: { isPrimary: true, source: "email_enrichment", verificationStatus: options.forceRevalidate ? "identity_verified" : "discovered" },
            create: { leadId, type: "email", value: email, isPrimary: true, source: "email_enrichment", verificationStatus: options.forceRevalidate ? "identity_verified" : "discovered" },
          });
        }
        if (enrichment.phone) {
          await tx.contact.upsert({
            where: { leadId_type_value: { leadId, type: "phone", value: enrichment.phone } },
            update: { isPrimary: true, source: "email_enrichment" },
            create: { leadId, type: "phone", value: enrichment.phone, isPrimary: true, source: "email_enrichment" },
          });
        }

        const activityType = identityChanged
          ? email ? "email_identity_replaced" : "email_identity_invalidated"
          : email ? options.forceRevalidate ? "email_identity_revalidated" : "email_enriched"
          : state.emailEnrichmentStatus === "retry" ? "email_enrichment_retry_scheduled" : "email_enrichment_exhausted";
        const summary = identityChanged
          ? email ? `Enriched email replaced after identity revalidation: ${email}` : "Enriched email removed after identity revalidation failed"
          : email
            ? options.forceRevalidate ? `Enriched email identity revalidated: ${email}` : `Email discovered before AI research: ${email}`
            : state.emailEnrichmentStatus === "retry"
              ? `Email enrichment fetch failed; retry ${attempts + 1} scheduled`
              : "Email enrichment exhausted with no identity-verified usable address";
        await tx.activity.create({
          data: {
            leadId,
            type: activityType,
            summary,
            metadata: { previousEmail: identityChanged ? currentEmail : null, email, attempts, status: state.emailEnrichmentStatus, reason: state.emailEnrichmentReason, nextRetryAt: state.nextEmailEnrichmentAt?.toISOString() ?? null, contactPageUrl: enrichment.contactPageUrl ?? null, forceRevalidate: Boolean(options.forceRevalidate) },
          },
        });
      });
      return { leadId, email, found: Boolean(email), alreadyPresent: false, revalidated: Boolean(options.forceRevalidate), identityChanged, status: state.emailEnrichmentStatus, attempts, nextRetryAt: state.nextEmailEnrichmentAt };
    } catch (error) {
      const state = retryState(attempts);
      const text = error instanceof Error ? error.message : String(error);
      await prisma.$transaction(async (tx) => {
        await tx.lead.update({ where: { id: leadId }, data: { emailEnrichmentStatus: state.emailEnrichmentStatus, emailEnrichmentAttempts: attempts, lastEmailEnrichmentAt: attemptedAt, nextEmailEnrichmentAt: state.nextEmailEnrichmentAt, emailEnrichmentReason: text } });
        await tx.activity.create({ data: { leadId, type: state.emailEnrichmentStatus === "retry" ? "email_enrichment_retry_scheduled" : "email_enrichment_exhausted", summary: state.emailEnrichmentStatus === "retry" ? `Email enrichment errored; retry ${attempts + 1} scheduled` : "Email enrichment exhausted after repeated errors", metadata: { attempts, error: text, nextRetryAt: state.nextEmailEnrichmentAt?.toISOString() ?? null, forceRevalidate: Boolean(options.forceRevalidate) } } });
      });
      throw error;
    } finally {
      await releaseAutomationLease(prisma, slot);
    }
  } finally {
    await releaseAutomationLease(prisma, leadLease);
  }
}

export async function enrichMissingEmails(prisma: PrismaClient, limit = 25) {
  const safeLimit = capRequestedLimit(limit, 25, SAFETY_LIMITS.bulkEnrichmentMax);
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
    take: safeLimit,
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
    const forceRevalidate = req.query["force"] === "true" || req.query["force"] === "1";
    try { res.json(await enrichLeadEmail(prisma, id, { forceRevalidate })); }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      res.status(text.includes("concurrency limit") || text.includes("already running") ? 409 : 500).json({ error: text });
    }
  });

  app.post("/api/leads/enrich-missing-emails", async (req, res) => {
    const requested = Number(req.body?.limit ?? 25);
    if (Number.isFinite(requested) && requested > SAFETY_LIMITS.bulkEnrichmentMax) { res.status(400).json({ error: `Bulk email enrichment is capped at ${SAFETY_LIMITS.bulkEnrichmentMax} leads per request` }); return; }
    const limit = capRequestedLimit(requested, 25, SAFETY_LIMITS.bulkEnrichmentMax);
    try {
      const results = await enrichMissingEmails(prisma, limit);
      res.json({ processed: results.length, cap: SAFETY_LIMITS.bulkEnrichmentMax, found: results.filter((r) => r.found).length, retryScheduled: results.filter((r) => r.status === "retry").length, exhausted: results.filter((r) => r.status === "exhausted").length, failed: results.filter((r) => r.error).length, results });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
