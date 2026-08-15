import { searchAds, type SerpAd } from "./serpapi.js";
import { discoverLocalizedCandidates, resolveLocalizedSearchSpec } from "./localized-discovery.js";
import { normalizeUrl, extractRootDomain } from "./normalize-url.js";
import { analyzeUrlsWithRateLimit, type PageSpeedResult } from "./pagespeed.js";
import { isSlowSite, buildLeadRecord } from "./filters.js";
import { sendReport } from "./email.js";
import { type KeywordInput, type LeadRecord } from "./schemas.js";
import { type Thresholds } from "../config/thresholds.js";
import { isFranchise } from "./franchise-filter.js";
import { upsertLeads, prisma } from "./db.js";
import { enrichLeadFromSite } from "./enrichment.js";
import { processLeadResearch } from "./research-routes.js";
import { getEnv } from "./env.js";

type Diagnostics = {
  keywordsParsed: number; adsFound: number; paidAdsFound: number; organicBusinessesFound: number; uniqueDomains: number;
  paidDomainsQueued: number; organicDomainsQueued: number; franchisesFiltered: number; pageSpeedResults: number; pageSpeedFailures: number;
  slowSites: number; leadsEnriched: number; enrichmentFailures: number; emailsFound: number; phonesFound: number;
  dbCreated: number; dbUpdated: number; dbFailed: number; aiResearched: number; aiResearchFailed: number; draftsGenerated: number;
  emailSent: boolean; messages: string[];
};

export async function runLeadSearchPipeline(input: KeywordInput, onProgress?: (stage: string, detail: string) => void): Promise<{ leads: LeadRecord[]; keywords: string[]; diagnostics: Diagnostics }> {
  const diagnostics: Diagnostics = { keywordsParsed: 0, adsFound: 0, paidAdsFound: 0, organicBusinessesFound: 0, uniqueDomains: 0, paidDomainsQueued: 0, organicDomainsQueued: 0, franchisesFiltered: 0, pageSpeedResults: 0, pageSpeedFailures: 0, slowSites: 0, leadsEnriched: 0, enrichmentFailures: 0, emailsFound: 0, phonesFound: 0, dbCreated: 0, dbUpdated: 0, dbFailed: 0, aiResearched: 0, aiResearchFailed: 0, draftsGenerated: 0, emailSent: false, messages: [] };

  const keywords = input.keywords.split("\n").map((k) => k.trim()).filter(Boolean);
  diagnostics.keywordsParsed = keywords.length;
  const thresholds: Thresholds = { performanceScore: input.performanceScore, lcp: input.lcp, cls: input.cls, tbt: input.tbt };

  onProgress?.("searching", "Discovering paid ads and local businesses...");
  const location = input.location || undefined;
  const allAds = await Promise.all(keywords.map(async (keyword) => {
    const localSpec = resolveLocalizedSearchSpec(keyword, location);
    const results = localSpec ? await discoverLocalizedCandidates(keyword, localSpec, input.maxDomains) : await searchAds(keyword, undefined, input.maxDomains);
    const paidCount = results.filter((result) => result.adSource === "paid_ad").length;
    diagnostics.messages.push(results.length ? `Found ${paidCount} paid ad(s) and ${results.length - paidCount} organic business(es) for keyword "${keyword}"` : `Warning: No businesses found for keyword "${keyword}"`);
    return results;
  }));

  const flatAds = allAds.flat();
  diagnostics.adsFound = flatAds.length;
  diagnostics.paidAdsFound = flatAds.filter((r) => r.adSource === "paid_ad").length;
  diagnostics.organicBusinessesFound = flatAds.length - diagnostics.paidAdsFound;

  type QueueEntry = { url: string; domain: string; keyword: string; adSource: "paid_ad" | "local_organic"; serpAd: SerpAd };
  const byDomain = new Map<string, QueueEntry>();
  for (const ad of flatAds) {
    try {
      const normalizedUrl = normalizeUrl(ad.landingPageUrl);
      const domain = extractRootDomain(normalizedUrl);
      const nextEntry: QueueEntry = { url: normalizedUrl, domain, keyword: ad.keyword, adSource: ad.adSource, serpAd: ad };
      const existing = byDomain.get(domain);
      if (!existing || (nextEntry.adSource === "paid_ad" && existing.adSource === "local_organic")) byDomain.set(domain, nextEntry);
    } catch { diagnostics.messages.push(`Skipping invalid URL: ${ad.landingPageUrl}`); }
  }

  const queue = Array.from(byDomain.values()).sort((a, b) => a.adSource === b.adSource ? 0 : a.adSource === "paid_ad" ? -1 : 1);
  diagnostics.uniqueDomains = queue.length;
  diagnostics.paidDomainsQueued = queue.filter((e) => e.adSource === "paid_ad").length;
  diagnostics.organicDomainsQueued = queue.length - diagnostics.paidDomainsQueued;
  const filteredQueue = queue.filter((entry) => { if (isFranchise(entry.domain)) { diagnostics.franchisesFiltered++; return false; } return true; });

  const total = Math.min(filteredQueue.length, input.maxDomains ?? 20);
  onProgress?.("analyzing", `Running PageSpeed analysis on ${total} domains...`);
  const pageSpeedMap = await analyzeUrlsWithRateLimit(filteredQueue, input.maxDomains ?? 20, 3, (completed, tot) => onProgress?.("analyzing", `${completed} of ${tot} domains analyzed`));
  diagnostics.pageSpeedResults = pageSpeedMap.size;
  diagnostics.pageSpeedFailures = Math.min(filteredQueue.length, input.maxDomains) - pageSpeedMap.size;

  const slowSites: Array<{ entry: QueueEntry; result: PageSpeedResult }> = [];
  for (const entry of filteredQueue.slice(0, input.maxDomains)) {
    const result = pageSpeedMap.get(entry.domain);
    if (result && isSlowSite(result, thresholds)) slowSites.push({ entry, result });
  }
  diagnostics.slowSites = slowSites.length;

  onProgress?.("enriching", `Enriching ${slowSites.length} slow sites...`);
  const leads: LeadRecord[] = [];
  for (let i = 0; i < slowSites.length; i++) {
    const { entry, result } = slowSites[i]!;
    const baseLead = buildLeadRecord({ keyword: entry.keyword, domain: entry.domain, landingPageUrl: entry.url, pageSpeed: result, adSource: entry.adSource, serpAd: entry.serpAd });
    const enrichmentResult = await enrichLeadFromSite({ url: entry.url, existingBusinessName: baseLead.businessName });
    if (enrichmentResult.enrichmentStatus === "enriched") { diagnostics.leadsEnriched++; if (enrichmentResult.email) diagnostics.emailsFound++; if (enrichmentResult.phone) diagnostics.phonesFound++; }
    else if (enrichmentResult.enrichmentStatus === "failed") diagnostics.enrichmentFailures++;
    leads.push({ ...baseLead, ...(enrichmentResult.businessName && { businessName: enrichmentResult.businessName }), ...(enrichmentResult.contactPageUrl && { contactPageUrl: enrichmentResult.contactPageUrl }), ...(enrichmentResult.email && { email: enrichmentResult.email }), ...(enrichmentResult.phone && { phone: enrichmentResult.phone }), ...(enrichmentResult.address && { address: enrichmentResult.address }), enrichmentStatus: enrichmentResult.enrichmentStatus, enrichmentNotes: enrichmentResult.enrichmentNotes, ...(enrichmentResult.isAgencyManaged !== undefined && { isAgencyManaged: enrichmentResult.isAgencyManaged }), ...(enrichmentResult.agencyName && { agencyName: enrichmentResult.agencyName }), ...(enrichmentResult.isNationalChain !== undefined && { isNationalChain: enrichmentResult.isNationalChain }), ...(enrichmentResult.chainReason && { chainReason: enrichmentResult.chainReason }) });
    onProgress?.("enriching", `${i + 1} of ${slowSites.length} sites enriched`);
  }

  onProgress?.("saving", `Saving ${leads.length} leads to database...`);
  const dbResults = await upsertLeads(leads);
  for (const r of dbResults) { if (r.action === "created") diagnostics.dbCreated++; else if (r.action === "updated") diagnostics.dbUpdated++; else diagnostics.dbFailed++; }

  const env = getEnv();
  if (env.AUTO_RESEARCH) {
    const newIds = dbResults.filter((r) => r.action === "created" && r.id).map((r) => r.id!) .slice(0, env.AI_RESEARCH_BATCH_SIZE);
    for (let i = 0; i < newIds.length; i++) {
      const id = newIds[i]!;
      onProgress?.("researching", `AI researching ${i + 1} of ${newIds.length} new leads...`);
      try {
        const processed = await processLeadResearch(prisma, id);
        diagnostics.aiResearched++;
        if (processed.draft) diagnostics.draftsGenerated++;
      } catch (error) {
        diagnostics.aiResearchFailed++;
        diagnostics.messages.push(`AI research failed for lead ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  onProgress?.("emailing", "Sending report email...");
  const emailResult = await sendReport(leads, keywords, input.email);
  diagnostics.emailSent = emailResult.success;
  if (!emailResult.success) diagnostics.messages.push(`Email failed: ${emailResult.error ?? "unknown error"}`);

  onProgress?.("complete", `Done — ${leads.length} leads found; ${diagnostics.aiResearched} AI researched; ${diagnostics.draftsGenerated} drafts generated`);
  return { leads, keywords, diagnostics };
}
