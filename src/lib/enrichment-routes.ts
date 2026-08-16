import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { enrichLeadFromSite } from "./enrichment.js";
import { normalizePhone } from "./enrichment-identity.js";
import { acquireAutomationLease, acquireAutomationSlot, releaseAutomationLease } from "./automation-lock.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [86_400_000, 7 * 86_400_000];
const ENRICHMENT_CONTACT_SOURCES = ["enrichment", "email_enrichment", "discovery_revalidation"];

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
    const currentPhone = normalizePhone(lead.phone ?? undefined) ?? null;

    if (currentEmail && !options.forceRevalidate) {
      if (lead.emailEnrichmentStatus !== "found") {
        await prisma.lead.update({ where: { id: leadId }, data: { emailEnrichmentStatus: "found", nextEmailEnrichmentAt: null, emailEnrichmentReason: "email_present" } });
      }
      return { leadId, email: currentEmail, phone: currentPhone, found: true, alreadyPresent: true, status: "found" };
    }

    let enrichmentOwnedEmail = false;
    let enrichmentOwnedPhone = false;
    if (options.forceRevalidate) {
      if (currentEmail) {
        enrichmentOwnedEmail = Boolean(await prisma.contact.findFirst({
          where: { leadId, type: "email", value: currentEmail, source: { in: ENRICHMENT_CONTACT_SOURCES } },
          select: { id: true },
        }));
      }
      if (lead.phone) {
        enrichmentOwnedPhone = Boolean(await prisma.contact.findFirst({
          where: { leadId, type: "phone", value: lead.phone, source: { in: ENRICHMENT_CONTACT_SOURCES } },
          select: { id: true },
        }));
      }
      if (currentEmail && !enrichmentOwnedEmail && !enrichmentOwnedPhone) {
        return { leadId, email: currentEmail, phone: currentPhone, found: true, alreadyPresent: true, protected: true, status: "found", reason: "Existing contacts are not enrichment-sourced" };
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
        revalidateExistingPhone: Boolean(options.forceRevalidate && enrichmentOwnedPhone),
      });
      const discoveredEmail = enrichment.email?.toLowerCase() ?? null;
      const emailProtected = Boolean(options.forceRevalidate && currentEmail && !enrichmentOwnedEmail);
      const email = emailProtected ? currentEmail : discoveredEmail;
      const revalidatedPhone = normalizePhone(enrichment.phone);
      const emailIdentityChanged = Boolean(options.forceRevalidate && enrichmentOwnedEmail && currentEmail && currentEmail !== discoveredEmail);
      const phoneIdentityChanged = Boolean(options.forceRevalidate && enrichmentOwnedPhone && currentPhone && revalidatedPhone && currentPhone !== revalidatedPhone);
      const phoneRevalidated = Boolean(options.forceRevalidate && enrichmentOwnedPhone && revalidatedPhone);
      const state = emailProtected
        ? { emailEnrichmentStatus: "found", nextEmailEnrichmentAt: null, emailEnrichmentReason: "email_protected_non_enrichment" }
        : email
          ? { emailEnrichmentStatus: "found", nextEmailEnrichmentAt: null, emailEnrichmentReason: options.forceRevalidate ? "email_identity_revalidated" : "email_discovered" }
          : enrichment.enrichmentStatus === "failed"
            ? retryState(attempts)
            : { emailEnrichmentStatus: "exhausted", nextEmailEnrichmentAt: null, emailEnrichmentReason: options.forceRevalidate && currentEmail && enrichmentOwnedEmail ? "email_identity_rejected" : "search_exhausted" };

      await prisma.$transaction(async (tx) => {
        await tx.lead.update({
          where: { id: leadId },
          data: {
            email: emailProtected ? undefined : options.forceRevalidate && enrichmentOwnedEmail ? discoveredEmail : discoveredEmail ?? undefined,
            phone: revalidatedPhone ?? enrichment.phone ?? undefined,
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

        if (emailIdentityChanged && currentEmail) {
          await tx.contact.updateMany({
            where: { leadId, type: "email", value: currentEmail, source: { in: ENRICHMENT_CONTACT_SOURCES } },
            data: { isPrimary: false, verificationStatus: "rejected_identity_mismatch" },
          });
          await tx.outreachMessage.updateMany({
            where: { leadId, status: { in: ["draft", "approved"] } },
            data: { status: "cancelled" },
          });
        }

        if (phoneIdentityChanged && lead.phone) {
          await tx.contact.updateMany({
            where: { leadId, type: "phone", value: lead.phone, source: { in: ENRICHMENT_CONTACT_SOURCES } },
            data: { isPrimary: false, verificationStatus: "rejected_identity_mismatch" },
          });
        }

        if (discoveredEmail && !emailProtected) {
          await tx.contact.upsert({
            where: { leadId_type_value: { leadId, type: "email", value: discoveredEmail } },
            update: { isPrimary: true, source: "email_enrichment", verificationStatus: options.forceRevalidate ? "identity_verified" : "discovered" },
            create: { leadId, type: "email", value: discoveredEmail, isPrimary: true, source: "email_enrichment", verificationStatus: options.forceRevalidate ? "identity_verified" : "discovered" },
          });
        }
        if (revalidatedPhone) {
          await tx.contact.upsert({
            where: { leadId_type_value: { leadId, type: "phone", value: revalidatedPhone } },
            update: { isPrimary: true, source: phoneRevalidated ? "discovery_revalidation" : "email_enrichment", verificationStatus: phoneRevalidated ? "identity_verified" : undefined },
            create: { leadId, type: "phone", value: revalidatedPhone, isPrimary: true, source: phoneRevalidated ? "discovery_revalidation" : "email_enrichment", verificationStatus: phoneRevalidated ? "identity_verified" : undefined },
          });
        }

        const activityType = emailProtected
          ? phoneRevalidated ? "contact_identity_revalidated" : "email_identity_protected"
          : emailIdentityChanged
            ? discoveredEmail ? "email_identity_replaced" : "email_identity_invalidated"
            : discoveredEmail ? options.forceRevalidate ? "email_identity_revalidated" : "email_enriched"
            : state.emailEnrichmentStatus === "retry" ? "email_enrichment_retry_scheduled" : "email_enrichment_exhausted";
        const summary = emailProtected
          ? phoneRevalidated ? "Enrichment-owned phone revalidated; non-enrichment email was protected" : "Non-enrichment email was protected from forced revalidation"
          : emailIdentityChanged
            ? discoveredEmail ? `Enriched email replaced after identity revalidation: ${discoveredEmail}` : "Enriched email removed after identity revalidation failed"
            : discoveredEmail
              ? options.forceRevalidate ? `Enriched email identity revalidated: ${discoveredEmail}` : `Email discovered before AI research: ${discoveredEmail}`
              : state.emailEnrichmentStatus === "retry"
                ? `Email enrichment fetch failed; retry ${attempts + 1} scheduled`
                : "Email enrichment exhausted with no identity-verified usable address";
        await tx.activity.create({
          data: {
            leadId,
            type: activityType,
            summary,
            metadata: { previousEmail: emailIdentityChanged ? currentEmail : null, email, discoveredEmail, emailProtected, previousPhone: phoneIdentityChanged ? currentPhone : null, phone: revalidatedPhone ?? currentPhone, phoneRevalidated, phoneIdentityChanged, attempts, status: state.emailEnrichmentStatus, reason: state.emailEnrichmentReason, nextRetryAt: state.nextEmailEnrichmentAt?.toISOString() ?? null, contactPageUrl: enrichment.contactPageUrl ?? null, forceRevalidate: Boolean(options.forceRevalidate) },
          },
        });
        if (phoneRevalidated) {
          await tx.activity.create({
            data: {
              leadId,
              type: phoneIdentityChanged ? "phone_identity_replaced" : "phone_identity_revalidated",
              summary: phoneIdentityChanged ? `Phone replaced from identity-matched local-business listing: ${revalidatedPhone}` : `Phone revalidated against identity-matched local-business listing: ${revalidatedPhone}`,
              metadata: { previousPhone: phoneIdentityChanged ? currentPhone : null, phone: revalidatedPhone },
            },
          });
        }
      });
      return { leadId, email, discoveredEmail, emailProtected, phone: revalidatedPhone ?? currentPhone, found: Boolean(email), alreadyPresent: false, revalidated: Boolean(options.forceRevalidate), identityChanged: emailIdentityChanged, phoneRevalidated, phoneIdentityChanged, status: state.emailEnrichmentStatus, attempts, nextRetryAt: state.nextEmailEnrichmentAt };
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
