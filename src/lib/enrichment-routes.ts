import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { enrichLeadFromSite } from "./enrichment.js";

async function enrichLeadEmail(prisma: PrismaClient, leadId: number) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error("Lead not found");
  if (lead.email) return { leadId, email: lead.email, found: true, alreadyPresent: true };

  const enrichment = await enrichLeadFromSite({ url: lead.landingPageUrl, existingBusinessName: lead.businessName ?? undefined });
  const email = enrichment.email?.toLowerCase() ?? null;
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
        type: email ? "email_enriched" : "email_enrichment_failed",
        summary: email ? `Email discovered before AI research: ${email}` : "No usable email found during contact enrichment",
        metadata: { email, contactPageUrl: enrichment.contactPageUrl ?? null },
      },
    });
  });
  return { leadId, email, found: Boolean(email), alreadyPresent: false };
}

export async function enrichMissingEmails(prisma: PrismaClient, limit = 25) {
  const leads = await prisma.lead.findMany({
    where: { email: null, status: { in: ["new", "research_pending", "qualified"] } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const results: Array<{ leadId: number; email?: string | null; found: boolean; alreadyPresent?: boolean; error?: string }> = [];
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
      res.json({ processed: results.length, found: results.filter((r) => r.found).length, missing: results.filter((r) => !r.found && !r.error).length, failed: results.filter((r) => r.error).length, results });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
