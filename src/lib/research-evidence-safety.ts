export const RESEARCH_EVIDENCE_SOURCES = [
  "title",
  "meta_description",
  "navigation",
  "cta",
  "contact_signal",
  "architecture",
  "technology",
  "performance",
  "lead_data",
  "dom_heading",
  "dom_text",
] as const;

export type ResearchEvidenceSource = typeof RESEARCH_EVIDENCE_SOURCES[number];

export type EvidenceSafetyProblem = {
  category: string;
  title: string;
  evidence: string;
  businessConsequence: string;
  recommendedImprovement: string;
  confidence: number;
  outreachValue: "low" | "medium" | "high";
  evidenceSources: ResearchEvidenceSource[];
};

const UNVERIFIED_DOM_SOURCES = new Set<ResearchEvidenceSource>(["dom_heading", "dom_text"]);
const TEMPLATE_CONTAMINATION = /template|placeholder|demo content|sample content|unrelated|wrong (?:business|company|industry)|kitchen|kitchor|lorem ipsum|leftover/i;

function lowerOutreachValue(value: "low" | "medium" | "high", ceiling: "low" | "medium") {
  if (ceiling === "low") return "low" as const;
  return value === "high" ? "medium" as const : value;
}

export function applyResearchEvidenceSafety<T extends EvidenceSafetyProblem>(problem: T): T {
  const sources = problem.evidenceSources ?? [];
  const onlyUnverifiedDom = sources.length > 0 && sources.every((source) => UNVERIFIED_DOM_SOURCES.has(source));
  const looksLikeTemplateContamination = TEMPLATE_CONTAMINATION.test(`${problem.category} ${problem.title} ${problem.evidence}`);

  if (onlyUnverifiedDom && looksLikeTemplateContamination) {
    return {
      ...problem,
      confidence: Math.min(problem.confidence, 0.4),
      outreachValue: lowerOutreachValue(problem.outreachValue, "low"),
    };
  }

  if (onlyUnverifiedDom) {
    return {
      ...problem,
      confidence: Math.min(problem.confidence, 0.65),
      outreachValue: lowerOutreachValue(problem.outreachValue, "medium"),
    };
  }

  return problem;
}

export function isSafePrimaryOutreachProblem(problem: EvidenceSafetyProblem) {
  return problem.outreachValue !== "low" && problem.confidence >= 0.6;
}

export function sanitizePrimaryOutreachAngle(angle: string | null, problems: EvidenceSafetyProblem[]) {
  if (!angle) return null;
  if (!TEMPLATE_CONTAMINATION.test(angle)) return angle;
  const corroborated = problems.some((problem) => {
    if (!TEMPLATE_CONTAMINATION.test(`${problem.category} ${problem.title} ${problem.evidence}`)) return false;
    return problem.evidenceSources.some((source) => !UNVERIFIED_DOM_SOURCES.has(source)) && isSafePrimaryOutreachProblem(problem);
  });
  return corroborated ? angle : null;
}
