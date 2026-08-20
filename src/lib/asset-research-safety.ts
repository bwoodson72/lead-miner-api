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
const ACTION_TERM = "(?:cta|call[ -]?to[ -]?action|estimate|quote|book(?:ing)?|consult(?:ation)?|appointment|request|link|destination|path|button)";
const FAILURE_TERM = "(?:http\\s*)?404|returned\\s+(?:http\\s*)?404|broken|dead|fails?|failed|failure|not working|unavailable";
const UNVERIFIED_CRAWLER_ACTION_FAILURE = new RegExp(`\\b${ACTION_TERM}\\b[\\s\\S]{0,120}\\b(?:${FAILURE_TERM})\\b|\\b(?:${FAILURE_TERM})\\b[\\s\\S]{0,120}\\b${ACTION_TERM}\\b`, "i");
const UNVERIFIED_STATIC_PRESENTATION = /\$\s*0(?:\.00)?\b|\/store\/p\/|\bstore[- ]style\b|\bproduct[- ]style\b|\b(?:display|show|present)(?:s|ed|ing)?\b[\s\S]{0,50}\b(?:price|pricing|\$0)\b|\b(?:price|pricing)\b[\s\S]{0,50}\b(?:display|show|visible)\b/i;
const ACTION_EVIDENCE_SOURCES = new Set<ResearchEvidenceSource>(["cta", "contact_signal", "site_coverage", "representative_page"]);
const STATIC_PRESENTATION_SOURCES = new Set<ResearchEvidenceSource>(["representative_page", "dom_text", "dom_heading", "provider_scrape", "architecture", "site_coverage"]);

function lowerSignificance(value: AssetFinding["significance"], ceiling: "low" | "medium") {
  if (ceiling === "low") return "low" as const;
  return value === "high" ? "medium" as const : value;
}

function claimText(finding: AssetFinding) {
  return `${finding.category} ${finding.title} ${finding.evidence} ${finding.assetCapability}`;
}

function domOnly(finding: AssetFinding) {
  return finding.evidenceSources.length > 0 && finding.evidenceSources.every((source) => UNVERIFIED_DOM_SOURCES.has(source));
}

function searchIndexOnly(finding: AssetFinding) {
  const allowed = new Set<ResearchEvidenceSource>(["search_index", "site_coverage"]);
  return finding.evidenceSources.includes("search_index") && finding.evidenceSources.every((source) => allowed.has(source));
}

function hasEvidenceSource(finding: AssetFinding, allowed: Set<ResearchEvidenceSource>) {
  return finding.evidenceSources.some((source) => allowed.has(source));
}

export function containsUnsupportedVisitorReachabilityClaim(value: string | null | undefined) {
  return Boolean(value && UNSUPPORTED_VISITOR_REACHABILITY.test(value));
}

export function containsUnverifiedPlaceholderContent(value: string | null | undefined) {
  return Boolean(value && UNVERIFIED_PLACEHOLDER_CONTENT.test(value));
}

export function containsUnverifiedCrawlerActionFailure(value: string | null | undefined) {
  return Boolean(value && UNVERIFIED_CRAWLER_ACTION_FAILURE.test(value));
}

export function containsUnverifiedStaticPresentation(value: string | null | undefined) {
  return Boolean(value && UNVERIFIED_STATIC_PRESENTATION.test(value));
}

export function isUnsupportedCrawlerReachabilityFinding(finding: AssetFinding) {
  return containsUnsupportedVisitorReachabilityClaim(claimText(finding));
}

export function isUnverifiedPlaceholderFinding(finding: AssetFinding) {
  return containsUnverifiedPlaceholderContent(claimText(finding));
}

export function isUnverifiedCrawlerActionFailureFinding(finding: AssetFinding) {
  return hasEvidenceSource(finding, ACTION_EVIDENCE_SOURCES)
    && containsUnverifiedCrawlerActionFailure(claimText(finding));
}

export function isUnverifiedStaticPresentationFinding(finding: AssetFinding) {
  return hasEvidenceSource(finding, STATIC_PRESENTATION_SOURCES)
    && containsUnverifiedStaticPresentation(claimText(finding));
}

export function isUnverifiedVisitorFacingFinding(finding: AssetFinding) {
  return isUnverifiedCrawlerActionFailureFinding(finding) || isUnverifiedStaticPresentationFinding(finding);
}

export function applyAssetFindingSafety<T extends AssetFinding>(finding: T): T {
  const claim = claimText(finding);
  if (isUnsupportedCrawlerReachabilityFinding(finding)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.1),
      significance: lowerSignificance(finding.significance, "low"),
    };
  }
  if (isUnverifiedVisitorFacingFinding(finding)) {
    return {
      ...finding,
      confidence: Math.min(finding.confidence, 0.2),
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

function containsUnverifiedVisitorClaim(value: string) {
  return containsUnverifiedCrawlerActionFailure(value) || containsUnverifiedStaticPresentation(value);
}

function stripUnverifiedVisitorClaims(value: string) {
  const sentences = value.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const kept = sentences.filter((sentence) => !containsUnverifiedVisitorClaim(sentence)).join(" ").trim();
  return kept;
}

function dimensionsContainUnverifiedVisitorClaim(dimensions: unknown) {
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) return false;
  return Object.values(dimensions as Record<string, unknown>).some((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const evidence = (raw as Record<string, unknown>).evidence;
    return typeof evidence === "string" && containsUnverifiedVisitorClaim(evidence);
  });
}

function sanitizeDimensions(dimensions: unknown) {
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) return dimensions;
  const entries = Object.entries(dimensions as Record<string, unknown>).map(([key, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [key, raw] as const;
    const row = raw as Record<string, unknown>;
    if (typeof row.evidence !== "string" || !containsUnverifiedVisitorClaim(row.evidence)) return [key, raw] as const;
    const evidence = stripUnverifiedVisitorClaims(row.evidence)
      || "The supplied non-rendered evidence does not establish this visitor-facing limitation.";
    return [key, {
      ...row,
      evidence,
      confidence: typeof row.confidence === "number" ? Math.min(row.confidence, 0.5) : row.confidence,
      rating: evidence.startsWith("The supplied non-rendered evidence") ? "unknown" : row.rating,
    }] as const;
  });
  return Object.fromEntries(entries);
}

function materialFindings(findings: AssetFinding[]) {
  return findings.filter((finding) => finding.confidence >= 0.7 && finding.significance !== "low");
}

function hasEnoughMaterialEvidenceForRebuild(findings: AssetFinding[]) {
  const material = materialFindings(findings);
  const categories = new Set(material.map((finding) => finding.category));
  const multipleIndependent = material.length >= 2
    && categories.size >= 2
    && material.some((finding) => finding.category !== "performance");
  const severeStructural = material.some((finding) =>
    finding.category === "objective_defect"
    && finding.significance === "high"
    && finding.confidence >= 0.9,
  );
  return multipleIndependent || severeStructural;
}

function materialReason(findings: AssetFinding[]) {
  const titles = materialFindings(findings).slice(0, 3).map((finding) => finding.title);
  return titles.length ? titles.join("; ") : "the remaining verified evidence";
}

export function enforcePlaceholderQualificationSafety<T extends {
  decision: string;
  assetStrength: string;
  findings: AssetFinding[];
  decisionReason: string;
  confidence: number;
  researchSummary?: string;
  dimensions?: unknown;
}>(result: T): T {
  const findingHadUnsupportedClaim = result.findings.some(isUnverifiedVisitorFacingFinding);
  const findings = result.findings.filter((finding) => !isUnverifiedVisitorFacingFinding(finding));
  const summaryHadUnsupportedClaim = typeof result.researchSummary === "string"
    && containsUnverifiedVisitorClaim(result.researchSummary);
  const reasonHadUnsupportedClaim = containsUnverifiedVisitorClaim(result.decisionReason);
  const dimensionHadUnsupportedClaim = dimensionsContainUnverifiedVisitorClaim(result.dimensions);
  const visitorSafetyChanged = findingHadUnsupportedClaim
    || summaryHadUnsupportedClaim
    || reasonHadUnsupportedClaim
    || dimensionHadUnsupportedClaim;
  const researchSummary = typeof result.researchSummary === "string"
    ? (stripUnverifiedVisitorClaims(result.researchSummary)
      || `The assessment retains ${findings.length} finding(s) supported after visitor-visibility evidence filtering.`)
    : undefined;
  let decisionReason = stripUnverifiedVisitorClaims(result.decisionReason) || result.decisionReason;

  const base = {
    ...result,
    findings,
    decisionReason,
    ...(researchSummary !== undefined ? { researchSummary } : {}),
    ...(result.dimensions !== undefined ? { dimensions: sanitizeDimensions(result.dimensions) } : {}),
  } as T;

  if (base.decision !== "rebuild_candidate") return base;

  const hasPlaceholderFinding = base.findings.some(isUnverifiedPlaceholderFinding);
  const independentlyMaterial = base.findings.some((finding) =>
    !isUnverifiedPlaceholderFinding(finding)
    && finding.confidence >= 0.7
    && finding.significance !== "low",
  );

  if (hasPlaceholderFinding && !independentlyMaterial) {
    return {
      ...base,
      decision: "needs_review",
      assetStrength: "unknown",
      decisionReason: "Needs review because placeholder or demo text was detected only through non-rendered website extraction. Lead Miner cannot treat that text as a visitor-facing defect or use it to justify a custom rebuild without independent material evidence.",
      confidence: Math.min(base.confidence, 0.5),
    } as T;
  }

  if (visitorSafetyChanged && !hasEnoughMaterialEvidenceForRebuild(base.findings)) {
    return {
      ...base,
      decision: "needs_review",
      assetStrength: "unknown",
      decisionReason: "Needs review because evidence-safety filtering removed or downgraded unsupported visitor-facing observations, leaving insufficient independent material evidence to justify a custom rebuild.",
      confidence: Math.min(base.confidence, 0.65),
    } as T;
  }

  if (visitorSafetyChanged && (summaryHadUnsupportedClaim || reasonHadUnsupportedClaim)) {
    decisionReason = `REBUILD_CANDIDATE remains supported after evidence-safety filtering by ${materialReason(base.findings)}.`;
    return { ...base, decisionReason } as T;
  }

  return base;
}
