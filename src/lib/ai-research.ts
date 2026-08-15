import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import {
  applyResearchEvidenceSafety,
  RESEARCH_EVIDENCE_SOURCES,
  sanitizePrimaryOutreachAngle,
} from "./research-evidence-safety.js";
import { fetchWebsiteResearchPacket } from "./research-site.js";
export type { WebsiteResearchPacket } from "./research-site.js";

const EvidenceSourceSchema = z.enum(RESEARCH_EVIDENCE_SOURCES);

export const ResearchResultSchema = z.object({
  decision: z.enum(["qualified", "disqualified", "needs_review"]),
  scores: z.object({
    businessFit: z.number().int().min(0).max(10),
    websiteNeed: z.number().int().min(0).max(10),
    abilityToPay: z.number().int().min(0).max(10),
    contactability: z.number().int().min(0).max(10),
    urgency: z.number().int().min(0).max(10),
    salesOpportunity: z.number().int().min(0).max(10),
  }),
  problems: z.array(z.object({
    category: z.string().min(1),
    title: z.string().min(1),
    evidence: z.string().min(1),
    businessConsequence: z.string().min(1),
    recommendedImprovement: z.string().optional().default(""),
    confidence: z.number().min(0).max(1),
    outreachValue: z.enum(["low", "medium", "high"]),
    evidenceSources: z.array(EvidenceSourceSchema).min(1),
  })).max(8),
  researchSummary: z.string().min(1),
  primaryOutreachAngle: z.string().nullable(),
  qualificationReason: z.string().min(1),
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

export const RESEARCH_VERSION = "lead-research-v5";

export function calculatePriority(scores: ResearchResult["scores"]): number {
  return Math.round((
    scores.businessFit * .20 +
    scores.websiteNeed * .25 +
    scores.abilityToPay * .15 +
    scores.contactability * .15 +
    scores.urgency * .10 +
    scores.salesOpportunity * .15
  ) * 10);
}

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["decision", "scores", "problems", "researchSummary", "primaryOutreachAngle", "qualificationReason", "confidence"],
    properties: {
      decision: { type: "string", enum: ["qualified", "disqualified", "needs_review"] },
      scores: {
        type: "object",
        additionalProperties: false,
        required: ["businessFit", "websiteNeed", "abilityToPay", "contactability", "urgency", "salesOpportunity"],
        properties: Object.fromEntries(["businessFit", "websiteNeed", "abilityToPay", "contactability", "urgency", "salesOpportunity"].map((k) => [k, { type: "integer", minimum: 0, maximum: 10 }])),
      },
      problems: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["category", "title", "evidence", "businessConsequence", "recommendedImprovement", "confidence", "outreachValue", "evidenceSources"],
          properties: {
            category: { type: "string" },
            title: { type: "string" },
            evidence: { type: "string" },
            businessConsequence: { type: "string" },
            recommendedImprovement: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            outreachValue: { type: "string", enum: ["low", "medium", "high"] },
            evidenceSources: { type: "array", minItems: 1, items: { type: "string", enum: [...RESEARCH_EVIDENCE_SOURCES] } },
          },
        },
      },
      researchSummary: { type: "string" },
      primaryOutreachAngle: { type: ["string", "null"] },
      qualificationReason: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

const HARD_RESEARCH_RULES = [
  "Use only supplied evidence. Never invent a website problem or business fact.",
  "Every problem must list the exact evidenceSources used. Use dom_heading for headings and dom_text for pageText.",
  "The website packet is produced from static HTML, not a rendered browser. Even after obvious hidden elements are filtered, dom_heading and dom_text may contain CSS-hidden, off-canvas, responsive-hidden, slider-clone, or abandoned template-builder content.",
  "The crawler follows up to four discovered contact, quote, estimate, inspection, request, booking, scheduling, or appointment pages and aggregates those checks into contactSignals.checkedContactPages.",
  "contactSignals.hasForm and formCount are aggregated across the landing page and successfully fetched contact/request pages. If hasForm is true, never claim that the site or contact flow lacks a form.",
  "Even when contactSignals.hasForm is false, static HTML can miss JavaScript-rendered forms. Do not use a missing-form claim as a prospect-facing outreach problem.",
  "Never say or imply that visitors can see content when the claim is supported only by dom_heading or dom_text.",
  "Never make leftover-template, unrelated-industry-content, placeholder-content, wrong-company-content, or similar credibility claims high-confidence/high-outreach when supported only by dom_heading/dom_text. Such a finding needs corroboration from a visitor-facing signal such as navigation, CTA, title/meta, or another deterministic source; otherwise treat it only as a low-confidence diagnostic clue.",
  "A high-confidence or high-outreach problem must have at least one evidence source other than dom_heading/dom_text.",
  "Treat deterministic fields such as navigation, calls to action, contact signals, architecture, technologies, and measured performance as evidence, not assumptions.",
  "Absence from the packet is not proof that something does not exist unless the packet explicitly establishes that absence.",
  "Scores are 0-10. Obvious national chains, agency-managed sites, non-businesses, and prospects with no meaningful web opportunity should not be qualified merely to fill the pipeline.",
  "Return only the required structured result.",
].join(" ");

export async function researchLead(
  lead: ResearchLead,
  model: string,
  editableInstructions: string,
): Promise<{ result: ResearchResult; model: string; inputTokens?: number; outputTokens?: number }> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const website = await fetchWebsiteResearchPacket(lead.landingPageUrl);
  const evidence = { lead, website };
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
          { role: "user", content: [{ type: "input_text", text: `Analyze this Lead Miner evidence packet:\n${JSON.stringify(evidence)}` }] },
        ],
        text: { format: { type: "json_schema", name: "lead_research", strict: true, schema: jsonSchema() } },
      }),
    },
    "OpenAI research",
  );

  if (!response.ok) throw new Error(`OpenAI research failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no structured research output");

  const parsed = ResearchResultSchema.parse(JSON.parse(raw));
  const problems = parsed.problems.map(applyResearchEvidenceSafety);
  const primaryOutreachAngle = sanitizePrimaryOutreachAngle(parsed.primaryOutreachAngle, problems);

  return {
    result: { ...parsed, problems, primaryOutreachAngle },
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
