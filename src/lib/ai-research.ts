import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import { RESEARCH_EVIDENCE_SOURCES } from "./research-evidence-safety.js";
import {
  applyAssetFindingSafety,
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
const DecisionSchema = z.enum(["rebuild_candidate", "optimization_candidate", "no_material_opportunity", "needs_review"]);
const FindingCategorySchema = z.enum([
  "performance",
  "demand_alignment",
  "business_representation",
  "customer_action",
  "acquisition_readiness",
  "site_maturity",
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
  lighthouseScore: number;
  lcp: number;
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

export const RESEARCH_VERSION = "lead-research-v11";

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
      decision: { type: "string", enum: ["rebuild_candidate", "optimization_candidate", "no_material_opportunity", "needs_review"] },
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
            category: { type: "string", enum: ["performance", "demand_alignment", "business_representation", "customer_action", "acquisition_readiness", "site_maturity", "objective_defect"] },
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
  "The central question is whether the supplied evidence shows a sufficiently capable customer-acquisition and business-development asset for the business represented, or a meaningful enough capability gap that a rebuild is reasonable.",
  "This is not a general website audit. Do not try to maximize the number of findings. Include only material capabilities or limitations that affect the final assessment.",
  "Evidence gaps, crawler limitations, requests for manual validation, and unresolved questions are not material findings. Put uncertainty in the relevant dimension evidence, research summary, or decision reason.",
  "Keep research analytical and stage-pure. Do not discuss conversations, outreach, prospecting, pitching, messaging, sales approaches, or contacting the business.",
  "Use only supplied evidence. Never invent traffic, bounce rate, conversions, revenue, ad spend, customer behavior, budget, business plans, growth, rankings, security failures, maintainability costs, or functionality not established by the packet.",
  "Measured performance is pre-classified deterministically in performanceAssessment using Google ranges. Interpret its severity; do not redefine or recalculate the bands.",
  "Poor performance is evidence, not an automatic qualification floor. Do not default to OPTIMIZATION_CANDIDATE merely because one or more performance metrics are poor; assess whether the overall limitation is material enough to justify a meaningful web-development engagement.",
  "A severe performance signal can materially constrain the website as an acquisition asset and may independently support optimization when the severity is meaningful.",
  "A Lead Miner crawler fetch failure is only an inspection failure. It is never proof that normal visitors cannot reach the website.",
  "providerScrapeEvidence is a current third-party extraction of the requested page. When succeeded is true, provider_scrape may support current page-topic, business-representation, demand-alignment, and content evidence. It is not a rendered browser and cannot prove forms, clicks, visual presentation, JavaScript-only interactions, complete navigation, or visitor reachability.",
  "If direct crawling fails but providerScrapeEvidence succeeds, do not describe the website as uninspected. State specifically that Lead Miner's direct TLS/HTTP crawler failed while current provider extraction succeeded.",
  "If direct crawling fails but searchIndexEvidence contains same-domain pages, use search_index only as bounded evidence about indexed page topics and apparent architecture. Search-index evidence may lag the live site.",
  "Do not create a customer-action deficiency solely from provider_scrape or search_index evidence. If the direct crawler did not inspect the live site, customerActionCapability should normally be unknown unless another supplied evidence source independently establishes it.",
  "Provider-scrape or search-index evidence by itself cannot support REBUILD_CANDIDATE. Direct measured performance may be combined with current provider extraction and substantial same-domain index evidence when multiple independent material limitations support an asset-level rebuild case. Unknown interactive capabilities must never be used as rebuild evidence.",
  "Enrichment notes describe Lead Miner's enrichment process and may contain historical crawler failures. They are not independent visitor-reachability evidence.",
  "Assess demand alignment semantically using the lead keyword and supplied website evidence. Exact keyword matching is not required.",
  "Assess business representation by how meaningfully the site explains the business and its apparent services. Do not require a particular number of pages.",
  "Assess customer-action capability from explicit phone, email, form, contact/request, quote, estimate, booking, scheduling, or other action paths. No particular contact method is required.",
  "If contactSignals.hasForm is true, never claim that the site or contact flow lacks a form. If it is false, static HTML may still miss JavaScript-rendered forms, so do not make a site-wide missing-form claim.",
  "siteCoverage and representativePages are bounded. architectureEvidenceComplete is false by design. Never treat absence from the packet as proof of site-wide absence.",
  "Never say visitors can see content supported only by dom_heading or dom_text.",
  "Wrong-company, unrelated-industry, placeholder, or template contamination findings require visitor-facing corroboration before they can be high confidence or high significance.",
  "Paid advertising is acquisition context, not a defect or rebuild reason. Never invent spend or waste amounts.",
  "Do not penalize a site merely for lacking a blog, FAQs, testimonials, live chat, online booking, displayed pricing, location pages, individual service pages, schema markup, or a specific CTA type.",
  "Do not use aesthetic preference, 'dated' appearance by itself, generic modernization, CRO ideas, or optional best practices as rebuild qualification.",
  "Several meaningful limitations may combine into a substantial business-asset gap even when nothing is technically broken.",
  "REBUILD_CANDIDATE means direct or strongly corroborated evidence shows multiple material limitations across the business asset, or a severe structural limitation, such that a new implementation is a reasonable alternative to piecemeal repairs. It should not require the existing site to be completely broken.",
  "OPTIMIZATION_CANDIDATE means the asset is fundamentally capable but has one or more material limitations substantial enough to justify a meaningful optimization/development engagement without replacing the implementation.",
  "A trivial housekeeping task is not an optimization opportunity for Lead Miner. If the only meaningful remedy is changing contact text, replacing a placeholder email, fixing a typo, changing one label, or another small content/configuration edit, choose NO_MATERIAL_OPPORTUNITY unless broader supplied evidence independently establishes a material web-development opportunity.",
  "NO_MATERIAL_OPPORTUNITY means the supplied evidence does not show a meaningful enough web-development opportunity, including cases where the only observed issue is a narrow housekeeping fix.",
  "NEEDS_REVIEW means the evidence is too incomplete or conflicting to establish a rebuild, material optimization, or no-opportunity classification safely.",
  "When choosing between rebuild and optimization, ask whether the observed limitations are isolated fixes on an otherwise capable asset or whether they combine into an asset-level gap. Do not systematically prefer optimization simply because individual fixes are imaginable.",
  "Identify both the strongest capabilities and the most important limitations in the research summary.",
  "Research does not choose an outreach angle, estimate ability to pay, assign sales urgency, or recommend messaging.",
  "Every dimension and finding must list the exact evidenceSources used. Use representative_page for sampled direct page summaries, provider_scrape for current provider-extracted page text, search_index for indexed first-party titles/snippets, and site_coverage for bounded crawl/sitemap evidence.",
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
    .replace(/\bconversation about\b/gi, "evaluation of");
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

function constrainedDimensionCount(result: ResearchResult) {
  return Object.values(result.dimensions).filter((dimension) => dimension.rating === "weak" || dimension.rating === "constrained").length;
}

function calibrateDirectDecision(result: ResearchResult): ResearchResult {
  if (result.decision !== "optimization_candidate" || result.assetStrength !== "weak" || result.confidence < 0.7) return result;
  const material = materialFindings(result);
  const categories = new Set(material.map((finding) => finding.category));
  const highCount = material.filter((finding) => finding.significance === "high").length;
  if (material.length < 2 || categories.size < 2 || highCount < 1 || constrainedDimensionCount(result) < 3) return result;
  return {
    ...result,
    decision: "rebuild_candidate",
    decisionReason: "Rebuild candidate because direct website inspection shows multiple material limitations across distinct business-asset dimensions, including at least one high-significance limitation, and the overall asset is assessed as weak. The evidence supports evaluating replacement rather than treating the opportunity as a set of isolated optimizations.",
  };
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
  const safeBase: ResearchResult = {
    ...result,
    researchSummary: sanitizeResearchNarrative(result.researchSummary),
    decisionReason: sanitizeResearchNarrative(result.decisionReason),
    findings: result.findings
      .map(applyAssetFindingSafety)
      .map(capFallbackFinding)
      .filter((finding) => !isUnsupportedCrawlerReachabilityFinding(finding))
      .filter((finding) => !isEvidenceGapFinding(finding)),
  };

  if (website.finalUrl && !website.fetchError) return calibrateDirectDecision(safeBase);

  const providerAvailable = Boolean(website.providerScrapeEvidence?.succeeded && website.providerScrapeEvidence.wordCount >= 40);
  const indexedAvailable = website.searchIndexEvidence.succeeded && website.searchIndexEvidence.pages.length >= 3;

  if (providerAvailable) {
    const preserveRebuild = supportsFallbackRebuild(safeBase, providerAvailable, indexedAvailable, performanceAssessment);
    const downgradeRebuild = safeBase.decision === "rebuild_candidate" && !preserveRebuild;
    return {
      ...safeBase,
      decision: downgradeRebuild ? "optimization_candidate" : safeBase.decision,
      assetStrength: downgradeRebuild ? "constrained" : safeBase.assetStrength,
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
        ? "Optimization candidate because the model identified a rebuild-level concern, but the available fallback evidence does not establish enough independent current limitations to support replacement safely. Current provider extraction still supports a material optimization assessment."
        : safeBase.decisionReason,
      confidence: Math.min(safeBase.confidence, 0.8),
    };
  }

  if (indexedAvailable) {
    const downgradeRebuild = safeBase.decision === "rebuild_candidate";
    return {
      ...safeBase,
      decision: downgradeRebuild ? "optimization_candidate" : safeBase.decision,
      assetStrength: downgradeRebuild ? "constrained" : safeBase.assetStrength,
      dimensions: {
        ...safeBase.dimensions,
        demandAlignment: capDimension(safeBase.dimensions.demandAlignment, "search_index"),
        businessRepresentation: capDimension(safeBase.dimensions.businessRepresentation, "search_index"),
        customerActionCapability: unknownDimension("customer-action capability"),
        acquisitionReadiness: capDimension(safeBase.dimensions.acquisitionReadiness, "search_index"),
        siteMaturity: capDimension(safeBase.dimensions.siteMaturity, "search_index"),
      },
      decisionReason: downgradeRebuild
        ? "Optimization candidate because same-domain index evidence and direct performance measurements can establish a material limitation, but index evidence alone is not strong enough to support a rebuild conclusion."
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
    decisionReason: "Needs review because the available website evidence was insufficient for a reliable business-asset classification.",
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
          { role: "user", content: [{ type: "input_text", text: `Assess this Lead Miner evidence packet as a business asset:\n${JSON.stringify(evidence)}` }] },
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
