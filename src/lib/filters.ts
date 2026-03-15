import { type PageSpeedResult } from "./pagespeed.js";
import { LeadRecordSchema, type LeadRecord } from "./schemas.js";
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
}): LeadRecord {
  const { keyword, domain, landingPageUrl, pageSpeed } = params;
  const timestamp = new Date().toISOString().slice(0, 10);

  return LeadRecordSchema.parse({
    keyword,
    domain,
    landingPageUrl,
    performanceScore: pageSpeed.performanceScore,
    lcp: pageSpeed.lcp,
    cls: pageSpeed.cls,
    tbt: pageSpeed.tbt,
    timestamp,
  });
}
