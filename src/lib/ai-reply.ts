import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";

const ClassificationSchema = z.enum(["interested", "question", "objection", "not_now", "not_interested", "wrong_person", "referral", "out_of_office", "bounce", "unsubscribe", "spam_or_scam", "booking_intent", "other"]);
export const ReplyClassificationSchema = z.object({
  classification: ClassificationSchema,
  summary: z.string().min(1).max(1200),
  recommendedAction: z.string().min(1).max(1200),
  extractedQuestion: z.string().max(1200).nullable(),
  extractedObjection: z.string().max(1200).nullable(),
  referralContact: z.string().max(1200).nullable(),
  returnDate: z.string().max(100).nullable(),
  suggestedResponse: z.string().max(2400).nullable(),
  confidence: z.number().min(0).max(1),
});

export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;
export const REPLY_PROMPT_VERSION = "reply-classification-v2";

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["classification", "summary", "recommendedAction", "extractedQuestion", "extractedObjection", "referralContact", "returnDate", "suggestedResponse", "confidence"],
    properties: {
      classification: { type: "string", enum: ClassificationSchema.options },
      summary: { type: "string", maxLength: 1200 },
      recommendedAction: { type: "string", maxLength: 1200 },
      extractedQuestion: { anyOf: [{ type: "string", maxLength: 1200 }, { type: "null" }] },
      extractedObjection: { anyOf: [{ type: "string", maxLength: 1200 }, { type: "null" }] },
      referralContact: { anyOf: [{ type: "string", maxLength: 1200 }, { type: "null" }] },
      returnDate: { anyOf: [{ type: "string", maxLength: 100 }, { type: "null" }] },
      suggestedResponse: { anyOf: [{ type: "string", maxLength: 2400 }, { type: "null" }] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

export async function classifyReply(input: { instructions: string; replyText: string; threadContext: Array<{ from: string | null; text: string }> }, model: string) {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const hardRules = [
    "Classify the inbound prospect reply using only the supplied message and thread.",
    "Do not infer positive intent merely because the tone is polite.",
    "Unsubscribe or explicit do-not-contact language must be unsubscribe. Clear delivery failures must be bounce. Obvious malicious/scam replies may be spam_or_scam.",
    "For questions and objections, extract the actual question/objection when present. For referrals or wrong-person replies, capture any supplied replacement contact verbatim in referralContact.",
    "For out-of-office replies, extract an explicit return date into returnDate when present; otherwise null. Do not invent a date.",
    "suggestedResponse is for operator review only. Provide one only for interested, question, objection, not_now, wrong_person, referral, booking_intent, or other when a human response would be useful. It must not claim it was sent. Use null for bounce, unsubscribe, spam_or_scam, and routine out_of_office.",
    "Return only the required structured classification.",
  ].join(" ");
  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: `${hardRules}\n\nEditable instructions:\n${input.instructions}` }] },
        { role: "user", content: [{ type: "input_text", text: `Classify this inbound reply:\n${JSON.stringify(input)}` }] },
      ],
      text: { format: { type: "json_schema", name: "reply_classification", strict: true, schema: jsonSchema() } },
    }),
  }, "OpenAI reply classification");
  if (!response.ok) throw new Error(`OpenAI reply classification failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no reply classification");
  return { result: ReplyClassificationSchema.parse(JSON.parse(raw)), model: data.model ?? model, inputTokens: data.usage?.input_tokens, cachedTokens: data.usage?.input_tokens_details?.cached_tokens, outputTokens: data.usage?.output_tokens };
}
