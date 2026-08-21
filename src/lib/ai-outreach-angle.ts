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

const OutreachSelectionSchema = z.object({
  findingId: z.number().int().positive(),
  observation: z.string().min(1).max(500),
  rationale: z.string().min(1).max(1200),
  confidence: z.number().min(0).max(1),
});

type OutreachSelection = z.infer<typeof OutreachSelectionSchema>;

// Legacy compatibility fields remain on the return/storage shape for now,
// but the angle model no longer generates psychology or consequence scaffolding.
export type OutreachAngle = OutreachSelection & {
  ownerStake: string;
  buyerMoment: string | null;
  psychologicalLever: z.infer<typeof PsychologicalLeverSchema>;
};

export type OutreachSelectionSource = z.infer<typeof SelectionSourceSchema>;
export type OutreachPsychology = {
  version: string | null;
  selectionSource: OutreachSelectionSource;
  rationale: string | null;
  ownerStake: string;
  buyerMoment: string | null;
  psychologicalLever: z.infer<typeof PsychologicalLeverSchema>;
};

export const OUTREACH_ANGLE_PROMPT_VERSION = "outreach-angle-v5";

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["findingId", "observation", "rationale", "confidence"],
    properties: {
      findingId: { type: "integer", minimum: 1 },
      observation: { type: "string", maxLength: 500 },
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
    rationale: result.rationale,
  });
}

export function encodeOperatorNotesSelection(notes: string) {
  return JSON.stringify({
    version: OUTREACH_ANGLE_PROMPT_VERSION,
    selectionSource: "operator_notes",
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
      rationale: z.string().nullable().optional(),
      ownerStake: z.string().optional(),
      buyerMoment: z.string().nullable().optional(),
      psychologicalLever: PsychologicalLeverSchema.optional(),
    }).safeParse(parsed);
    if (!result.success) return null;
    return {
      version: result.data.version ?? null,
      selectionSource: result.data.selectionSource,
      rationale: result.data.rationale ?? null,
      ownerStake: result.data.ownerStake ?? "",
      buyerMoment: result.data.buyerMoment ?? null,
      psychologicalLever: result.data.psychologicalLever ?? "self_interest",
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
    "This stage only chooses the factual basis for the first cold email. It does not write the email or create sales psychology.",
    "Select exactly one supplied finding. The findingId must be one of the supplied finding IDs.",
    input.preferredFindingId
      ? "The operator explicitly selected the supplied finding. You MUST use that finding and may not substitute another one."
      : "When more than one finding is supplied, choose the strongest business-facing observation for a first cold email.",
    "Operator notes are private outreach context. They do not change research, qualification, priority, or the stored qualification decision, but they DO guide which supplied finding is most appropriate.",
    "If operator notes say not to lead with a topic, respect that. If operator notes contradict research for prospect-facing outreach, treat the operator notes as authoritative.",
    "Do not invent a new finding from the notes.",
    "observation should be a short factual description of what was actually noticed. Do not add a consequence, pitch, CTA, proposed fix, buyer scenario, or persuasion technique.",
    "Do not invent traffic loss, lead loss, revenue loss, rankings, ad spend, urgency, customer behavior, or business plans.",
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
            text: `Choose the factual outreach finding for a first cold email:\n${JSON.stringify({
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
  const selected = OutreachSelectionSchema.parse(JSON.parse(raw));
  if (!candidates.some((finding) => finding.id === selected.findingId)) throw new Error("OpenAI selected a finding that was not supplied as an eligible outreach candidate");

  const result: OutreachAngle = {
    ...selected,
    ownerStake: "",
    buyerMoment: null,
    psychologicalLever: "self_interest",
  };

  return {
    result,
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
