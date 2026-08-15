import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";

const FollowUpSchema = z.object({
  bodyText: z.string().min(1).max(2200),
  angle: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

export type FollowUpDraft = z.infer<typeof FollowUpSchema>;
export const FOLLOWUP_PROMPT_VERSION = "followup-v1";

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["bodyText", "angle", "confidence"],
    properties: {
      bodyText: { type: "string", maxLength: 2200 },
      angle: { type: "string", maxLength: 300 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

export async function generateFollowUp(input: {
  instructions: string;
  sequenceNumber: number;
  businessName: string | null;
  domain: string;
  researchSummary: string | null;
  primaryOutreachAngle: string | null;
  problems: Array<{ title: string; evidence: string; businessConsequence: string; confidence: number }>;
  priorMessages: Array<{ kind: string; sequenceNumber: number; subject: string; bodyText: string }>;
}, model: string) {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const packet = {
    sequenceNumber: input.sequenceNumber,
    businessName: input.businessName,
    domain: input.domain,
    researchSummary: input.researchSummary,
    primaryOutreachAngle: input.primaryOutreachAngle,
    problems: input.problems.slice(0, 5),
    priorMessages: input.priorMessages,
  };
  const hardRules = "Write only the body of a follow-up in the existing thread. Use only supplied evidence and prior messages. Never invent facts, metrics, traffic, revenue, ad spend, customer behavior, or a new website problem. Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, audit scores, benchmark scores, milliseconds, or technical performance scores. Do not use generic phrases such as just following up, checking in, circling back, touching base, or bumping this. Keep it concise, natural, and use one CTA. Do not generate a subject line.";
  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: `${hardRules}\n\nEditable instructions:\n${input.instructions}` }] },
        { role: "user", content: [{ type: "input_text", text: `Generate follow-up #${input.sequenceNumber - 1} from this thread context:\n${JSON.stringify(packet)}` }] },
      ],
      text: { format: { type: "json_schema", name: "followup_draft", strict: true, schema: jsonSchema() } },
    }),
  }, "OpenAI follow-up");
  if (!response.ok) throw new Error(`OpenAI follow-up failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no follow-up output");
  return { draft: FollowUpSchema.parse(JSON.parse(raw)), model: data.model ?? model, inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
}
