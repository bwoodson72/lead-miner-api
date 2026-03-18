import { type PageSpeedResult } from "./pagespeed.js";
import { LeadRecordSchema, type LeadRecord, type SerpAd } from "./schemas.js";
import { type Thresholds } from "../config/thresholds.js";

export function isSlowSite(result: PageSpeedResult, thresholds: Thresholds): boolean {
  return (
    result.performanceScore < thresholds.performanceScore ||
    result.lcp > thresholds.lcp ||
    result.cls > thresholds.cls ||
    result.tbt > thresholds.tbt
  );
}

export function buildLeadRecord(params: {
  keyword: string;
  domain: string;
  landingPageUrl: string;
  pageSpeed: PageSpeedResult;
  adSource: "paid_ad" | "local_organic";
  serpAd?: SerpAd;
}): LeadRecord {
  const { keyword, domain, landingPageUrl, pageSpeed, adSource, serpAd } = params;
  const timestamp = new Date().toISOString().slice(0, 10);

  return LeadRecordSchema.parse({
    keyword,
    domain,
    landingPageUrl,
    performanceScore: pageSpeed.performanceScore,
    lcp: pageSpeed.lcp,
    cls: pageSpeed.cls,
    tbt: pageSpeed.tbt,
    adSource,
    timestamp,
    // PageSpeed metadata
    pagespeedStrategy: pageSpeed.strategy,
    pagespeedTestedAt: pageSpeed.testedAt,
    ...(pageSpeed.reportUrl && { pagespeedReportUrl: pageSpeed.reportUrl }),
    // SerpAd source metadata
    ...(serpAd?.sourceTitle && { sourceTitle: serpAd.sourceTitle }),
    ...(serpAd?.businessName && { businessName: serpAd.businessName }),
    ...(serpAd?.phone && { phone: serpAd.phone }),
    ...(serpAd?.address && { address: serpAd.address }),
  });
}
