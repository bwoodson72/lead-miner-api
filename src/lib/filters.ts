import { type PageSpeedResult } from "./pagespeed.js";
import { LeadRecordSchema, type LeadRecord, type SerpAd } from "./schemas.js";
import { type Thresholds } from "../config/thresholds.js";
import { buildPerformanceScreen, classifyPerformanceOpportunity, type ScreeningStatus } from "./site-screening.js";

export function buildLeadRecord(params: {
  keyword: string;
  domain: string;
  landingPageUrl: string;
  pageSpeed?: PageSpeedResult | null;
  thresholds: Thresholds;
  screeningStatus?: ScreeningStatus;
  adSource: "paid_ad" | "local_organic";
  serpAd?: SerpAd;
}): LeadRecord {
  const { keyword, domain, landingPageUrl, pageSpeed = null, thresholds, screeningStatus, adSource, serpAd } = params;
  const timestamp = new Date().toISOString().slice(0, 10);
  const screen = screeningStatus
    ? {
        screeningStatus,
        performanceOpportunity: classifyPerformanceOpportunity(pageSpeed, thresholds),
        lastScreenedAt: screeningStatus === "pending" ? null : new Date().toISOString(),
      }
    : buildPerformanceScreen(pageSpeed, thresholds, Boolean(pageSpeed));

  return LeadRecordSchema.parse({
    keyword,
    domain,
    landingPageUrl,
    performanceScore: pageSpeed?.performanceScore ?? null,
    lcp: pageSpeed?.lcp ?? null,
    cls: pageSpeed?.cls ?? null,
    tbt: pageSpeed?.tbt ?? null,
    adSource,
    timestamp,
    screeningStatus: screen.screeningStatus,
    performanceOpportunity: screen.performanceOpportunity,
    ...(screen.lastScreenedAt && { lastScreenedAt: screen.lastScreenedAt }),
    ...(pageSpeed?.strategy && { pagespeedStrategy: pageSpeed.strategy }),
    ...(pageSpeed?.testedAt && { pagespeedTestedAt: pageSpeed.testedAt }),
    ...(pageSpeed?.reportUrl && { pagespeedReportUrl: pageSpeed.reportUrl }),
    ...(serpAd?.sourceTitle && { sourceTitle: serpAd.sourceTitle }),
    ...(serpAd?.businessName && { businessName: serpAd.businessName }),
    ...(serpAd?.phone && { phone: serpAd.phone }),
    ...(serpAd?.address && { address: serpAd.address }),
  });
}
