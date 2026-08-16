import {
  containsTemplateContamination,
  containsUnsupportedFormAbsenceClaim,
  type ResearchEvidenceSource,
} from "./research-evidence-safety.js";

export type AssetFinding = {
  category: string;
  title: string;
  evidence: string;
  assetCapability: string;
  confidence: number;
  significance: "low" | "medium" | "high";
  evidenceSources: ResearchEvidenceSource[];
};

const UNVERIFIED_DOM_SOURCES = new Set<ResearchEvidenceSource>(["dom_heading", "dom_text"]);

function lowerSignificance(value: AssetFinding["significance"], ceiling: "low" | "medium") {
  if (ceiling === "low") return "low" as const;
  return value === "high" ? "medium" as const : value;
}

function domOnly(finding: AssetFinding) {
  return finding.evidenceSources.length > 0 && finding.evidenceSources.every((source) => UNVERIFIED_DOM_SOURCES.has(source));
}

export function applyAssetFindingSafety<T extends AssetFinding>(finding: T): T {
  const claim = `${finding.category} ${finding.title} ${finding.evidence} ${finding.assetCapability}`;
  if (containsUnsupportedFormAbsenceClaim(claim)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.2),
      significance: lowerSignificance(finding.significance, "low"),
    };
  }
  if (domOnly(finding) && containsTemplateContamination(claim)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.4),
      significance: lowerSignificance(finding.significance, "low"),
    };
  }
  if (domOnly(finding)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.65),
      significance: lowerSignificance(finding.significance, "medium"),
    };
  }
  return finding;
}
