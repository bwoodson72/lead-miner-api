import { searchAds, type SerpAd } from "./serpapi.js";
import { discoverLocalizedCandidates, resolveLocalizedSearchSpec } from "./localized-discovery.js";
import { normalizeUrl, extractRootDomain } from "./normalize-url.js";
import { analyzeUrlsWithRateLimit } from "./pagespeed.js";
import { buildLeadRecord } from "./filters.js";
import { type KeywordInput, type LeadRecord } from "./schemas.js";
import { type Thresholds } from "../config/thresholds.js";
import { isFranchise } from "./franchise-filter.js";
import { upsertLeads, prisma, type UpsertResult } from "./db.js";
import { enrichLeadFromSite } from "./enrichment.js";
import { processLeadResearch } from "./research-routes.js";
import { getAppSettings } from "./settings.js";

type Diagnostics = {
  keywordsParsed: number;
  adsFound: number;
  paidAdsFound: number;
  organicBusinessesFound: number;
  uniqueDomains: number;
  paidDomainsQueued: number;
  organicDomainsQueued: number;
  franchisesFiltered: number;
  candidatesSaved: number;
  pageSpeedResults: number;
  pageSpeedFailures: number;
  performanceStrong: number;
  performanceModerate: number;
  performanceNone: number;
  performanceUnknown: number;
  slowSites: number;
  leadsEnriched: number;
  enrichmentFailures: number;
  emailsFound: number;
  phonesFound: number;
  skippedNoEmail: number;
  dbCreated: number;
  dbUpdated: number;
  dbFailed: number;
  aiResearched: number;
  aiResearchFailed: number;
  draftsGenerated: number;
  messages: string[];
};

type QueueEntry = {
  url: string;
  domain: string;
  keyword: string;
  adSource: "paid_ad" | "local_organic";
  serpAd: SerpAd;
};

function emptyDiagnostics(): Diagnostics {
  return {
    keywordsParsed: 0,
    adsFound: 0,
    paidAdsFound: 0,
    organicBusinessesFound: 0,
    uniqueDomains: 0,
    paidDomainsQueued: 0,
    organicDomainsQueued: 0,
    franchisesFiltered: 0,
    candidatesSaved: 0,
    pageSpeedResults: 0,
    pageSpeedFailures: 0,
    performanceStrong: 0,
    performanceModerate: 0,
    performanceNone: 0,
    performanceUnknown: 0,
    slowSites: 0,
    leadsEnriched: 0,
    enrichmentFailures: 0,
    emailsFound: 0,
    phonesFound: 0,
    skippedNoEmail: 0,
    dbCreated: 0,
    dbUpdated: 0,
    dbFailed: 0,
    aiResearched: 0,
    aiResearchFailed: 0,
    draftsGenerated: 0,
    messages: [],
  };
}

function recordInitialPersistence(diagnostics: Diagnostics, results: UpsertResult[]) {
  for (const result of results) {
    if (result.action === "created") diagnostics.dbCreated++;
    else if (result.action === "updated") diagnostics.dbUpdated++;
    else diagnostics.dbFailed++;
  }
  diagnostics.candidatesSaved = results.filter((result) => result.action !== "failed").length;
}

function recordPerformanceOpportunity(diagnostics: Diagnostics, lead: LeadRecord) {
  if (lead.performanceOpportunity === "strong") diagnostics.performanceStrong++;
  else if (lead.performanceOpportunity === "moderate") diagnostics.performanceModerate++;
  else if (lead.performanceOpportunity === "none") diagnostics.performanceNone++;
  else diagnostics.performanceUnknown++;
}

export async function runLeadSearchPipeline(
  input: KeywordInput,
  onProgress?: (stage: string, detail: string) => void,
): Promise<{ leads: LeadRecord[]; keywords: string[]; diagnostics: Diagnostics }> {
  const diagnostics = emptyDiagnostics();
  const keywords = input.keywords.split("\n").map((keyword) => keyword.trim()).filter(Boolean);
  diagnostics.keywordsParsed = keywords.length;
  const thresholds: Thresholds = {
    performanceScore: input.performanceScore,
    lcp: input.lcp,
    cls: input.cls,
    tbt: input.tbt,
  };

  onProgress?.("searching", "Discovering paid ads and local businesses...");
  const location = input.location || undefined;
  const allAds = await Promise.all(keywords.map(async (keyword) => {
    const localSpec = resolveLocalizedSearchSpec(keyword, location);
    const results = localSpec
      ? await discoverLocalizedCandidates(keyword, localSpec, input.maxDomains)
      : await searchAds(keyword, undefined, input.maxDomains);
    const paidCount = results.filter((result) => result.adSource === "paid_ad").length;
    diagnostics.messages.push(
      results.length
        ? `Found ${paidCount} paid ad(s) and ${results.length - paidCount} organic business(es) for keyword "${keyword}"`
        : `Warning: No businesses found for keyword "${keyword}"`,
    );
    return results;
  }));

  const flatAds = allAds.flat();
  diagnostics.adsFound = flatAds.length;
  diagnostics.paidAdsFound = flatAds.filter((result) => result.adSource === "paid_ad").length;
  diagnostics.organicBusinessesFound = flatAds.length - diagnostics.paidAdsFound;

  const byDomain = new Map<string, QueueEntry>();
  for (const ad of flatAds) {
    try {
      const normalizedUrl = normalizeUrl(ad.landingPageUrl);
      const domain = extractRootDomain(normalizedUrl);
      const nextEntry: QueueEntry = {
        url: normalizedUrl,
        domain,
        keyword: ad.keyword,
        adSource: ad.adSource,
        serpAd: ad,
      };
      const existing = byDomain.get(domain);
      if (!existing || (nextEntry.adSource === "paid_ad" && existing.adSource === "local_organic")) {
        byDomain.set(domain, nextEntry);
      }
    } catch {
      diagnostics.messages.push(`Skipping invalid URL: ${ad.landingPageUrl}`);
    }
  }

  const queue = Array.from(byDomain.values()).sort((a, b) => {
    if (a.adSource === b.adSource) return 0;
    return a.adSource === "paid_ad" ? -1 : 1;
  });
  diagnostics.uniqueDomains = queue.length;
  diagnostics.paidDomainsQueued = queue.filter((entry) => entry.adSource === "paid_ad").length;
  diagnostics.organicDomainsQueued = queue.length - diagnostics.paidDomainsQueued;

  const filteredQueue = queue.filter((entry) => {
    if (!isFranchise(entry.domain)) return true;
    diagnostics.franchisesFiltered++;
    return false;
  });
  const candidateQueue = filteredQueue.slice(0, input.maxDomains);

  onProgress?.("saving", `Saving ${candidateQueue.length} discovered candidates before site screening...`);
  const pendingCandidates = candidateQueue.map((entry) => buildLeadRecord({
    keyword: entry.keyword,
    domain: entry.domain,
    landingPageUrl: entry.url,
    thresholds,
    screeningStatus: "pending",
    adSource: entry.adSource,
    serpAd: entry.serpAd,
  }));
  const initialDbResults = await upsertLeads(pendingCandidates);
  recordInitialPersistence(diagnostics, initialDbResults);

  onProgress?.("analyzing", `Running PageSpeed analysis on ${candidateQueue.length} candidates...`);
  const pageSpeedMap = await analyzeUrlsWithRateLimit(
    candidateQueue,
    input.maxDomains,
    3,
    (completed, total) => onProgress?.("analyzing", `${completed} of ${total} candidates analyzed`),
  );
  diagnostics.pageSpeedResults = pageSpeedMap.size;
  diagnostics.pageSpeedFailures = candidateQueue.length - pageSpeedMap.size;

  onProgress?.("enriching", `Enriching ${candidateQueue.length} candidates...`);
  const leads: LeadRecord[] = [];
  for (let index = 0; index < candidateQueue.length; index++) {
    const entry = candidateQueue[index]!;
    const pageSpeed = pageSpeedMap.get(entry.domain) ?? null;
    const baseLead = buildLeadRecord({
      keyword: entry.keyword,
      domain: entry.domain,
      landingPageUrl: entry.url,
      pageSpeed,
      thresholds,
      screeningStatus: pageSpeed ? "complete" : "partial",
      adSource: entry.adSource,
      serpAd: entry.serpAd,
    });
    recordPerformanceOpportunity(diagnostics, baseLead);

    const enrichmentResult = await enrichLeadFromSite({
      url: entry.url,
      existingBusinessName: baseLead.businessName,
      existingPhone: baseLead.phone,
      existingAddress: baseLead.address,
    });

    if (enrichmentResult.enrichmentStatus === "enriched") {
      diagnostics.leadsEnriched++;
      if (enrichmentResult.email) diagnostics.emailsFound++;
      if (enrichmentResult.phone || baseLead.phone) diagnostics.phonesFound++;
    } else if (enrichmentResult.enrichmentStatus === "failed") {
      diagnostics.enrichmentFailures++;
    }

    leads.push({
      ...baseLead,
      ...(enrichmentResult.businessName && { businessName: enrichmentResult.businessName }),
      ...(enrichmentResult.contactPageUrl && { contactPageUrl: enrichmentResult.contactPageUrl }),
      ...(enrichmentResult.email && { email: enrichmentResult.email, emailSource: "enrichment" as const }),
      ...(baseLead.phone
        ? { phoneSource: "discovery" as const }
        : enrichmentResult.phone
          ? { phone: enrichmentResult.phone, phoneSource: "enrichment" as const }
          : {}),
      ...(enrichmentResult.address && { address: enrichmentResult.address }),
      enrichmentStatus: enrichmentResult.enrichmentStatus,
      enrichmentNotes: enrichmentResult.enrichmentNotes,
      ...(enrichmentResult.isAgencyManaged !== undefined && { isAgencyManaged: enrichmentResult.isAgencyManaged }),
      ...(enrichmentResult.agencyName && { agencyName: enrichmentResult.agencyName }),
      ...(enrichmentResult.isNationalChain !== undefined && { isNationalChain: enrichmentResult.isNationalChain }),
      ...(enrichmentResult.chainReason && { chainReason: enrichmentResult.chainReason }),
    });
    onProgress?.("enriching", `${index + 1} of ${candidateQueue.length} candidates enriched`);
  }

  diagnostics.slowSites = diagnostics.performanceStrong;
  onProgress?.("saving", `Saving screening and enrichment results for ${leads.length} candidates...`);
  const finalDbResults = await upsertLeads(leads);
  const finalFailures = finalDbResults.filter((result) => result.action === "failed");
  if (finalFailures.length) {
    diagnostics.dbFailed += finalFailures.length;
    diagnostics.messages.push(`Failed to persist final screening/enrichment for ${finalFailures.length} candidate(s)`);
  }

  const createdIds = new Set<number>();
  for (const result of [...initialDbResults, ...finalDbResults]) {
    if (result.action === "created" && result.id) createdIds.add(result.id);
  }

  const settings = await getAppSettings(prisma);
  if (settings.autoResearch) {
    const newIds = Array.from(createdIds);
    const researchable = newIds.length
      ? await prisma.lead.findMany({
          where: { id: { in: newIds }, email: { not: null } },
          select: { id: true },
        })
      : [];
    const researchableIds = new Set(researchable.map((lead) => lead.id));
    diagnostics.skippedNoEmail += newIds.filter((id) => !researchableIds.has(id)).length;
    if (diagnostics.skippedNoEmail) {
      diagnostics.messages.push(`Skipped AI research for ${diagnostics.skippedNoEmail} new lead(s) with no email`);
    }

    for (let index = 0; index < researchable.length; index++) {
      const id = researchable[index]!.id;
      onProgress?.("researching", `AI researching ${index + 1} of ${researchable.length} contactable new leads...`);
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

  onProgress?.(
    "complete",
    `Done — ${leads.length} candidates saved; ${diagnostics.performanceStrong} strong performance opportunities; ${diagnostics.aiResearched} AI researched`,
  );
  return { leads, keywords, diagnostics };
}
