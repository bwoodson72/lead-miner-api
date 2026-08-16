import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import { RESEARCH_EVIDENCE_SOURCES } from "./research-evidence-safety.js";
import { applyAssetFindingSafety } from "./asset-research-safety.js";
import { assessPerformance, type PerformanceAssessment } from "./performance-assessment.js";
import {
  fetchBusinessAssetResearchPacket,
  type BusinessAssetResearchPacket,
} from "./research-site-v6.js";

export type { WebsiteResearchPacket } from "./research-site.js";
export type { BusinessAssetResearchPacket } from "./research-site-v6.js";

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

export const RESEARCH_VERSION = "lead-research-v6";

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
  "Use only supplied evidence. Never invent traffic, bounce rate, conversions, revenue, ad spend, customer behavior, budget, business plans, growth, rankings, security failures, maintainability costs, or functionality not established by the packet.",
  "Measured performance is pre-classified deterministically in performanceAssessment using Google ranges. Interpret its severity; do not redefine or recalculate the bands.",
  "A severe performance signal can materially constrain the website as an acquisition asset and may independently make rebuild consideration reasonable. Poor performance does not automatically require a rebuild when the rest of the asset appears substantial and capable.",
  "Assess demand alignment semantically using the lead keyword and supplied website evidence. Exact keyword matching is not required.",
  "Assess business representation by how meaningfully the site explains the business and its apparent services. Do not require a particular number of pages or assume every service needs its own page.",
  "Assess customer-action capability from explicit phone, email, form, contact/request, quote, estimate, booking, scheduling, or other action paths. No particular contact method is required.",
  "If contactSignals.hasForm is true, never claim that the site or contact flow lacks a form. If it is false, static HTML may still miss JavaScript-rendered forms, so do not make a site-wide missing-form claim.",
  "siteCoverage and representativePages improve architecture evidence but are still a bounded sample. architectureEvidenceComplete is false by design. Never treat absence from the packet as proof of site-wide absence.",
  "Never say visitors can see content supported only by dom_heading or dom_text. Static HTML can contain hidden, off-canvas, responsive-hidden, slider-clone, or stale template DOM.",
  "Wrong-company, unrelated-industry, placeholder, or template contamination findings require visitor-facing corroboration such as title, navigation, CTA, destination domain behavior, or representative-page evidence before they can be high confidence or high significance.",
  "Paid advertising is acquisition context, not a defect or rebuild reason. If adSource indicates paid traffic, use it only to judge whether the observed asset appears adequately equipped to receive traffic being actively acquired. Never invent spend or waste amounts.",
  "Do not penalize a site merely for lacking a blog, FAQs, testimonials, live chat, online booking, displayed pricing, location pages, individual service pages, schema markup, or a specific CTA type.",
  "Do not use aesthetic preference, 'dated' appearance by itself, generic modernization, CRO ideas, or optional best practices as rebuild qualification.",
  "Several meaningful limitations may combine into a substantial business-asset gap even when nothing is technically broken.",
  "REBUILD_CANDIDATE means the observable capability gap is substantial enough that a new implementation is a reasonable option. OPTIMIZATION_CANDIDATE means the asset appears fundamentally capable but has material fixable limitations that do not clearly justify replacement. NO_MATERIAL_OPPORTUNITY means the supplied evidence does not show a meaningful enough gap to pursue a rebuild. NEEDS_REVIEW means the evidence is too incomplete or conflicting to choose safely.",
  "Identify both the strongest capabilities and the most important limitations in the research summary. Distinguish isolated weaknesses from cumulative asset inadequacy.",
  "Research does not choose an outreach angle, estimate ability to pay, assign sales urgency, or recommend messaging. Those belong to later pipeline stages.",
  "Every dimension and finding must list the exact evidenceSources used. Use representative_page for sampled page summaries and site_coverage for bounded crawl/sitemap evidence.",
  "Return only the required structured result.",
].join(" ");

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
  const findings = parsed.findings.map(applyAssetFindingSafety);

  return {
    result: { ...parsed, findings },
    performanceAssessment,
    website,
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
