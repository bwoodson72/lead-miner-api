import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import { containsUnsupportedFormAbsenceClaim } from "./research-evidence-safety.js";

const OutreachDraftSchema = z.object({
  subject: z.string().min(1).max(120),
  bodyText: z.string().min(1).max(2500),
  angle: z.string().min(1).max(300),
  cta: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
export const OUTREACH_PROMPT_VERSION = "outreach-draft-v5";

function schema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["subject", "bodyText", "angle", "cta", "confidence"],
    properties: {
      subject: { type: "string", maxLength: 120 },
      bodyText: { type: "string", maxLength: 2500 },
      angle: { type: "string", maxLength: 300 },
      cta: { type: "string", maxLength: 300 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

function sanitizeProspectFacingEvidence(value: string | null): string | null {
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

const HARD_OUTREACH_RULES = "Use only the supplied vetted problem evidence. Never invent metrics, traffic loss, revenue loss, ad spend, customer behavior, or business facts. Never infer a new problem from the business name, domain, keyword, or general industry knowledge. Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, performance scores, numeric audit scores, milliseconds, or benchmark names. Do not use placeholders. If a technical finding matters, express it in ordinary business language without overstating the consequence. Return only the required structured draft.";

export async function generateOutreachDraft(input: {
  businessName: string | null;
  domain: string;
  keyword: string;
  primaryOutreachAngle: string | null;
  researchSummary: string | null;
  qualificationReason: string | null;
  problems: Array<{ title: string; evidence: string; businessConsequence: string; confidence: number; outreachValue: string }>;
}, model: string, minProblemConfidence: number, editableInstructions: string): Promise<{ draft: OutreachDraft; model: string; inputTokens?: number; outputTokens?: number }> {
  const vettedProblems = input.problems
    // The current research crawler does not inspect every linked contact/request
    // page, so site-wide "no form" claims are not evidence-backed. Filter them
    // again here so older stored research cannot leak into a new draft.
    .filter((p) => !containsUnsupportedFormAbsenceClaim(`${p.title} ${p.evidence} ${p.businessConsequence}`))
    .filter((p) => p.confidence >= minProblemConfidence && p.outreachValue !== "low")
    .slice(0, 4)
    .map((p) => ({
      ...p,
      title: sanitizeProspectFacingEvidence(p.title) ?? p.title,
      evidence: sanitizeProspectFacingEvidence(p.evidence) ?? p.evidence,
      businessConsequence: sanitizeProspectFacingEvidence(p.businessConsequence) ?? p.businessConsequence,
    }));

  if (!vettedProblems.length) {
    throw new Error("No evidence-backed outreach problem meets the configured safety threshold");
  }

  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const packet = {
    businessName: input.businessName,
    domain: input.domain,
    keyword: input.keyword,
    primaryOutreachAngle: containsUnsupportedFormAbsenceClaim(input.primaryOutreachAngle)
      ? null
      : sanitizeProspectFacingEvidence(input.primaryOutreachAngle),
    problems: vettedProblems,
  };

  const systemInstructions = `${editableInstructions.trim()}\n\nNon-editable system rules:\n${HARD_OUTREACH_RULES}`;
  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemInstructions }] },
        { role: "user", content: [{ type: "input_text", text: `Create the first outreach email from this qualified Lead Miner packet:\n${JSON.stringify(packet)}` }] },
      ],
      text: { format: { type: "json_schema", name: "outreach_draft", strict: true, schema: schema() } },
    }),
  }, "OpenAI outreach");
  if (!response.ok) throw new Error(`OpenAI outreach failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no outreach draft");
  return { draft: OutreachDraftSchema.parse(JSON.parse(raw)), model: data.model ?? model, inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
}
