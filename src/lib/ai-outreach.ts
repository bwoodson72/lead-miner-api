import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import { containsUnsupportedFormAbsenceClaim } from "./research-evidence-safety.js";

const OutreachDraftSchema = z.object({
  subject: z.string().min(1).max(120),
  bodyText: z.string().min(1).max(2500),
  angle: z.string().min(1).max(500),
  cta: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
  requiresReview: z.boolean(),
});

export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
export const OUTREACH_PROMPT_VERSION = "outreach-draft-v6";

function schema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["subject", "bodyText", "angle", "cta", "confidence", "requiresReview"],
    properties: {
      subject: { type: "string", maxLength: 120 },
      bodyText: { type: "string", maxLength: 2500 },
      angle: { type: "string", maxLength: 500 },
      cta: { type: "string", maxLength: 300 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      requiresReview: { type: "boolean" },
    },
  };
}

export function sanitizeProspectFacingEvidence(value: string | null): string | null {
  if (!value) return value;
  return value
    .replace(/\s*\[Sources:[^\]]+\]/gi, "")
    .replace(/\bLighthouse\b/gi, "site performance testing")
    .replace(/\bPageSpeed(?: Insights)?\b/gi, "site performance testing")
    .replace(/\bCore Web Vitals?\b/gi, "site performance")
    .replace(/\bLCP\b/gi, "load time")
    .replace(/\bCLS\b/gi, "layout stability")
    .replace(/\bTBT\b/gi, "page responsiveness")
    .replace(/\bperformance score\b/gi, "site performance")
    .replace(/\bscore(?:d)?\s*(?:of|at|:)\s*\d+(?:\/100)?\b/gi, "showed weak performance")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?)\b/gi, "a noticeable delay")
    .replace(/\b\d+(?:\.\d+)?\s*(?:s|seconds?)\b/gi, "several seconds")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const HARD_OUTREACH_RULES = [
  "Write the first cold email from exactly one selected, evidence-backed material finding.",
  "Use only the supplied selected finding and selected outreach angle. Do not introduce a second website problem.",
  "Never invent metrics, traffic loss, revenue loss, ad spend, customer behavior, rankings, business plans, growth, or facts not supplied.",
  "Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, performance scores, numeric audit scores, milliseconds, benchmark names, crawler failures, evidence sources, or internal Lead Miner terminology.",
  "Translate technical evidence into ordinary business language without overstating the consequence.",
  "Do not use fake familiarity, generic compliments, placeholders, guilt, or manufactured urgency.",
  "The goal is a low-friction response or consultation conversation, not a hard close. Use one CTA.",
  "Return only the required structured draft.",
].join(" ");

export async function generateOutreachDraft(input: {
  businessName: string | null;
  domain: string;
  keyword: string;
  primaryOutreachAngle: string;
  researchSummary: string | null;
  qualificationReason: string | null;
  selectedFinding: { id: number; category: string; title: string; evidence: string; assetCapability: string; confidence: number; significance: string };
}, model: string, minFindingConfidence: number, editableInstructions: string): Promise<{ draft: OutreachDraft; model: string; inputTokens?: number; cachedTokens?: number; outputTokens?: number }> {
  if (input.selectedFinding.confidence < minFindingConfidence) throw new Error("Selected outreach finding is below the configured confidence threshold");
  if (containsUnsupportedFormAbsenceClaim(`${input.selectedFinding.title} ${input.selectedFinding.evidence} ${input.selectedFinding.assetCapability}`)) {
    throw new Error("Selected outreach finding contains an unsupported form-absence claim");
  }

  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const packet = {
    businessName: input.businessName,
    domain: input.domain,
    keyword: input.keyword,
    selectedOutreachAngle: sanitizeProspectFacingEvidence(input.primaryOutreachAngle),
    selectedFinding: {
      id: input.selectedFinding.id,
      category: input.selectedFinding.category,
      title: sanitizeProspectFacingEvidence(input.selectedFinding.title),
      evidence: sanitizeProspectFacingEvidence(input.selectedFinding.evidence),
      businessImpact: sanitizeProspectFacingEvidence(input.selectedFinding.assetCapability),
      confidence: input.selectedFinding.confidence,
      significance: input.selectedFinding.significance,
    },
  };

  const systemInstructions = `${editableInstructions.trim()}\n\nNon-editable system rules:\n${HARD_OUTREACH_RULES}`;
  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemInstructions }] },
        { role: "user", content: [{ type: "input_text", text: `Create the first outreach email from this qualified Lead Miner opportunity:\n${JSON.stringify(packet)}` }] },
      ],
      text: { format: { type: "json_schema", name: "outreach_draft", strict: true, schema: schema() } },
    }),
  }, "OpenAI outreach");
  if (!response.ok) throw new Error(`OpenAI outreach failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no outreach draft");
  return {
    draft: OutreachDraftSchema.parse(JSON.parse(raw)),
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
