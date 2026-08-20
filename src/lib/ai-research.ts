import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import { RESEARCH_EVIDENCE_SOURCES } from "./research-evidence-safety.js";
import {
  applyAssetFindingSafety,
  enforcePlaceholderQualificationSafety,
  isUnsupportedCrawlerReachabilityFinding,
} from "./asset-research-safety.js";
import { assessPerformance, type PerformanceAssessment } from "./performance-assessment.js";
import {
  fetchBusinessAssetResearchPacket,
  type BusinessAssetResearchPacket,
} from "./research-site-v10.js";

export type { WebsiteResearchPacket } from "./research-site.js";
export type { BusinessAssetResearchPacket } from "./research-site-v10.js";

const EvidenceSourceSchema = z.enum(RESEARCH_EVIDENCE_SOURCES);
const RatingSchema = z.enum(["strong", "adequate", "constrained", "weak", "unknown"]);
const DecisionSchema = z.enum(["rebuild_candidate", "no_material_opportunity", "needs_review"]);
const FindingCategorySchema = z.enum([
  "performance",
  "demand_alignment",
  "business_representation",
  "customer_action",
  "acquisition_readiness",
  "site_maturity",
  "content_depth",
  "objective_defect",
]);

const DimensionSchema = z.object({
  rating: RatingSchema,
  evidence: z.string().min(1),
  evidenceSources: z.array(EvidenceSourceSchema).min(1),
  confidence: z.number().min(0).max(1),
});

export const ResearchResultSchema = z.object({
  decision: DecisionSchema,
  assetStrength: RatingSchema,
  dimensions: z.object({
    performanceEffectiveness: DimensionSchema,
    demandAlignment: DimensionSchema,
    businessRepresentation: DimensionSchema,
    customerActionCapability: DimensionSchema,
    acquisitionReadiness: DimensionSchema,
    siteMaturity: DimensionSchema,
  }),
  findings: z.array(z.object({
    category: FindingCategorySchema,
    title: z.string().min(1),
    evidence: z.string().min(1),
    assetCapability: z.string().min(1),
    confidence: z.number().min(0).max(1),
    significance: z.enum(["low", "medium", "high"]),
    evidenceSources: z.array(EvidenceSourceSchema).min(1),
  })).max(8),
  researchSummary: z.string().min(1),
  decisionReason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type ResearchResult = z.infer<typeof ResearchResultSchema>;

export type ResearchLead = {
  businessName: string | null;
  domain: string;
  landingPageUrl: string;
  keyword: string;
  adSource: string;
  lighthouseScore: number | null;
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  enrichmentNotes: string | null;
  isAgencyManaged: boolean;
  agencyName: string | null;
  isNationalChain: boolean;
  chainReason: string | null;
};

export const RESEARCH_VERSION = "lead-research-v15";

function dimensionJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["rating", "evidence", "evidenceSources", "confidence"],
    properties: {
      rating: { type: "string", enum: ["strong", "adequate", "constrained", "weak", "unknown"] },
      evidence: { type: "string" },
      evidenceSources: { type: "array", minItems: 1, items: { type: "string", enum: [...RESEARCH_EVIDENCE_SOURCES] } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["decision", "assetStrength", "dimensions", "findings", "researchSummary", "decisionReason", "confidence"],
    properties: {
      decision: { type: "string", enum: ["rebuild_candidate", "no_material_opportunity", "needs_review"] },
      assetStrength: { type: "string", enum: ["strong", "adequate", "constrained", "weak", "unknown"] },
      dimensions: {
        type: "object",
        additionalProperties: false,
        required: ["performanceEffectiveness", "demandAlignment", "businessRepresentation", "customerActionCapability", "acquisitionReadiness", "siteMaturity"],
        properties: {
          performanceEffectiveness: dimensionJsonSchema(),
          demandAlignment: dimensionJsonSchema(),
          businessRepresentation: dimensionJsonSchema(),
          customerActionCapability: dimensionJsonSchema(),
          acquisitionReadiness: dimensionJsonSchema(),
          siteMaturity: dimensionJsonSchema(),
        },
      },
      findings: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["category", "title", "evidence", "assetCapability", "confidence", "significance", "evidenceSources"],
          properties: {
            category: { type: "string", enum: ["performance", "demand_alignment", "business_representation", "customer_action", "acquisition_readiness", "site_maturity", "content_depth", "objective_defect"] },
            title: { type: "string" },
            evidence: { type: "string" },
            assetCapability: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            significance: { type: "string", enum: ["low", "medium", "high"] },
            evidenceSources: { type: "array", minItems: 1, items: { type: "string", enum: [...RESEARCH_EVIDENCE_SOURCES] } },
          },
        },
      },
      researchSummary: { type: "string" },
      decisionReason: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

const HARD_RESEARCH_RULES = [
  "Treat the website as an observable business asset, not as a checklist of broken features.",
  "Lead Miner is qualifying opportunities for Brian Woodson's actual service: a new custom-coded website implementation built on Astro. Brian does not sell optimization, repair, maintenance, cleanup, or page-builder tuning on an existing implementation.",
  "The central qualification question is therefore whether the supplied evidence makes replacement with a new custom implementation a reasonable business option. If the evidence only supports improving the existing implementation, that is not a service opportunity for this pipeline.",
  "This is not a general website audit. Do not try to maximize the number of findings. Include only material capabilities or limitations that affect whether a custom rebuild is reasonably supported.",
  "Evidence gaps, crawler limitations, requests for manual validation, and unresolved questions are not material findings. Put uncertainty in the relevant dimension evidence, research summary, or decision reason.",
  "Keep research analytical and stage-pure. Do not discuss conversations, outreach, prospecting, pitching, messaging, sales approaches, or contacting the business.",
  "Use only supplied evidence. Never invent traffic, bounce rate, conversions, revenue, ad spend, customer behavior, budget, business plans, growth, rankings, security failures, maintainability costs, or functionality not established by the packet.",
  "Measured performance is pre-classified deterministically in performanceAssessment using Google ranges. Interpret its severity; do not redefine or recalculate the bands.",
  "Poor performance is evidence, not an automatic rebuild qualification. An isolated speed or responsiveness problem on an otherwise capable site should normally be NO_MATERIAL_OPPORTUNITY for this service because Brian is not selling performance optimization of the existing implementation.",
  "Severe performance may contribute to REBUILD_CANDIDATE when it is strong enough, or combines with other material limitations, to make replacement with a custom implementation reasonable. Do not turn a performance finding into an optimization recommendation.",
  "A Lead Miner crawler fetch failure is only an inspection failure. It is never proof that normal visitors cannot reach the website.",
  "Following a CTA or link with Lead Miner's HTTP crawler is not a rendered-browser interaction test. A crawler-only 404, redirect anomaly, fetch failure, or other response must be treated as diagnostic evidence only. Do not call a visitor-facing CTA, estimate path, booking path, quote path, link, or button broken, dead, unavailable, or nonfunctional unless rendered or interaction-capable evidence independently confirms it.",
  "Static representative-page extraction is not rendered presentation evidence. Do not claim that visitors see pricing, $0.00, store-style presentation, product-style presentation, cart controls, checkout controls, or similar commerce UI solely because those strings or structures appear in extracted HTML. A /store/p/ URL may be described only as URL or architecture structure, not as proof of visitor-visible store presentation or a material defect.",
  "Unverified crawler-interaction failures and unverified static-presentation artifacts must not support a constrained or weak capability rating, a material finding, the research summary, the decision reason, or REBUILD_CANDIDATE.",
  "providerScrapeEvidence is a current third-party extraction of the requested page. When succeeded is true, provider_scrape may support current page-topic, business-representation, demand-alignment, and content evidence. It is not a rendered browser and cannot prove forms, clicks, visual presentation, JavaScript-only interactions, complete navigation, or visitor reachability.",
  "If direct crawling fails but providerScrapeEvidence succeeds, do not describe the website as uninspected. State specifically that Lead Miner's direct TLS/HTTP crawler failed while current provider extraction succeeded.",
  "If direct crawling fails but searchIndexEvidence contains same-domain pages, use search_index only as bounded evidence about indexed page topics and apparent architecture. Search-index evidence may lag the live site.",
  "Do not create a customer-action deficiency solely from provider_scrape or search_index evidence. If the direct crawler did not inspect the live site, customerActionCapability should normally be unknown unless another supplied evidence source independently establishes it.",
  "Provider-scrape or search-index evidence by itself cannot support REBUILD_CANDIDATE. Direct measured performance may be combined with current provider extraction and substantial same-domain index evidence when multiple independent material limitations support a rebuild case. Unknown interactive capabilities must never be used as rebuild evidence.",
  "Enrichment notes describe Lead Miner's enrichment process and may contain historical crawler failures. They are not independent visitor-reachability evidence.",
  "Assess demand alignment semantically using the lead keyword and supplied website evidence. Exact keyword matching is not required.",
  "Assess business representation by how meaningfully the site explains the business and its apparent services. Do not require a particular number of pages.",
  "representativePages[].contentDepth is deterministic direct-page evidence. substantiveWordCount attempts to exclude common navigation, header, footer, form, and button chrome; wholePageWordCount is retained only for comparison. Use substantiveWordCount and the contextual contentDepth signal when judging service-page depth.",
  "Never label a page thin from word count alone. A short focused service page may still communicate its service adequately. Consider breadth of service topics, meaningful paragraphs, detail headings, useful list detail, and whether the page gives a prospective buyer enough service-specific information to understand and evaluate the offering.",
  "When contentDepthSummary.strongThinServicePages is greater than zero, include at least one content_depth finding unless an existing finding already describes the same directly observed content limitation. A strong signal means a sampled service page is trying to cover several materially different services with very little substantive detail; describe the observed page and numbers rather than making a site-wide claim.",
  "A contentDepth materialityHint of supporting or weak may support another finding but must not become a high-significance finding solely because the page is short. Thin content by itself does not automatically make a site a rebuild candidate; combine it with broader business-asset limitations when deciding whether replacement is reasonable.",
  "Do not confuse content depth with keyword matching. A broad Services page can be materially thin even when it mentions the target keyword, and a well-developed page can be substantively adequate without repeating the target keyword.",
  "Assess customer-action capability from explicit phone, email, form, contact/request, quote, estimate, booking, scheduling, or other action paths. No particular contact method is required.",
  "If contactSignals.hasForm is true, never claim that the site or contact flow lacks a form. If it is false, static HTML may still miss JavaScript-rendered forms, so do not make a site-wide missing-form claim.",
  "siteCoverage and representativePages are bounded. architectureEvidenceComplete is false by design. Never treat absence from the packet as proof of site-wide absence.",
  "Never say visitors can see content supported only by dom_heading or dom_text.",
  "Wrong-company or unrelated-industry contamination requires strong current corroboration before it can be high confidence or high significance.",
  "Lorem ipsum, placeholder, demo, or sample content found in static HTML, representative-page extraction, provider extraction, or search-index evidence is visibility-unverified. It cannot by itself support REBUILD_CANDIDATE or a prospect-facing claim. Treat it as low significance unless an independent rendered-visibility-capable signal establishes that normal visitors actually see it.",
  "Paid advertising is acquisition context, not a defect or rebuild reason. Never invent spend or waste amounts.",
  "Do not penalize a site merely for lacking a blog, FAQs, testimonials, live chat, online booking, displayed pricing, location pages, individual service pages, schema markup, or a specific CTA type. This rule does not excuse a directly sampled broad service page that provides materially too little information about the services it claims to cover.",
  "Do not use aesthetic preference, 'dated' appearance by itself, generic modernization, CRO ideas, or optional best practices as rebuild qualification.",
  "Several meaningful limitations may combine into a substantial business-asset gap even when nothing is technically broken.",
  "REBUILD_CANDIDATE means direct or strongly corroborated evidence shows multiple material limitations across the business asset, or a severe structural limitation, such that replacing the current implementation with a new custom Astro site is a reasonable business option. The current site does not need to be completely broken.",
  "NO_MATERIAL_OPPORTUNITY means the evidence does not support a custom rebuild strongly enough for Brian's offer. Use this when the site is fundamentally capable and the meaningful remedy would only be optimization, maintenance, page-builder tuning, plugin/configuration work, content cleanup, or another isolated repair to the existing implementation.",
  "A narrow housekeeping issue such as changing contact text, replacing a placeholder email, fixing a typo, changing one label, or another small content/configuration edit is NO_MATERIAL_OPPORTUNITY unless broader supplied evidence independently establishes a rebuild-level opportunity.",
  "NEEDS_REVIEW means the evidence is too incomplete or conflicting to establish either a custom rebuild opportunity or no material opportunity safely.",
  "Do not recommend or classify an optimization engagement. There is intentionally no optimization-qualified outcome in this system.",
  "Identify both the strongest capabilities and the most important limitations in the research summary.",
  "Research does not choose an outreach angle, estimate ability to pay, assign sales urgency, or recommend messaging.",
  "Every dimension and finding must list the exact evidenceSources used. Use representative_page for sampled direct page summaries and deterministic content-depth signals, provider_scrape for current provider-extracted page text, search_index for indexed first-party titles/snippets, and site_coverage for bounded crawl/sitemap evidence.",
  "Return only the required structured result.",
].join(" ");

const EVIDENCE_GAP_SOURCES = new Set(["site_coverage", "search_index", "contact_signal"]);
const EVIDENCE_GAP_LANGUAGE = /requires?\s+(?:live|manual)?\s*validation|cannot be verified|could not be verified|unable to verify|evidence gap|direct (?:inspection|crawler)[\s\S]{0,60}(?:failed|could not)|crawler[\s\S]{0,60}(?:failed|could not)|requires?[\s\S]{0,40}(?:manual|live) review/i;

function isEvidenceGapFinding(finding: ResearchResult["findings"][number]) {
  const uncertaintyOnlySources = finding.evidenceSources.length > 0
    && finding.evidenceSources.every((source) => EVIDENCE_GAP_SOURCES.has(source));
  if (!uncertaintyOnlySources) return false;
  return EVIDENCE_GAP_LANGUAGE.test(`${finding.title} ${finding.evidence} ${finding.assetCapability}`);
}

function sanitizeResearchNarrative(value: string) {
  return value
    .replace(/\bjustify\s+(?:a\s+)?conversation about\b/gi, "support further evaluation of")
    .replace(/\bsupports?\s+(?:a\s+)?conversation about\b/gi, "supports further evaluation of")
    .replace(/\bwarrants?\s+(?:a\s+)?conversation about\b/gi, "warrants further evaluation of")
    .replace(/\bworth\s+(?:a\s+)?conversation\b/gi, "material enough for further evaluation")
    .replace(/\bconversation about\b/gi, "evaluation of")
    .replace(/\boptimization candidate\b/gi, "no material opportunity for the custom-rebuild offer")
    .replace(/\boptimization engagement\b/gi, "existing-site optimization work");
}

function capDimension(dimension: ResearchResult["dimensions"]["demandAlignment"], source: "provider_scrape" | "search_index") {
  if (!dimension.evidenceSources.includes(source)) return dimension;
  return { ...dimension, confidence: Math.min(dimension.confidence, source === "provider_scrape" ? 0.8 : 0.65) };
}

function capFallbackFinding(finding: ResearchResult["findings"][number]) {
  const hasProvider = finding.evidenceSources.includes("provider_scrape");
  const hasDirect = finding.evidenceSources.some((source) => ["title", "meta_description", "navigation", "cta", "contact_signal", "architecture", "representative_page", "performance"].includes(source));
  if (!hasProvider || hasDirect) return finding;
  return {
    ...finding,
    confidence: Math.min(finding.confidence, 0.8),
    significance: finding.significance === "high" ? "medium" as const : finding.significance,
  };
}

function unknownDimension(label: string): ResearchResult["dimensions"]["demandAlignment"] {
  return {
    rating: "unknown",
    evidence: `Lead Miner's direct crawler could not inspect enough current website content to assess ${label} reliably. Provider extraction and search-index evidence are not sufficient for this interactive capability.`,
    evidenceSources: ["site_coverage"],
    confidence: 0.2,
  };
}

function hasMaterialPerformanceConstraint(performanceAssessment: PerformanceAssessment) {
  return performanceAssessment.lcpBand === "poor" || performanceAssessment.poorMetricCount >= 2;
}

function materialFindings(result: ResearchResult) {
  return result.findings.filter((finding) => finding.confidence >= 0.7 && finding.significance !== "low");
}

function supportsFallbackRebuild(
  result: ResearchResult,
  providerAvailable: boolean,
  indexedAvailable: boolean,
  performanceAssessment: PerformanceAssessment,
) {
  if (result.decision !== "rebuild_candidate" || result.assetStrength !== "weak" || result.confidence < 0.7) return false;
  if (!providerAvailable || !indexedAvailable || !hasMaterialPerformanceConstraint(performanceAssessment)) return false;
  const material = materialFindings(result);
  const categories = new Set(material.map((finding) => finding.category));
  const hasNonPerformanceFinding = material.some((finding) => finding.category !== "performance");
  return material.length >= 2 && categories.size >= 2 && hasNonPerformanceFinding;
}

export function applyCrawlerFailureSafety(
  result: ResearchResult,
  website: BusinessAssetResearchPacket,
  performanceAssessment: PerformanceAssessment,
): ResearchResult {
  const safetyAdjusted: ResearchResult = {
    ...result,
    researchSummary: sanitizeResearchNarrative(result.researchSummary),
    decisionReason: sanitizeResearchNarrative(result.decisionReason),
    findings: result.findings
      .map(applyAssetFindingSafety)
      .map(capFallbackFinding)
      .filter((finding) => !isUnsupportedCrawlerReachabilityFinding(finding))
      .filter((finding) => !isEvidenceGapFinding(finding)),
  };
  const safeBase = enforcePlaceholderQualificationSafety(safetyAdjusted) as ResearchResult;

  if (website.finalUrl && !website.fetchError) return safeBase;

  const providerAvailable = Boolean(website.providerScrapeEvidence?.succeeded && website.providerScrapeEvidence.wordCount >= 40);
  const indexedAvailable = website.searchIndexEvidence.succeeded && website.searchIndexEvidence.pages.length >= 3;

  if (providerAvailable) {
    const preserveRebuild = supportsFallbackRebuild(safeBase, providerAvailable, indexedAvailable, performanceAssessment);
    const downgradeRebuild = safeBase.decision === "rebuild_candidate" && !preserveRebuild;
    return {
      ...safeBase,
      decision: downgradeRebuild ? "needs_review" : safeBase.decision,
      assetStrength: downgradeRebuild ? "unknown" : safeBase.assetStrength,
      dimensions: {
        ...safeBase.dimensions,
        demandAlignment: capDimension(safeBase.dimensions.demandAlignment, "provider_scrape"),
        businessRepresentation: capDimension(safeBase.dimensions.businessRepresentation, "provider_scrape"),
        customerActionCapability: unknownDimension("customer-action capability"),
        acquisitionReadiness: capDimension(safeBase.dimensions.acquisitionReadiness, "provider_scrape"),
        siteMaturity: indexedAvailable
          ? capDimension(safeBase.dimensions.siteMaturity, "search_index")
          : capDimension(safeBase.dimensions.siteMaturity, "provider_scrape"),
      },
      decisionReason: downgradeRebuild
        ? "Needs review because fallback evidence shows possible material limitations, but it does not establish enough independent current evidence to justify replacing the existing site with a custom rebuild safely. Existing-site optimization is outside the service being qualified."
        : safeBase.decisionReason,
      confidence: Math.min(safeBase.confidence, 0.8),
    };
  }

  if (indexedAvailable) {
    const downgradeRebuild = safeBase.decision === "rebuild_candidate";
    return {
      ...safeBase,
      decision: downgradeRebuild ? "needs_review" : safeBase.decision,
      assetStrength: downgradeRebuild ? "unknown" : safeBase.assetStrength,
      dimensions: {
        ...safeBase.dimensions,
        demandAlignment: capDimension(safeBase.dimensions.demandAlignment, "search_index"),
        businessRepresentation: capDimension(safeBase.dimensions.businessRepresentation, "search_index"),
        customerActionCapability: unknownDimension("customer-action capability"),
        acquisitionReadiness: capDimension(safeBase.dimensions.acquisitionReadiness, "search_index"),
        siteMaturity: capDimension(safeBase.dimensions.siteMaturity, "search_index"),
      },
      decisionReason: downgradeRebuild
        ? "Needs review because same-domain index evidence and direct performance measurements do not establish enough current website evidence to justify a custom rebuild. Existing-site optimization is outside the service being qualified."
        : safeBase.decisionReason,
      confidence: Math.min(safeBase.confidence, 0.65),
    };
  }

  return {
    ...safeBase,
    decision: "needs_review",
    assetStrength: "unknown",
    dimensions: {
      ...safeBase.dimensions,
      demandAlignment: unknownDimension("demand alignment"),
      businessRepresentation: unknownDimension("business representation"),
      customerActionCapability: unknownDimension("customer-action capability"),
      acquisitionReadiness: unknownDimension("acquisition readiness"),
      siteMaturity: unknownDimension("site maturity"),
    },
    researchSummary: "Lead Miner could not inspect enough current website content through its direct crawler, live provider extraction, or same-domain search-index fallback. The measured performance evidence remains available, but the other business-asset dimensions require review.",
    decisionReason: "Needs review because the available website evidence was insufficient to determine whether a custom rebuild is justified.",
    confidence: Math.min(safeBase.confidence, 0.35),
  };
}

export async function researchLead(
  lead: ResearchLead,
  model: string,
  editableInstructions: string,
): Promise<{
  result: ResearchResult;
  performanceAssessment: PerformanceAssessment;
  website: BusinessAssetResearchPacket;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const performanceAssessment = assessPerformance(lead);
  const website = await fetchBusinessAssetResearchPacket(lead.landingPageUrl);
  const evidence = { lead, performanceAssessment, website };
  const systemInstructions = `${editableInstructions.trim()}\n\nNon-editable system rules:\n${HARD_RESEARCH_RULES}`;
  const response = await fetchWithProviderBackoff(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemInstructions }] },
          { role: "user", content: [{ type: "input_text", text: `Assess this Lead Miner evidence packet for a custom Astro rebuild opportunity:\n${JSON.stringify(evidence)}` }] },
        ],
        text: { format: { type: "json_schema", name: "business_asset_research", strict: true, schema: jsonSchema() } },
      }),
    },
    "OpenAI business asset research",
  );

  if (!response.ok) throw new Error(`OpenAI research failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((output: any) => output.content ?? []).find((content: any) => content.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no structured research output");

  const parsed = ResearchResultSchema.parse(JSON.parse(raw));
  const result = applyCrawlerFailureSafety(parsed, website, performanceAssessment);

  return {
    result,
    performanceAssessment,
    website,
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
