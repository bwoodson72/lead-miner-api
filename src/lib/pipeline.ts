import { searchAds, type SerpAd } from "./serpapi.js";
import { normalizeUrl, extractRootDomain } from "./normalize-url.js";
import { analyzeUrlsWithRateLimit, type PageSpeedResult } from "./pagespeed.js";
import { isSlowSite, buildLeadRecord } from "./filters.js";
import { sendReport } from "./email.js";
import { type KeywordInput, type LeadRecord } from "./schemas.js";
import { type Thresholds } from "../config/thresholds.js";
import { isFranchise } from "./franchise-filter.js";
import { upsertLeads } from "./db.js";
import { enrichLeadFromSite } from "./enrichment.js";

type Diagnostics = {
  keywordsParsed: number;
  adsFound: number;
  paidAdsFound: number;
  organicBusinessesFound: number;
  uniqueDomains: number;
  paidDomainsQueued: number;
  organicDomainsQueued: number;
  franchisesFiltered: number;
  pageSpeedResults: number;
  pageSpeedFailures: number;
  slowSites: number;
  leadsEnriched: number;
  enrichmentFailures: number;
  emailsFound: number;
  phonesFound: number;
  dbCreated: number;
  dbUpdated: number;
  dbFailed: number;
  emailSent: boolean;
  messages: string[];
};

export async function runLeadSearchPipeline(
  input: KeywordInput,
  onProgress?: (stage: string, detail: string) => void
): Promise<{
  leads: LeadRecord[];
  keywords: string[];
  diagnostics: Diagnostics;
}> {
  const diagnostics: Diagnostics = {
    keywordsParsed: 0,
    adsFound: 0,
    paidAdsFound: 0,
    organicBusinessesFound: 0,
    uniqueDomains: 0,
    paidDomainsQueued: 0,
    organicDomainsQueued: 0,
    franchisesFiltered: 0,
    pageSpeedResults: 0,
    pageSpeedFailures: 0,
    slowSites: 0,
    leadsEnriched: 0,
    enrichmentFailures: 0,
    emailsFound: 0,
    phonesFound: 0,
    dbCreated: 0,
    dbUpdated: 0,
    dbFailed: 0,
    emailSent: false,
    messages: [],
  };

  // Step 1: Parse keywords
  const keywords = input.keywords
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  diagnostics.keywordsParsed = keywords.length;

  // Step 2: Build thresholds
  const thresholds: Thresholds = {
    performanceScore: input.performanceScore,
    lcp: input.lcp,
    cls: input.cls,
    tbt: input.tbt,
  };

  // Step 3: Search Serper for each keyword
  onProgress?.("searching", "Querying Serper for keywords...");
  const location = input.location || undefined;
  const allAds = await Promise.all(
    keywords.map(async (keyword) => {
      const results = await searchAds(keyword, location);
      const paidCount = results.filter((result) => result.adSource === "paid_ad").length;
      const organicCount = results.length - paidCount;

      if (results.length === 0) {
        diagnostics.messages.push(`Warning: No businesses found for keyword "${keyword}"`);
      } else {
        diagnostics.messages.push(
          `Found ${paidCount} paid ad(s) and ${organicCount} organic business(es) for keyword "${keyword}"`
        );
      }
      diagnostics.messages.push(`Used 2 Serper credits for: ${keyword}`);
      return results;
    })
  );

  const flatAds = allAds.flat();
  diagnostics.adsFound = flatAds.length;
  diagnostics.paidAdsFound = flatAds.filter((result) => result.adSource === "paid_ad").length;
  diagnostics.organicBusinessesFound = flatAds.length - diagnostics.paidAdsFound;
  onProgress?.(
    "searching",
    `Found ${diagnostics.paidAdsFound} paid ads and ${diagnostics.organicBusinessesFound} organic businesses across ${keywords.length} keywords`
  );

  // Step 4: Normalize URLs, extract domains, and deduplicate by domain.
  // If a domain is ever seen as a paid advertiser, preserve that paid result even
  // when the same domain was discovered organically for another keyword first.
  type QueueEntry = {
    url: string;
    domain: string;
    keyword: string;
    adSource: "paid_ad" | "local_organic";
    serpAd: SerpAd;
  };

  const byDomain = new Map<string, QueueEntry>();

  for (const ad of flatAds) {
    let normalizedUrl: string;
    let domain: string;
    try {
      normalizedUrl = normalizeUrl(ad.landingPageUrl);
      domain = extractRootDomain(normalizedUrl);
    } catch {
      diagnostics.messages.push(`Skipping invalid URL: ${ad.landingPageUrl}`);
      continue;
    }

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
  }

  // Paid advertisers are the highest-value prospects, so analyze them before
  // organic businesses when maxDomains caps the PageSpeed queue.
  const queue = Array.from(byDomain.values()).sort((a, b) => {
    if (a.adSource === b.adSource) return 0;
    return a.adSource === "paid_ad" ? -1 : 1;
  });

  diagnostics.uniqueDomains = queue.length;
  diagnostics.paidDomainsQueued = queue.filter((entry) => entry.adSource === "paid_ad").length;
  diagnostics.organicDomainsQueued = queue.length - diagnostics.paidDomainsQueued;
  diagnostics.messages.push(
    `Unique domains queued: ${diagnostics.paidDomainsQueued} paid, ${diagnostics.organicDomainsQueued} organic`
  );

  // Step 4b: Filter out franchise domains
  const filteredQueue = queue.filter((entry) => {
    if (isFranchise(entry.domain)) {
      diagnostics.franchisesFiltered++;
      diagnostics.messages.push(`Filtered franchise: ${entry.domain}`);
      return false;
    }
    return true;
  });

  if (filteredQueue.length > input.maxDomains) {
    diagnostics.messages.push(
      `Capping analysis to ${input.maxDomains} domains (${filteredQueue.length} unique found); paid advertisers remain first in queue`
    );
  }

  // Step 5: PageSpeed analysis
  const total = Math.min(filteredQueue.length, input.maxDomains ?? 20);
  onProgress?.("analyzing", "Running PageSpeed analysis on " + total + " domains...");
  const pageSpeedMap = await analyzeUrlsWithRateLimit(filteredQueue, input.maxDomains ?? 20, 3, (completed, tot) => {
    onProgress?.("analyzing", completed + " of " + tot + " domains analyzed");
  });
  diagnostics.pageSpeedResults = pageSpeedMap.size;
  diagnostics.pageSpeedFailures = Math.min(filteredQueue.length, input.maxDomains) - pageSpeedMap.size;

  // Step 6: Filter slow sites and build lead records
  const slowSites: Array<{ entry: QueueEntry; result: PageSpeedResult }> = [];

  for (const entry of filteredQueue.slice(0, input.maxDomains)) {
    const result = pageSpeedMap.get(entry.domain);
    if (!result) continue;

    if (isSlowSite(result, thresholds)) {
      slowSites.push({ entry, result });
    }
  }

  diagnostics.slowSites = slowSites.length;

  // Step 6b: Enrich slow sites
  onProgress?.("enriching", `Enriching ${slowSites.length} slow sites...`);
  const leads: LeadRecord[] = [];

  for (let i = 0; i < slowSites.length; i++) {
    const { entry, result } = slowSites[i]!;

    // Build base lead with PSI and SerpAd metadata
    const baseLead = buildLeadRecord({
      keyword: entry.keyword,
      domain: entry.domain,
      landingPageUrl: entry.url,
      pageSpeed: result,
      adSource: entry.adSource,
      serpAd: entry.serpAd,
    });

    // Enrich the lead
    const enrichmentResult = await enrichLeadFromSite({
      url: entry.url,
      existingBusinessName: baseLead.businessName,
    });

    // Track diagnostics
    if (enrichmentResult.enrichmentStatus === "enriched") {
      diagnostics.leadsEnriched++;
      if (enrichmentResult.email) diagnostics.emailsFound++;
      if (enrichmentResult.phone) diagnostics.phonesFound++;
    } else if (enrichmentResult.enrichmentStatus === "failed") {
      diagnostics.enrichmentFailures++;
      diagnostics.messages.push(`Enrichment failed for ${entry.domain}: ${enrichmentResult.enrichmentNotes}`);
    }

    // Merge enrichment results into lead
    const enrichedLead: LeadRecord = {
      ...baseLead,
      ...(enrichmentResult.businessName && { businessName: enrichmentResult.businessName }),
      ...(enrichmentResult.contactPageUrl && { contactPageUrl: enrichmentResult.contactPageUrl }),
      ...(enrichmentResult.email && { email: enrichmentResult.email }),
      ...(enrichmentResult.phone && { phone: enrichmentResult.phone }),
      ...(enrichmentResult.address && { address: enrichmentResult.address }),
      enrichmentStatus: enrichmentResult.enrichmentStatus,
      enrichmentNotes: enrichmentResult.enrichmentNotes,
      ...(enrichmentResult.isAgencyManaged !== undefined && { isAgencyManaged: enrichmentResult.isAgencyManaged }),
      ...(enrichmentResult.agencyName && { agencyName: enrichmentResult.agencyName }),
      ...(enrichmentResult.isNationalChain !== undefined && { isNationalChain: enrichmentResult.isNationalChain }),
      ...(enrichmentResult.chainReason && { chainReason: enrichmentResult.chainReason }),
    };

    leads.push(enrichedLead);

    onProgress?.("enriching", `${i + 1} of ${slowSites.length} sites enriched`);
  }

  diagnostics.messages.push(
    `Enrichment: ${diagnostics.leadsEnriched} enriched, ${diagnostics.enrichmentFailures} failed, ${diagnostics.emailsFound} emails, ${diagnostics.phonesFound} phones`
  );

  // Step 7: Save to database
  onProgress?.("saving", "Saving " + leads.length + " leads to database...");
  const dbResults = await upsertLeads(leads);
  for (const r of dbResults) {
    if (r.action === "created") diagnostics.dbCreated++;
    else if (r.action === "updated") diagnostics.dbUpdated++;
    else diagnostics.dbFailed++;
  }
  diagnostics.messages.push(
    `Database: ${diagnostics.dbCreated} created, ${diagnostics.dbUpdated} updated, ${diagnostics.dbFailed} failed`
  );

  // Step 8: Send email report
  onProgress?.("emailing", "Sending report email...");
  const emailResult = await sendReport(leads, keywords, input.email);
  diagnostics.emailSent = emailResult.success;
  if (!emailResult.success) {
    diagnostics.messages.push(`Email failed: ${emailResult.error ?? "unknown error"}`);
  }

  onProgress?.("complete", "Done — " + leads.length + " leads found");
  return { leads, keywords, diagnostics };
}
