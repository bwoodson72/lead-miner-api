import { searchAds } from "./serpapi.js";
import { normalizeUrl, extractRootDomain } from "./normalize-url.js";
import { analyzeUrlsWithRateLimit } from "./pagespeed.js";
import { isSlowSite, buildLeadRecord } from "./filters.js";
import { sendReport } from "./email.js";
import { type KeywordInput, type LeadRecord } from "./schemas.js";
import { type Thresholds } from "../config/thresholds.js";

type Diagnostics = {
  keywordsParsed: number;
  adsFound: number;
  uniqueDomains: number;
  pageSpeedResults: number;
  pageSpeedFailures: number;
  slowSites: number;
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
    pageSpeedResults: 0,
    pageSpeedFailures: 0,
    slowSites: 0,
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
  type QueueEntry = { url: string; domain: string; keyword: string };
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
      queue.push({ url: normalizedUrl, domain, keyword: ad.keyword });
    }
  }

  diagnostics.uniqueDomains = queue.length;

  if (queue.length > input.maxDomains) {
    diagnostics.messages.push(
      `Capping analysis to ${input.maxDomains} domains (${queue.length} unique found)`
    );
  }

  // Step 5: PageSpeed analysis
  const total = Math.min(queue.length, input.maxDomains ?? 20);
  onProgress?.("analyzing", "Running PageSpeed analysis on " + total + " domains...");
  const pageSpeedMap = await analyzeUrlsWithRateLimit(queue, input.maxDomains ?? 20, 3, (completed, tot) => {
    onProgress?.("analyzing", completed + " of " + tot + " domains analyzed");
  });
  diagnostics.pageSpeedResults = pageSpeedMap.size;
  diagnostics.pageSpeedFailures = Math.min(queue.length, input.maxDomains) - pageSpeedMap.size;

  // Step 6: Filter slow sites and build lead records
  const leads: LeadRecord[] = [];

  for (const entry of queue.slice(0, input.maxDomains)) {
    const result = pageSpeedMap.get(entry.domain);
    if (!result) continue;

    if (isSlowSite(result, thresholds)) {
      const lead = buildLeadRecord({
        keyword: entry.keyword,
        domain: entry.domain,
        landingPageUrl: entry.url,
        pageSpeed: result,
      });
      leads.push(lead);
    }
  }

  diagnostics.slowSites = leads.length;

  // Step 7: Send email report
  onProgress?.("emailing", "Sending report email...");
  const emailResult = await sendReport(leads, keywords, input.email);
  diagnostics.emailSent = emailResult.success;
  if (!emailResult.success) {
    diagnostics.messages.push(`Email failed: ${emailResult.error ?? "unknown error"}`);
  }

  onProgress?.("complete", "Done — " + leads.length + " leads found");
  return { leads, keywords, diagnostics };
}
