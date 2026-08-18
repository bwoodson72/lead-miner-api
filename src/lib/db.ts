import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { type LeadRecord } from "./schemas.js";

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();
export { prisma };

export function normalizeDomainValue(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!.replace(/\.$/, "");
}

export type UpsertResult = {
  domain: string;
  action: "created" | "updated" | "failed";
  id?: number;
  error?: string;
};

function initialEmailEnrichmentState(lead: LeadRecord) {
  if (lead.email) return { emailEnrichmentStatus: "found", emailEnrichmentAttempts: 1, lastEmailEnrichmentAt: new Date(), nextEmailEnrichmentAt: null, emailEnrichmentReason: "email_discovered" };
  if (lead.enrichmentStatus === "failed") return { emailEnrichmentStatus: "retry", emailEnrichmentAttempts: 1, lastEmailEnrichmentAt: new Date(), nextEmailEnrichmentAt: new Date(Date.now() + 86_400_000), emailEnrichmentReason: "site_fetch_failed" };
  return { emailEnrichmentStatus: "exhausted", emailEnrichmentAttempts: 1, lastEmailEnrichmentAt: new Date(), nextEmailEnrichmentAt: null, emailEnrichmentReason: "search_exhausted" };
}

export async function upsertLead(lead: LeadRecord): Promise<UpsertResult> {
  try {
    const normalizedDomain = normalizeDomainValue(lead.domain);
    const existing = await prisma.lead.findFirst({
      where: { OR: [{ domain: lead.domain }, { normalizedDomain }] },
      select: { id: true, email: true },
    });
    const emailState = initialEmailEnrichmentState(lead);

    const result = await prisma.$transaction(async (tx) => {
      const data = {
        normalizedDomain,
        keyword: lead.keyword,
        adSource: lead.adSource,
        lighthouseScore: lead.performanceScore,
        lcp: Math.round(lead.lcp),
        cls: lead.cls ?? undefined,
        tbt: lead.tbt ? Math.round(lead.tbt) : undefined,
        landingPageUrl: lead.landingPageUrl,
        businessName: lead.businessName ?? undefined,
        email: lead.email ?? undefined,
        phone: lead.phone ?? undefined,
        address: lead.address ?? undefined,
        contactPageUrl: lead.contactPageUrl ?? undefined,
        enrichmentStatus: lead.enrichmentStatus ?? undefined,
        enrichmentNotes: lead.enrichmentNotes ?? undefined,
        ...(lead.email || !existing?.email ? emailState : {}),
        isAgencyManaged: lead.isAgencyManaged ?? undefined,
        agencyName: lead.agencyName ?? undefined,
        isNationalChain: lead.isNationalChain ?? undefined,
        chainReason: lead.chainReason ?? undefined,
      };

      const saved = existing
        ? await tx.lead.update({ where: { id: existing.id }, data })
        : await tx.lead.create({ data: {
            domain: lead.domain,
            normalizedDomain,
            businessName: lead.businessName ?? null,
            landingPageUrl: lead.landingPageUrl,
            keyword: lead.keyword,
            adSource: lead.adSource,
            lighthouseScore: lead.performanceScore,
            lcp: Math.round(lead.lcp),
            cls: lead.cls ?? null,
            tbt: lead.tbt ? Math.round(lead.tbt) : null,
            email: lead.email ?? null,
            phone: lead.phone ?? null,
            address: lead.address ?? null,
            contactPageUrl: lead.contactPageUrl ?? null,
            enrichmentStatus: lead.enrichmentStatus ?? null,
            enrichmentNotes: lead.enrichmentNotes ?? null,
            ...emailState,
            isAgencyManaged: lead.isAgencyManaged ?? false,
            agencyName: lead.agencyName ?? null,
            isNationalChain: lead.isNationalChain ?? false,
            chainReason: lead.chainReason ?? null,
            status: "research_pending",
          } });

      if (lead.email) {
        const source = lead.emailSource === "discovery" ? "discovery" : "enrichment";
        await tx.contact.upsert({
          where: { leadId_type_value: { leadId: saved.id, type: "email", value: lead.email.toLowerCase() } },
          update: { isPrimary: true, source, verificationStatus: "discovered" },
          create: { leadId: saved.id, type: "email", value: lead.email.toLowerCase(), isPrimary: true, source, verificationStatus: "discovered" },
        });
      }
      if (lead.phone) {
        const source = lead.phoneSource === "discovery" ? "discovery" : "enrichment";
        await tx.contact.upsert({
          where: { leadId_type_value: { leadId: saved.id, type: "phone", value: lead.phone } },
          update: { isPrimary: true, source },
          create: { leadId: saved.id, type: "phone", value: lead.phone, isPrimary: true, source },
        });
      }
      return saved;
    });

    const action = existing ? "updated" : "created";
    console.log(`[DB] ${action} lead ${result.id} for ${lead.domain}`);
    return { domain: lead.domain, action, id: result.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DB] Failed to upsert ${lead.domain}:`, message);
    return { domain: lead.domain, action: "failed", error: message };
  }
}

export async function upsertLeads(leads: LeadRecord[]): Promise<UpsertResult[]> {
  const results: UpsertResult[] = [];
  for (const lead of leads) results.push(await upsertLead(lead));
  return results;
}
