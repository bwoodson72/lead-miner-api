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
export const OUTREACH_PROMPT_VERSION = "outreach-draft-v8";

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

export function containsMinimizingRemediation(value: string) {
  return /\b(?:simple|quick|easy|small)\s+(?:cleanup|fix|change|update|adjustment)|\b(?:just|simply)\s+(?:change|update|replace|add|remove)|\bone primary phone\b|\bone monitored email\b/i.test(value);
}

export function isPlaceholderBusinessName(value: string | null | undefined) {
  if (!value) return false;
  const normalized = value.trim().replace(/\s+/g, " ");
  return /^(?:acme(?:\s+(?:roofing|company|business|services?|inc\.?))?|example(?:\s+(?:company|business|services?|roofing|contractor))?|sample(?:\s+(?:company|business|services?))?|test(?:\s+(?:company|business|services?))?|your company|company name|business name|placeholder|unknown|tbd|n\/?a)$/i.test(normalized);
}

export function containsPlaceholderText(value: string) {
  return /\[(?:[^\]]{0,30}(?:name|company|business|email|phone)[^\]]{0,30})\]|\{(?:[^}]{0,30}(?:name|company|business|email|phone)[^}]{0,30})\}|<(?:[^>]{0,30}(?:name|company|business|email|phone)[^>]{0,30})>|\b(?:acme roofing|example company|sample company|your company|company name|business name|placeholder|tbd)\b/i.test(value);
}

export function hasUnverifiedSalutation(value: string) {
  return /^\s*(?:hi|hello|hey|dear)\b[^\r\n]{0,140}(?:,|!|\r?\n)/i.test(value);
}

export function normalizeOutreachBody(value: string) {
  return value
    .trim()
    .replace(/^\s*(?:hi|hello|hey|dear)(?:\s+[^,\r\n]{0,140})?\s*,\s*(?:\r?\n\s*)*/i, "")
    .replace(/^\s*(?:hi|hello|hey)\s*!\s*(?:\r?\n\s*)*/i, "")
    .trim();
}

export function containsGenericOpening(value: string) {
  return /^\s*(?:i hope\b|i (?:just )?wanted to (?:reach out|contact you)|i(?:'m| am) reaching out\b|i came across (?:your|the) (?:website|site)\b|i found (?:your|the) (?:website|site)\b|my name is\b)/i.test(value);
}

export function outreachDraftNeedsRegeneration(bodyText: string, subject = "") {
  return hasUnverifiedSalutation(bodyText)
    || containsPlaceholderText(`${subject}\n${bodyText}`)
    || containsGenericOpening(normalizeOutreachBody(bodyText))
    || containsMinimizingRemediation(bodyText);
}

const HARD_OUTREACH_RULES = [
  "Write the first cold email from exactly one selected, evidence-backed material finding as the concrete hook.",
  "Use the supplied qualification decision and research context only to understand the scope of the opportunity. Do not introduce a second unsupported website problem.",
  "Never invent metrics, traffic loss, revenue loss, ad spend, customer behavior, rankings, business plans, growth, or facts not supplied.",
  "Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, performance scores, numeric audit scores, milliseconds, benchmark names, crawler failures, evidence sources, or internal Lead Miner terminology.",
  "Translate technical evidence into ordinary business language without overstating the consequence. Use conditional business-impact language when actual visitor behavior is not observed.",
  "Do not prescribe the implementation fix in the cold email. Do not give the prospect a checklist, step-by-step remedy, or DIY instructions. The purpose is to surface the business problem and open a consultation, not solve it in the email.",
  "Never minimize the opportunity with language such as simple cleanup, quick fix, easy change, small update, just change, simply replace, one primary phone, or one monitored email.",
  "If qualificationDecision is rebuild_candidate, treat the selected finding as one concrete symptom of the broader asset-level weakness already established by research. Do not imply that a tiny standalone edit resolves the opportunity. The CTA should invite a brief consultation about whether rebuilding the site would make sense.",
  "If qualificationDecision is optimization_candidate, frame the selected finding as a material limitation worth improving without implying that the entire site necessarily needs replacement. The CTA should invite a brief consultation about improving the site.",
  "Do not pitch a trivial content-maintenance service. If the supplied context does not support a meaningful web-development engagement, set requiresReview true rather than manufacturing one.",
  "No verified contact-person name is supplied in this drafting packet. Therefore do not write any salutation or greeting. Never write Hi/Hello/Hey/Dear followed by a business name, company name, team, there, owner, or other invented recipient. Start immediately with the specific evidence-backed observation.",
  "Never emit placeholder text or placeholder identities such as [Name], {First Name}, <Company>, Acme Roofing, Example Company, Company Name, Business Name, Your Company, Placeholder, or TBD.",
  "The first sentence must contain a concrete observation tied to the selected finding. Do not open with filler such as I hope you're well, I wanted to reach out, I'm reaching out, I came across your website, I found your website, or My name is.",
  "Keep the email concise, specific, and natural. Prefer roughly 80 to 150 words unless the evidence genuinely requires less.",
  "Do not use fake familiarity, generic compliments, placeholders, guilt, or manufactured urgency.",
  "Do not invent a customer persona or situation beyond the supplied business/keyword context.",
  "Use one CTA. Prefer a brief consultation-oriented question over vague language such as tightening this up or having a conversation about the issue.",
  "Return only the required structured draft.",
].join(" ");

type LegacyProblem = { title: string; evidence: string; businessConsequence: string; confidence: number; outreachValue: string };
type SelectedFinding = { id: number; category: string; title: string; evidence: string; assetCapability: string; confidence: number; significance: string };

export async function generateOutreachDraft(input: {
  businessName: string | null;
  domain: string;
  keyword: string;
  primaryOutreachAngle: string | null;
  researchSummary: string | null;
  qualificationReason: string | null;
  qualificationDecision?: string | null;
  assetStrength?: string | null;
  selectedFinding?: SelectedFinding;
  problems?: LegacyProblem[];
}, model: string, minFindingConfidence: number, editableInstructions: string): Promise<{ draft: OutreachDraft; model: string; inputTokens?: number; cachedTokens?: number; outputTokens?: number }> {
  let selectedFinding = input.selectedFinding;
  if (!selectedFinding) {
    const legacy = (input.problems ?? [])
      .filter((problem) => !containsUnsupportedFormAbsenceClaim(`${problem.title} ${problem.evidence} ${problem.businessConsequence}`))
      .filter((problem) => problem.confidence >= minFindingConfidence && problem.outreachValue !== "low")
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (legacy) selectedFinding = { id: 1, category: "legacy_problem", title: legacy.title, evidence: legacy.evidence, assetCapability: legacy.businessConsequence, confidence: legacy.confidence, significance: legacy.outreachValue === "high" ? "high" : "medium" };
  }
  if (!selectedFinding) throw new Error("No evidence-backed outreach finding meets the configured safety threshold");
  if (selectedFinding.confidence < minFindingConfidence) throw new Error("Selected outreach finding is below the configured confidence threshold");
  if (containsUnsupportedFormAbsenceClaim(`${selectedFinding.title} ${selectedFinding.evidence} ${selectedFinding.assetCapability}`)) throw new Error("Selected outreach finding contains an unsupported form-absence claim");

  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const packet = {
    businessName: isPlaceholderBusinessName(input.businessName) ? null : input.businessName,
    domain: input.domain,
    keyword: input.keyword,
    recipientPolicy: {
      verifiedPersonNameAvailable: false,
      salutationAllowed: false,
      openingRequirement: "Start directly with the specific evidence-backed observation; do not greet the business or a fabricated team.",
    },
    qualificationContext: {
      decision: input.qualificationDecision ?? null,
      assetStrength: input.assetStrength ?? null,
      researchSummary: sanitizeProspectFacingEvidence(input.researchSummary),
      decisionReason: sanitizeProspectFacingEvidence(input.qualificationReason),
    },
    selectedOutreachAngle: sanitizeProspectFacingEvidence(input.primaryOutreachAngle) ?? sanitizeProspectFacingEvidence(selectedFinding.title),
    selectedFinding: {
      id: selectedFinding.id,
      category: selectedFinding.category,
      title: sanitizeProspectFacingEvidence(selectedFinding.title),
      evidence: sanitizeProspectFacingEvidence(selectedFinding.evidence),
      businessImpact: sanitizeProspectFacingEvidence(selectedFinding.assetCapability),
      confidence: selectedFinding.confidence,
      significance: selectedFinding.significance,
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
  const parsedDraft = OutreachDraftSchema.parse(JSON.parse(raw));
  const draft: OutreachDraft = { ...parsedDraft, bodyText: normalizeOutreachBody(parsedDraft.bodyText) };
  if (containsPlaceholderText(`${draft.subject}\n${draft.bodyText}\n${draft.angle}\n${draft.cta}`)) {
    throw new Error("OpenAI outreach draft contained placeholder text or a fabricated placeholder identity");
  }
  if (containsGenericOpening(draft.bodyText)) {
    throw new Error("OpenAI outreach draft used a generic filler opening instead of the selected evidence-backed observation");
  }
  if (containsMinimizingRemediation(draft.bodyText)) {
    throw new Error("OpenAI outreach draft minimized or prescribed a trivial remediation instead of framing the qualified website opportunity");
  }
  return {
    draft,
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}