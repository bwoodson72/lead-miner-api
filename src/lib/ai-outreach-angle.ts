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

const SelectionSourceSchema = z.enum(["auto", "operator", "operator_notes"]);

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
export type OutreachSelectionSource = z.infer<typeof SelectionSourceSchema>;
export type OutreachPsychology = Pick<OutreachAngle, "ownerStake" | "buyerMoment" | "psychologicalLever"> & {
  version: string | null;
  selectionSource: OutreachSelectionSource;
  rationale: string | null;
};
export const OUTREACH_ANGLE_PROMPT_VERSION = "outreach-angle-v4";

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

export type AngleFinding = {
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

export function isSafeOutreachFinding(finding: AngleFinding) {
  const text = `${finding.title} ${finding.evidence} ${finding.assetCapability}`;
  return !containsUnsupportedFormAbsenceClaim(text) && !containsUnverifiedVisitorVisibility(text);
}

export function automaticOutreachCandidates(findings: AngleFinding[]) {
  const safe = findings.filter(isSafeOutreachFinding);
  const material = safe.filter((finding) => finding.significance !== "low");
  const development = material.filter((finding) => !isLikelyHousekeepingFinding(finding));
  const eligible = development.length ? development : material;
  const nonPerformance = eligible.filter((finding) => finding.category !== "performance");
  return nonPerformance.length ? nonPerformance : eligible;
}

export function outreachCandidates(findings: AngleFinding[], preferredFindingId?: number | null) {
  if (preferredFindingId) {
    const preferred = findings.find((finding) => finding.id === preferredFindingId);
    return preferred && isSafeOutreachFinding(preferred) ? [preferred] : [];
  }
  return automaticOutreachCandidates(findings);
}

export function encodeOutreachPsychology(result: OutreachAngle, selectionSource: OutreachSelectionSource = "auto") {
  return JSON.stringify({
    version: OUTREACH_ANGLE_PROMPT_VERSION,
    selectionSource,
    ownerStake: result.ownerStake,
    buyerMoment: result.buyerMoment,
    psychologicalLever: result.psychologicalLever,
    rationale: result.rationale,
  });
}

export function encodeOperatorNotesSelection(notes: string) {
  return JSON.stringify({
    version: OUTREACH_ANGLE_PROMPT_VERSION,
    selectionSource: "operator_notes",
    ownerStake: "Explain one simple, plausible business consequence of the operator-provided observation without claiming known losses.",
    buyerMoment: null,
    psychologicalLever: "self_interest",
    rationale: `Operator explicitly chose My Notes as the primary outreach basis: ${notes.slice(0, 500)}`,
  });
}

export function decodeOutreachPsychology(value: string | null | undefined): OutreachPsychology | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const result = z.object({
      version: z.string().nullable().optional(),
      selectionSource: SelectionSourceSchema.optional().default("auto"),
      ownerStake: z.string().min(1),
      buyerMoment: z.string().min(1).nullable(),
      psychologicalLever: PsychologicalLeverSchema,
      rationale: z.string().nullable().optional(),
    }).safeParse(parsed);
    if (!result.success) return null;
    return {
      version: result.data.version ?? null,
      selectionSource: result.data.selectionSource,
      ownerStake: result.data.ownerStake,
      buyerMoment: result.data.buyerMoment,
      psychologicalLever: result.data.psychologicalLever,
      rationale: result.data.rationale ?? null,
    };
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
  operatorNotes?: string | null;
  preferredFindingId?: number | null;
}, model: string) {
  if (!input.findings.length) throw new Error("No material findings are available for outreach angle selection");
  const candidates = outreachCandidates(input.findings, input.preferredFindingId);
  if (!candidates.length) {
    if (input.preferredFindingId) throw new Error("The operator-selected finding is not available or is not safe for outreach");
    throw new Error("No verified outreach finding represents a material web-development opportunity");
  }
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const hardRules = [
    "This is private strategy work for a first cold email, not prospect-facing copy.",
    "Select exactly one supplied finding. The findingId must be one of the supplied finding IDs.",
    input.preferredFindingId
      ? "The operator explicitly selected the supplied finding. You MUST use that finding and may not substitute another one."
      : "When more than one finding is supplied, choose the strongest business-facing observation for a first cold email.",
    "Operator notes are private outreach context. They do not change research, qualification, priority, or the stored qualification decision, but they DO guide outreach selection and wording.",
    "If operator notes say not to lead with a topic, respect that. If operator notes contradict research for prospect-facing outreach, treat the operator notes as authoritative.",
    "Do not invent a new research finding from the notes. Choose the supplied finding that best matches the operator's direction unless the operator explicitly selected a finding.",
    "Turn the finding into a short factual observation in ordinary language. observation must describe only what was noticed; do not put the consequence, sales pitch, or proposed fix in it.",
    "Identify one ownerStake: the simplest believable thing the owner could gain, protect, or lose because of this observation. Phrase it as a possibility unless the evidence proves the outcome.",
    "Choose one primary psychologicalLever: loss_aversion, self_interest, competitive_choice, protect_existing_spend, trust, or ease_of_action. Choose the lever that naturally follows from the evidence rather than forcing a technique.",
    "buyerMoment is optional. Use one only when a short, normal customer situation makes the consequence easy to picture. Never state imagined customer behavior as an observed fact.",
    "For paid-ad or paid-landing-page evidence, prefer protect_existing_spend when the supplied evidence actually establishes paid acquisition context.",
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
            text: `Choose the outreach finding and simplest psychology for a first cold email. These are private notes, not copy:\n${JSON.stringify({
              businessName: input.businessName,
              domain: input.domain,
              businessType: input.keyword,
              adSource: input.adSource ?? null,
              qualificationDecision: input.decision,
              operatorNotes: input.operatorNotes ?? null,
              preferredFindingId: input.preferredFindingId ?? null,
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
