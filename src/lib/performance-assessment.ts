export type PerformanceBand = "good" | "needs_improvement" | "poor" | "unknown";

export type PerformanceAssessment = {
  overall: PerformanceBand;
  scoreBand: PerformanceBand;
  lcpBand: PerformanceBand;
  tbtBand: PerformanceBand;
  clsBand: PerformanceBand;
  poorMetricCount: number;
  needsImprovementMetricCount: number;
  strongPerformanceSignal: boolean;
};

function scoreBand(score: number | null | undefined): PerformanceBand {
  if (score == null || !Number.isFinite(score)) return "unknown";
  if (score <= 49) return "poor";
  if (score <= 89) return "needs_improvement";
  return "good";
}

function lcpBand(lcpMs: number | null | undefined): PerformanceBand {
  if (lcpMs == null || !Number.isFinite(lcpMs)) return "unknown";
  if (lcpMs > 4000) return "poor";
  if (lcpMs > 2500) return "needs_improvement";
  return "good";
}

function tbtBand(tbtMs: number | null | undefined): PerformanceBand {
  if (tbtMs == null || !Number.isFinite(tbtMs)) return "unknown";
  if (tbtMs > 600) return "poor";
  if (tbtMs > 200) return "needs_improvement";
  return "good";
}

function clsBand(cls: number | null | undefined): PerformanceBand {
  if (cls == null || !Number.isFinite(cls)) return "unknown";
  if (cls > 0.25) return "poor";
  if (cls > 0.1) return "needs_improvement";
  return "good";
}

export function assessPerformance(input: {
  lighthouseScore: number | null | undefined;
  lcp: number | null | undefined;
  tbt: number | null | undefined;
  cls: number | null | undefined;
}): PerformanceAssessment {
  const bands = {
    scoreBand: scoreBand(input.lighthouseScore),
    lcpBand: lcpBand(input.lcp),
    tbtBand: tbtBand(input.tbt),
    clsBand: clsBand(input.cls),
  };
  const values = Object.values(bands);
  const poorMetricCount = values.filter((band) => band === "poor").length;
  const needsImprovementMetricCount = values.filter((band) => band === "needs_improvement").length;
  const known = values.filter((band) => band !== "unknown");
  const overall: PerformanceBand = poorMetricCount > 0
    ? "poor"
    : needsImprovementMetricCount > 0
      ? "needs_improvement"
      : known.length
        ? "good"
        : "unknown";

  // This is intentionally deterministic. AI may interpret severity, but it does
  // not get to redefine Google's bands or decide whether a poor measurement exists.
  const strongPerformanceSignal = poorMetricCount >= 2
    || bands.scoreBand === "poor"
    || bands.lcpBand === "poor";

  return {
    overall,
    ...bands,
    poorMetricCount,
    needsImprovementMetricCount,
    strongPerformanceSignal,
  };
}
