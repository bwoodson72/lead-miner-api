import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { type LeadRecord } from "./schemas.js";

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  });
  return new PrismaClient({ adapter });
}

const prisma = createPrismaClient();

export type UpsertResult = {
  domain: string;
  action: "created" | "updated" | "failed";
  id?: number;
  error?: string;
};

export async function upsertLead(lead: LeadRecord): Promise<UpsertResult> {
  try {
    const result = await prisma.lead.upsert({
      where: { domain: lead.domain },
      create: {
        domain: lead.domain,
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
      },
      update: {
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
      },
    });

    const isNew = result.createdAt.getTime() === result.updatedAt.getTime();
    const action = isNew ? "created" : "updated";

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
  for (const lead of leads) {
    const result = await upsertLead(lead);
    results.push(result);
  }
  return results;
}
