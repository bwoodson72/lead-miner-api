import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";

export const ReplyClassificationSchema = z.object({
  classification: z.enum(["interested", "question", "objection", "not_now", "not_interested", "wrong_person", "referral", "out_of_office", "bounce", "unsubscribe", "booking_intent", "other"]),
  summary: z.string().min(1).max(1200),
  recommendedAction: z.string().min(1).max(1200),
  confidence: z.number().min(0).max(1),
});

export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;
export const REPLY_PROMPT_VERSION = "reply-classification-v1";

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["classification", "summary", "recommendedAction", "confidence"],
    properties: {
      classification: { type: "string", enum: ["interested", "question", "objection", "not_now", "not_interested", "wrong_person", "referral", "out_of_office", "bounce", "unsubscribe", "booking_intent", "other"] },
      summary: { type: "string", maxLength: 1200 },
      recommendedAction: { type: "string", maxLength: 1200 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

export async function classifyReply(input: { instructions: string; replyText: string; threadContext: Array<{ from: string | null; text: string }> }, model: string) {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const hardRules = "Classify the inbound prospect reply. Use only the supplied message and thread. Do not draft or send a response. Do not infer positive intent merely because the tone is polite. Unsubscribe or explicit do-not-contact language must be classified as unsubscribe. Clear delivery failures must be bounce.";
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
  return { result: ReplyClassificationSchema.parse(JSON.parse(raw)), model: data.model ?? model, inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
}
