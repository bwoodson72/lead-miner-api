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
  uniqueDomains: number;
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
    uniqueDomains: 0,
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

  // Step 3: Search ads for each keyword
  onProgress?.("searching", "Querying SerpApi for keywords...");
  const location = input.location || undefined;
  const allAds = await Promise.all(
    keywords.map(async (keyword) => {
      const ads = await searchAds(keyword, location);
      if (ads.length === 0) {
        diagnostics.messages.push(`Warning: No ads found for keyword "${keyword}"`);
      } else {
        diagnostics.messages.push(`Found ${ads.length} ad(s) for keyword "${keyword}"`);
      }
      diagnostics.messages.push(`Used 2 SerpApi credits for: ${keyword}`);
      return ads;
    })
  );

  const flatAds = allAds.flat();
  diagnostics.adsFound = flatAds.length;
  onProgress?.("searching", "Found " + flatAds.length + " businesses across " + keywords.length + " keywords");

  // Step 4: Normalize URLs, extract domains, deduplicate by domain
  type QueueEntry = { url: string; domain: string; keyword: string; adSource: "paid_ad" | "local_organic"; serpAd: SerpAd };
  const seenDomains = new Set<string>();
  const queue: QueueEntry[] = [];

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

    if (!seenDomains.has(domain)) {
      seenDomains.add(domain);
      queue.push({ url: normalizedUrl, domain, keyword: ad.keyword, adSource: ad.adSource, serpAd: ad });
    }
  }

  diagnostics.uniqueDomains = queue.length;

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
      `Capping analysis to ${input.maxDomains} domains (${filteredQueue.length} unique found)`
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
