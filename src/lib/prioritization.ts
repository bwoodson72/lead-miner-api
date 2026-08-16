export const DEFAULT_PRIORITY_WEIGHTS = {
  opportunityType: 30,
  findingStrength: 25,
  contactability: 15,
  businessMaturity: 10,
  acquisitionIntent: 10,
  evidenceQuality: 10,
} as const;

export type PriorityWeights = Record<keyof typeof DEFAULT_PRIORITY_WEIGHTS, number>;

export type PriorityInput = {
  decision: string | null;
  assetStrength: string | null;
  assessmentConfidence: number;
  siteMaturityRating: string | null;
  findings: Array<{ significance: string; confidence: number }>;
  email: string | null;
  phone: string | null;
  adSource: string | null;
  isAgencyManaged: boolean;
  isNationalChain: boolean;
};

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseWeights(input: unknown): PriorityWeights {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const weights = { ...DEFAULT_PRIORITY_WEIGHTS } as PriorityWeights;
  for (const key of Object.keys(weights) as Array<keyof PriorityWeights>) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) weights[key] = value;
  }
  if (Object.values(weights).reduce((sum, value) => sum + value, 0) <= 0) return { ...DEFAULT_PRIORITY_WEIGHTS };
  return weights;
}

function opportunityScore(decision: string | null) {
  if (decision === "rebuild_candidate") return 100;
  if (decision === "optimization_candidate") return 82;
  if (decision === "needs_review") return 30;
  return 0;
}

function findingScore(findings: PriorityInput["findings"]) {
  if (!findings.length) return 20;
  const base = { high: 100, medium: 65, low: 30 } as Record<string, number>;
  return Math.max(...findings.map((finding) => (base[finding.significance] ?? 20) * Math.max(0, Math.min(1, finding.confidence))));
}

function contactabilityScore(email: string | null, phone: string | null) {
  if (email && phone) return 100;
  if (email) return 82;
  if (phone) return 45;
  return 0;
}

function maturityScore(rating: string | null, isAgencyManaged: boolean, isNationalChain: boolean) {
  const score = ({ strong: 100, adequate: 78, constrained: 58, weak: 38, unknown: 45 } as Record<string, number>)[rating ?? "unknown"] ?? 45;
  if (isNationalChain) return Math.min(score, 25);
  if (isAgencyManaged) return Math.min(score, 45);
  return score;
}

function acquisitionScore(adSource: string | null) {
  return adSource === "paid_ad" ? 100 : 55;
}

export function calculateOpportunityPriority(input: PriorityInput, configuredWeights: unknown) {
  const weights = parseWeights(configuredWeights);
  const scores: PriorityWeights = {
    opportunityType: opportunityScore(input.decision),
    findingStrength: clamp(findingScore(input.findings)),
    contactability: contactabilityScore(input.email, input.phone),
    businessMaturity: maturityScore(input.siteMaturityRating, input.isAgencyManaged, input.isNationalChain),
    acquisitionIntent: acquisitionScore(input.adSource),
    evidenceQuality: clamp(input.assessmentConfidence * 100),
  };
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const contributions = Object.fromEntries(
    (Object.keys(weights) as Array<keyof PriorityWeights>).map((key) => [key, Math.round((scores[key] * weights[key] / weightTotal) * 100) / 100]),
  ) as PriorityWeights;
  const score = clamp(Object.values(contributions).reduce((sum, value) => sum + value, 0));
  return { score, scores, weights, contributions };
}
