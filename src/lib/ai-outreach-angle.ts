import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";

const OutreachAngleSchema = z.object({
  findingId: z.number().int().positive(),
  angle: z.string().min(1).max(500),
  rationale: z.string().min(1).max(1200),
  confidence: z.number().min(0).max(1),
});

export type OutreachAngle = z.infer<typeof OutreachAngleSchema>;
export const OUTREACH_ANGLE_PROMPT_VERSION = "outreach-angle-v2";

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["findingId", "angle", "rationale", "confidence"],
    properties: {
      findingId: { type: "integer", minimum: 1 },
      angle: { type: "string", maxLength: 500 },
      rationale: { type: "string", maxLength: 1200 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

type AngleFinding = { id: number; category: string; title: string; evidence: string; assetCapability: string; confidence: number; significance: string; evidenceSources: unknown };

export function isLikelyHousekeepingFinding(finding: Pick<AngleFinding, "title" | "evidence" | "assetCapability" | "category">) {
  const text = `${finding.title} ${finding.evidence} ${finding.assetCapability}`;
  if (finding.category === "performance" || finding.category === "acquisition_readiness" || finding.category === "site_maturity") return false;
  return /placeholder\s+(?:email|phone)|multiple\s+(?:different\s+)?phone numbers?|different\s+phone numbers?|inconsistent\s+(?:contact|phone|email)|contact details?\s+(?:are\s+)?inconsistent|replace\s+(?:a\s+)?placeholder|update\s+(?:the\s+)?contact details?|one primary phone|one monitored email/i.test(text);
}

function outreachCandidates(findings: AngleFinding[]) {
  const material = findings.filter((finding) => finding.significance !== "low");
  const development = material.filter((finding) => !isLikelyHousekeepingFinding(finding));
  return development.length ? development : material;
}

export async function selectOutreachAngle(input: {
  businessName: string | null;
  domain: string;
  keyword: string;
  decision: string;
  assetStrength: string;
  researchSummary: string;
  findings: AngleFinding[];
}, model: string) {
  if (!input.findings.length) throw new Error("No material findings are available for outreach angle selection");
  const candidates = outreachCandidates(input.findings);
  if (!candidates.length) throw new Error("No outreach finding represents a material web-development opportunity");
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const hardRules = [
    "Select exactly one supplied material finding as the primary outreach angle.",
    "The findingId must be one of the supplied finding IDs.",
    "Do not invent another website problem, business fact, metric, consequence, urgency, ad spend, traffic level, revenue impact, or customer behavior.",
    "Prefer a finding that is concrete, consequential to the website as a business asset, high-confidence, and naturally aligned with meaningful custom web development or substantial optimization.",
    "Do not choose a narrow housekeeping issue such as replacing placeholder contact text, reconciling phone numbers, fixing a typo, or changing one label when a stronger development-level finding is available.",
    "For a rebuild candidate, prefer a finding that works as a concrete symptom of the broader weak business asset rather than a finding whose obvious remedy is a tiny standalone edit.",
    "For an optimization candidate, prefer the limitation with the clearest material effect on the site's ability to represent the business, support acquisition, or help visitors take action.",
    "The angle is prospect-facing framing, not research prose. Translate technical evidence into plain business impact without exposing Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, audit scores, milliseconds, or benchmark terminology.",
    "Do not write an email, CTA, subject line, proposed fix, or sales script. Only choose the evidence-backed angle and explain internally why it is the best one.",
    "Do not choose an evidence gap, crawler limitation, manual-validation request, or uncertainty as the angle.",
    "Return only the required structured result.",
  ].join(" ");

  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: hardRules }] },
        { role: "user", content: [{ type: "input_text", text: `Choose the strongest outreach angle from this qualified business-asset evidence:\n${JSON.stringify({ ...input, findings: candidates })}` }] },
      ],
      text: { format: { type: "json_schema", name: "outreach_angle", strict: true, schema: jsonSchema() } },
    }),
  }, "OpenAI outreach angle");
  if (!response.ok) throw new Error(`OpenAI outreach angle failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((output: any) => output.content ?? []).find((content: any) => content.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no outreach angle");
  const result = OutreachAngleSchema.parse(JSON.parse(raw));
  if (!candidates.some((finding) => finding.id === result.findingId)) throw new Error("OpenAI selected a finding that was not supplied as an eligible outreach candidate");
  return { result, model: data.model ?? model, inputTokens: data.usage?.input_tokens, cachedTokens: data.usage?.input_tokens_details?.cached_tokens, outputTokens: data.usage?.output_tokens };
}
