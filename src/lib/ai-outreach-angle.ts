import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import {
  containsUnsupportedFormAbsenceClaim,
  containsUnverifiedVisitorVisibility,
} from "./research-evidence-safety.js";

const PsychologicalLeverSchema = z.enum([
  "loss_aversion",
  "self_interest",
  "competitive_choice",
  "protect_existing_spend",
  "trust",
  "ease_of_action",
]);

const OutreachAngleSchema = z.object({
  findingId: z.number().int().positive(),
  observation: z.string().min(1).max(500),
  ownerStake: z.string().min(1).max(700),
  buyerMoment: z.string().min(1).max(700).nullable(),
  psychologicalLever: PsychologicalLeverSchema,
  rationale: z.string().min(1).max(1200),
  confidence: z.number().min(0).max(1),
});

export type OutreachAngle = z.infer<typeof OutreachAngleSchema>;
export type OutreachPsychology = Pick<OutreachAngle, "ownerStake" | "buyerMoment" | "psychologicalLever">;
export const OUTREACH_ANGLE_PROMPT_VERSION = "outreach-angle-v3";

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["findingId", "observation", "ownerStake", "buyerMoment", "psychologicalLever", "rationale", "confidence"],
    properties: {
      findingId: { type: "integer", minimum: 1 },
      observation: { type: "string", maxLength: 500 },
      ownerStake: { type: "string", maxLength: 700 },
      buyerMoment: { type: ["string", "null"], maxLength: 700 },
      psychologicalLever: {
        type: "string",
        enum: ["loss_aversion", "self_interest", "competitive_choice", "protect_existing_spend", "trust", "ease_of_action"],
      },
      rationale: { type: "string", maxLength: 1200 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

type AngleFinding = {
  id: number;
  category: string;
  title: string;
  evidence: string;
  assetCapability: string;
  confidence: number;
  significance: string;
  evidenceSources: unknown;
};

export function isLikelyHousekeepingFinding(finding: Pick<AngleFinding, "title" | "evidence" | "assetCapability" | "category">) {
  const text = `${finding.title} ${finding.evidence} ${finding.assetCapability}`;
  if (finding.category === "performance" || finding.category === "acquisition_readiness" || finding.category === "site_maturity") return false;
  return /placeholder\s+(?:email|phone)|multiple\s+(?:different\s+)?phone numbers?|different\s+phone numbers?|inconsistent\s+(?:contact|phone|email)|contact details?\s+(?:are\s+)?inconsistent|replace\s+(?:a\s+)?placeholder|update\s+(?:the\s+)?contact details?|one primary phone|one monitored email/i.test(text);
}

function isSafeOutreachFinding(finding: AngleFinding) {
  const text = `${finding.title} ${finding.evidence} ${finding.assetCapability}`;
  return !containsUnsupportedFormAbsenceClaim(text) && !containsUnverifiedVisitorVisibility(text);
}

function outreachCandidates(findings: AngleFinding[]) {
  const safe = findings.filter(isSafeOutreachFinding);
  const material = safe.filter((finding) => finding.significance !== "low");
  const development = material.filter((finding) => !isLikelyHousekeepingFinding(finding));
  return development.length ? development : material;
}

export function encodeOutreachPsychology(result: OutreachAngle) {
  return JSON.stringify({
    version: OUTREACH_ANGLE_PROMPT_VERSION,
    ownerStake: result.ownerStake,
    buyerMoment: result.buyerMoment,
    psychologicalLever: result.psychologicalLever,
    rationale: result.rationale,
  });
}

export function decodeOutreachPsychology(value: string | null | undefined): OutreachPsychology | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const result = z.object({
      ownerStake: z.string().min(1),
      buyerMoment: z.string().min(1).nullable(),
      psychologicalLever: PsychologicalLeverSchema,
    }).safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function selectOutreachAngle(input: {
  businessName: string | null;
  domain: string;
  keyword: string;
  adSource?: string | null;
  decision: string;
  assetStrength: string;
  researchSummary: string;
  findings: AngleFinding[];
}, model: string) {
  if (!input.findings.length) throw new Error("No material findings are available for outreach angle selection");
  const candidates = outreachCandidates(input.findings);
  if (!candidates.length) throw new Error("No verified outreach finding represents a material web-development opportunity");
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const hardRules = [
    "This is private strategy work for a first cold email, not prospect-facing copy.",
    "Select exactly one supplied material finding. The findingId must be one of the supplied finding IDs.",
    "Turn the finding into a short factual observation in ordinary language. observation must describe only what was noticed; do not put the consequence, sales pitch, or proposed fix in it.",
    "Identify one ownerStake: the simplest believable thing the owner could gain, protect, or lose because of this observation. Phrase it as a possibility unless the evidence proves the outcome.",
    "Choose one primary psychologicalLever: loss_aversion, self_interest, competitive_choice, protect_existing_spend, trust, or ease_of_action. Choose the lever that naturally follows from the evidence rather than forcing a technique.",
    "buyerMoment is optional. Use one only when a short, normal customer situation makes the consequence easy to picture. Never state imagined customer behavior as an observed fact.",
    "For paid-ad or paid-landing-page evidence, prefer protect_existing_spend when the supplied evidence actually establishes paid acquisition context.",
    "For comparison-sensitive local service purchases, loss_aversion or competitive_choice often fit when a verified website problem could plausibly make the next company easier to choose.",
    "Use self_interest when the clearest stake is making it easier to understand the offer, contact the company, request an estimate, or get more value from traffic already reaching the site.",
    "Use trust only when the supplied finding genuinely concerns credibility, presentation, identity, or confidence.",
    "Do not invent traffic loss, lead loss, revenue loss, rankings, ad spend amounts, urgency, customer behavior, or business plans.",
    "Do not use consultant language such as business asset, acquisition asset, acquisition path, conversion path, material limitation, optimization engagement, customer journey, visitor experience, high-intent visitor, or friction in observation, ownerStake, or buyerMoment.",
    "Do not expose Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, audit scores, milliseconds, crawler terminology, or evidence-source terminology in observation, ownerStake, or buyerMoment.",
    "Do not write an email, subject line, CTA, or solution. The next stage will write the email from these private notes.",
    "Return only the required structured result.",
  ].join(" ");

  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: hardRules }] },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: `Choose the strongest verified finding and the simplest psychology for a first cold email. These are private notes, not copy:\n${JSON.stringify({
              businessName: input.businessName,
              domain: input.domain,
              businessType: input.keyword,
              adSource: input.adSource ?? null,
              qualificationDecision: input.decision,
              findings: candidates,
            })}`,
          }],
        },
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
  return {
    result,
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
