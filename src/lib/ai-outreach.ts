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
export const OUTREACH_PROMPT_VERSION = "outreach-draft-v10";

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

export function containsConsultantJargon(value: string) {
  return /\b(?:acquisition asset|material limitation|optimization engagement|conversion paths?|customer-acquisition asset)\b/i.test(value);
}

export function ctaNeedsRegeneration(value: string) {
  const cta = value.trim();
  if (!cta) return true;
  if (/^(?:invite|ask|suggest|offer|propose|encourage)\b/i.test(cta)) return true;
  if (!/\?\s*$/.test(cta)) return true;
  if (/^(?:a\s+)?brief consultation\b/i.test(cta)) return true;
  if (/^would you be open to (?:a )?brief consultation about improving\b/i.test(cta)) return true;
  if (/^would you be open to (?:a )?(?:brief )?(?:conversation|consultation) about (?:improving|the site|the website)\b/i.test(cta)) return true;
  if (/^would you be open to (?:improving|a look at improving) (?:the|your|this|that) (?:site|website|homepage|page)(?:'s)?\b/i.test(cta)) return true;
  return false;
}

export function isPlaceholderBusinessName(value: string | null | undefined) {
  if (!value) return false;
  const normalized = value.trim().replace(/\s+/g, " ");
  return /^(?:acme(?:\s+(?:roofing|company|business|services?|inc\.?))?|example(?:\s+(?:company|business|services?|roofing|contractor))?|sample(?:\s+(?:company|business|services?))?|test(?:\s+(?:company|business|services?))?|your company|company name|business name|placeholder|unknown|tbd|n\/?a)$/i.test(normalized);
}

export function containsPlaceholderText(value: string) {
  return /\[(?:[^\]]{0,30}(?:name|company|business|email|phone)[^\]]{0,30})\]|\{(?:[^}]{0,30}(?:name|company|business|email|phone)[^}]{0,30})\}|<(?:[^>]{0,30}(?:name|company|business|email|phone)[^>]{0,30})>|\b(?:acme roofing|example company|sample company|your company|company name|business name|placeholder|tbd)\b/i.test(value);
}

export function hasNeutralGreeting(value: string) {
  return /^\s*Hi,\s*(?:\r?\n|$)/i.test(value);
}

export function hasUnverifiedSalutation(value: string) {
  const match = value.match(/^\s*(?:hi|hello|hey|dear)\b([^\r\n]*)(?:\r?\n|$)/i);
  if (!match) return false;
  const remainder = match[1].trim();
  return remainder !== "" && remainder !== ",";
}

export function containsSenderIdentity(value: string, senderName: string) {
  const normalizedSender = senderName.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalizedSender) return false;
  return value.toLowerCase().replace(/\s+/g, " ").includes(normalizedSender);
}

export function normalizeOutreachBody(value: string) {
  return value.trim();
}

function stripNeutralGreeting(value: string) {
  return value
    .replace(/^\s*Hi,\s*(?:\r?\n\s*)+/i, "")
    .trim();
}

export function containsGenericOpening(value: string) {
  return /^\s*(?:i hope\b|i (?:just )?wanted to (?:reach out|contact you)|i(?:'m| am) reaching out\b|i came across (?:your|the) (?:website|site)\b|i found (?:your|the) (?:website|site)\b|my name is\b)/i.test(value);
}

export function outreachDraftNeedsRegeneration(bodyText: string, subject = "", cta = "") {
  return !hasNeutralGreeting(bodyText)
    || hasUnverifiedSalutation(bodyText)
    || containsPlaceholderText(`${subject}\n${bodyText}`)
    || containsGenericOpening(stripNeutralGreeting(normalizeOutreachBody(bodyText)))
    || containsMinimizingRemediation(bodyText)
    || containsConsultantJargon(bodyText)
    || (cta ? ctaNeedsRegeneration(cta) : false);
}

const HARD_OUTREACH_RULES = [
  "Write Touch 1 as concise evidence-backed direct-response outreach: a neutral greeting, one concrete observation, one plausible business consequence, why that consequence matters to the owner, one brief sender-context sentence, and one low-friction question.",
  "Write the first cold email from exactly one selected, evidence-backed material finding as the concrete hook.",
  "Use the supplied qualification decision and research context only to understand the scope of the opportunity. Do not introduce a second unsupported website problem.",
  "Never invent metrics, traffic loss, revenue loss, ad spend, rankings, business plans, growth, or facts not supplied.",
  "Never state imagined visitor behavior as observed fact. Conditional consequences are allowed when they follow directly from the selected finding and the observed business or customer-action context.",
  "Plausible hypothetical buying situations are explicitly allowed when grounded in the supplied business type, selected finding, and observed page role or CTA. For example, a homeowner comparing roofers may go back to the search results rather than wait, or a paid-ad visitor may leave before reaching an inspection form. Frame these as possibilities using language such as someone, may, could, or if; never claim they definitely happened.",
  "Use self-interest and loss aversion where supported. Translate the finding into owner-level stakes such as making the business harder to choose, weakening customer confidence, adding friction before an inquiry, making a competitor easier to choose, or getting less value from traffic already reaching the site.",
  "When useful, create one short mental picture of the buying situation so the owner can see why the issue matters. Do not invent demographic details, motivations, or circumstances beyond the supplied business context.",
  "Create curiosity instead of explaining the entire remedy. Surface the larger business question and leave enough unresolved that a reply or consultation feels useful.",
  "Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, performance scores, numeric audit scores, milliseconds, benchmark names, crawler failures, evidence sources, or internal Lead Miner terminology.",
  "Translate technical evidence into ordinary business language without overstating the consequence. Use conditional business-impact language when actual visitor behavior is not observed.",
  "Do not use prospect-facing consultant jargon such as acquisition asset, customer-acquisition asset, material limitation, optimization engagement, or conversion path. Say what the owner or customer actually experiences instead.",
  "Do not prescribe the implementation fix in the cold email. Do not give the prospect a checklist, step-by-step remedy, or DIY instructions. The purpose is to surface the business problem and open a conversation, not solve it in the email.",
  "Never minimize the opportunity with language such as simple cleanup, quick fix, easy change, small update, just change, simply replace, one primary phone, or one monitored email.",
  "If qualificationDecision is rebuild_candidate, treat the selected finding as one concrete symptom of the broader asset-level weakness already established by research. Do not imply that a tiny standalone edit resolves the opportunity. Frame the unresolved question around whether continuing to patch the current website makes sense versus replacing it with a stronger business asset.",
  "If qualificationDecision is optimization_candidate, focus on the meaningful limitation and the business consequence of leaving it unresolved. Treat the existing website as fundamentally viable and do not exaggerate the issue into a rebuild case.",
  "Do not pitch a trivial content-maintenance service. If the supplied context does not support a meaningful web-development engagement, set requiresReview true rather than manufacturing one.",
  "No verified contact-person name is supplied. Start bodyText exactly with 'Hi,' on its own line, followed by a blank line. Do not add a recipient name, business name, team, owner, 'there', or any other invented personalization to the greeting.",
  "After the greeting, the first substantive sentence must contain a concrete observation tied to the selected finding. Do not open the substance with filler such as I hope you're well, I wanted to reach out, I'm reaching out, I came across your website, I found your website, or My name is.",
  "After establishing the prospect's problem and consequence, include exactly one short sender-context sentence using only senderIdentity. Identify the sender by full name and naturally explain that the sender is a web developer who builds custom websites for service businesses. Keep this sentence brief; do not lead with it, list credentials, brag, or turn the email into a bio.",
  "Use the sender context to answer the implicit question 'who is this and why are they emailing me?' without taking attention away from the prospect's business problem.",
  "After the CTA, sign off with the sender's first name on its own line. Do not add a long signature block to bodyText.",
  "Never emit placeholder text or placeholder identities such as [Name], {First Name}, <Company>, Acme Roofing, Example Company, Company Name, Business Name, Your Company, Placeholder, or TBD.",
  "Keep the email concise, specific, and natural. Prefer roughly 90 to 160 words including the greeting, sender-context sentence, CTA, and sign-off.",
  "Do not use fake familiarity, generic compliments, placeholders, guilt, fearmongering, exaggerated claims, or manufactured urgency.",
  "Use one CTA, and make the cta field the exact prospect-facing question used in the email. It must be a complete question, not an instruction to the writer and not a fragment.",
  "The CTA should continue the unresolved business question rather than defaulting to generic website-service language. Vary the wording naturally. A consultation can be implied or explicitly offered, but do not default to formulas such as 'brief consultation about improving the site.'",
  "Return only the required structured draft.",
].join(" ");

type LegacyProblem = { title: string; evidence: string; businessConsequence: string; confidence: number; outreachValue: string };
type SelectedFinding = { id: number; category: string; title: string; evidence: string; assetCapability: string; confidence: number; significance: string };

export async function generateOutreachDraft(input: {
  businessName: string | null;
  domain: string;
  keyword: string;
  senderName?: string;
  senderEmail?: string;
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
  const senderName = input.senderName?.trim() || "Brian Woodson";
  const senderEmail = input.senderEmail?.trim() || "leads@brianwoodson.dev";
  const packet = {
    businessName: isPlaceholderBusinessName(input.businessName) ? null : input.businessName,
    domain: input.domain,
    keyword: input.keyword,
    senderIdentity: {
      name: senderName,
      email: senderEmail,
      role: "web developer",
      serviceFocus: "builds custom websites for service businesses",
    },
    recipientPolicy: {
      verifiedPersonNameAvailable: false,
      salutationAllowed: true,
      requiredGreeting: "Hi,",
      openingRequirement: "After the neutral greeting, start directly with the specific evidence-backed observation; do not fabricate a recipient identity.",
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
  if (!hasNeutralGreeting(draft.bodyText)) {
    throw new Error("OpenAI outreach draft omitted the required neutral greeting");
  }
  if (hasUnverifiedSalutation(draft.bodyText)) {
    throw new Error("OpenAI outreach draft fabricated or used an unverified recipient salutation");
  }
  if (containsPlaceholderText(`${draft.subject}\n${draft.bodyText}\n${draft.angle}\n${draft.cta}`)) {
    throw new Error("OpenAI outreach draft contained placeholder text or a fabricated placeholder identity");
  }
  if (containsGenericOpening(stripNeutralGreeting(draft.bodyText))) {
    throw new Error("OpenAI outreach draft used a generic filler opening instead of the selected evidence-backed observation");
  }
  if (!containsSenderIdentity(draft.bodyText, senderName)) {
    throw new Error("OpenAI outreach draft omitted the configured sender identity");
  }
  if (containsMinimizingRemediation(draft.bodyText)) {
    throw new Error("OpenAI outreach draft minimized or prescribed a trivial remediation instead of framing the qualified website opportunity");
  }
  if (containsConsultantJargon(`${draft.bodyText}\n${draft.cta}`)) {
    throw new Error("OpenAI outreach draft used internal consultant jargon instead of owner-facing business language");
  }
  if (ctaNeedsRegeneration(draft.cta)) {
    throw new Error("OpenAI outreach draft produced a malformed, meta, or generic consultation CTA");
  }
  return {
    draft,
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}