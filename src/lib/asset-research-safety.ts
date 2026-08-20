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
const UNSUPPORTED_VISITOR_REACHABILITY = /\b(?:website|site|homepage|page|domain)\b[\s\S]{0,80}\b(?:unreachable|offline|down|unavailable|inaccessible|cannot be accessed|can't be accessed|not reachable|not accessible)\b|\b(?:unreachable|offline|down|unavailable|inaccessible|not reachable|not accessible)\b[\s\S]{0,80}\b(?:website|site|homepage|page|domain)\b/i;
const UNVERIFIED_PLACEHOLDER_CONTENT = /\blorem ipsum\b|\bplaceholder (?:text|copy|content|section|language)\b|\bdemo (?:text|copy|content)\b|\bsample (?:text|copy|content)\b/i;

function lowerSignificance(value: AssetFinding["significance"], ceiling: "low" | "medium") {
  if (ceiling === "low") return "low" as const;
  return value === "high" ? "medium" as const : value;
}

function domOnly(finding: AssetFinding) {
  return finding.evidenceSources.length > 0 && finding.evidenceSources.every((source) => UNVERIFIED_DOM_SOURCES.has(source));
}

function searchIndexOnly(finding: AssetFinding) {
  const allowed = new Set<ResearchEvidenceSource>(["search_index", "site_coverage"]);
  return finding.evidenceSources.includes("search_index") && finding.evidenceSources.every((source) => allowed.has(source));
}

export function containsUnsupportedVisitorReachabilityClaim(value: string | null | undefined) {
  return Boolean(value && UNSUPPORTED_VISITOR_REACHABILITY.test(value));
}

export function containsUnverifiedPlaceholderContent(value: string | null | undefined) {
  return Boolean(value && UNVERIFIED_PLACEHOLDER_CONTENT.test(value));
}

export function isUnsupportedCrawlerReachabilityFinding(finding: AssetFinding) {
  const claim = `${finding.category} ${finding.title} ${finding.evidence} ${finding.assetCapability}`;
  return containsUnsupportedVisitorReachabilityClaim(claim);
}

export function isUnverifiedPlaceholderFinding(finding: AssetFinding) {
  const claim = `${finding.category} ${finding.title} ${finding.evidence} ${finding.assetCapability}`;
  return containsUnverifiedPlaceholderContent(claim);
}

export function applyAssetFindingSafety<T extends AssetFinding>(finding: T): T {
  const claim = `${finding.category} ${finding.title} ${finding.evidence} ${finding.assetCapability}`;
  if (isUnsupportedCrawlerReachabilityFinding(finding)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.1),
      significance: lowerSignificance(finding.significance, "low"),
    };
  }
  if (containsUnsupportedFormAbsenceClaim(claim)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.2),
      significance: lowerSignificance(finding.significance, "low"),
    };
  }
  if (isUnverifiedPlaceholderFinding(finding)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.25),
      significance: lowerSignificance(finding.significance, "low"),
    };
  }
  if (searchIndexOnly(finding)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.65),
      significance: lowerSignificance(finding.significance, "medium"),
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

export function enforcePlaceholderQualificationSafety<T extends {
  decision: string;
  assetStrength: string;
  findings: AssetFinding[];
  decisionReason: string;
  confidence: number;
}>(result: T): T {
  if (result.decision !== "rebuild_candidate") return result;

  const hasPlaceholderFinding = result.findings.some(isUnverifiedPlaceholderFinding);
  if (!hasPlaceholderFinding) return result;

  const independentlyMaterial = result.findings.some((finding) =>
    !isUnverifiedPlaceholderFinding(finding)
    && finding.confidence >= 0.7
    && finding.significance !== "low",
  );
  if (independentlyMaterial) return result;

  return {
    ...result,
    decision: "needs_review",
    assetStrength: "unknown",
    decisionReason: "Needs review because placeholder or demo text was detected only through non-rendered website extraction. Lead Miner cannot treat that text as a visitor-facing defect or use it to justify a custom rebuild without independent material evidence.",
    confidence: Math.min(result.confidence, 0.5),
  } as T;
}
