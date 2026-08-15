import { z } from "zod";
import { getEnv } from "./env.js";

const OutreachDraftSchema = z.object({
  subject: z.string().min(1).max(120),
  bodyText: z.string().min(1).max(2500),
  angle: z.string().min(1).max(300),
  cta: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
export const OUTREACH_PROMPT_VERSION = "outreach-draft-v1";

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

export async function generateOutreachDraft(input: {
  businessName: string | null;
  domain: string;
  keyword: string;
  primaryOutreachAngle: string | null;
  researchSummary: string | null;
  qualificationReason: string | null;
  problems: Array<{ title: string; evidence: string; businessConsequence: string; confidence: number; outreachValue: string }>;
}, model: string, minProblemConfidence: number): Promise<{ draft: OutreachDraft; model: string; inputTokens?: number; outputTokens?: number }> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const packet = {
    businessName: input.businessName,
    domain: input.domain,
    keyword: input.keyword,
    primaryOutreachAngle: input.primaryOutreachAngle,
    researchSummary: input.researchSummary,
    qualificationReason: input.qualificationReason,
    problems: input.problems.filter((p) => p.confidence >= minProblemConfidence && p.outreachValue !== "low").slice(0, 4),
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: "Write a concise personalized cold outreach email for a web-development prospect. Use only supplied evidence. Focus on one concrete business-impact problem, not a technical audit dump. Do not invent metrics, traffic loss, revenue loss, ad spend, or facts. Avoid generic compliments and fake familiarity. Keep the email plainspoken and short, with one low-friction CTA to discuss whether fixing the issue is worthwhile. Do not use placeholders." }] },
        { role: "user", content: [{ type: "input_text", text: `Create the first outreach email from this qualified Lead Miner packet:\n${JSON.stringify(packet)}` }] },
      ],
      text: { format: { type: "json_schema", name: "outreach_draft", strict: true, schema: schema() } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI outreach failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no outreach draft");
  return { draft: OutreachDraftSchema.parse(JSON.parse(raw)), model: data.model ?? model, inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
}
