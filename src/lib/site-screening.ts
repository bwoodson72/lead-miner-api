import type { Thresholds } from "../config/thresholds.js";
import type { PageSpeedResult } from "./pagespeed.js";

export type PerformanceOpportunity = "strong" | "moderate" | "none" | "unknown";
export type ScreeningStatus = "pending" | "complete" | "partial" | "failed";

export type PerformanceScreen = {
  screeningStatus: ScreeningStatus;
  performanceOpportunity: PerformanceOpportunity;
  lastScreenedAt: string | null;
};

export function classifyPerformanceOpportunity(
  result: PageSpeedResult | null | undefined,
  thresholds: Thresholds,
): PerformanceOpportunity {
  if (!result) return "unknown";

  const lcpProblem = result.lcp > thresholds.lcp;
  const scoreProblem = result.performanceScore < thresholds.performanceScore;
  const clsProblem = result.cls > thresholds.cls;
  const tbtProblem = result.tbt > thresholds.tbt;

  if (lcpProblem && (scoreProblem || clsProblem || tbtProblem)) return "strong";
  if (lcpProblem || scoreProblem || clsProblem || tbtProblem) return "moderate";
  return "none";
}

export function buildPerformanceScreen(
  result: PageSpeedResult | null | undefined,
  thresholds: Thresholds,
  attempted = true,
): PerformanceScreen {
  if (!attempted) {
    return {
      screeningStatus: "pending",
      performanceOpportunity: "unknown",
      lastScreenedAt: null,
    };
  }

  return {
    screeningStatus: result ? "complete" : "partial",
    performanceOpportunity: classifyPerformanceOpportunity(result, thresholds),
    lastScreenedAt: new Date().toISOString(),
  };
}
