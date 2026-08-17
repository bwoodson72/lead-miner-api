import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import {
  containsUnsupportedFormAbsenceClaim,
  containsUnverifiedVisitorVisibility,
} from "./research-evidence-safety.js";

const OutreachDraftSchema = z.object({
  subject: z.string().min(1).max(120),
  bodyText: z.string().min(1).max(2500),
  angle: z.string().min(1).max(500),
  cta: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
  requiresReview: z.boolean(),
});

export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
export const OUTREACH_PROMPT_VERSION = "outreach-draft-v13";

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

export function containsArtificialOutreachLanguage(value: string) {
  return /\b(?:customer journey|visitor experience|prospective customers?|prospective clients?|high-intent visitors?|business proposition|primary content|initial presentation|initial usability|acquisition structure|acquisition path|first-visit friction|material constraint|meaningful optimization|page responsiveness)\b|\bfriction\b|\b(?:evaluate|engage) the business\b/i.test(value);
}

export function ctaNeedsRegeneration(value: string) {
  const cta = value.trim();
  if (!cta) return true;
  if (/^(?:invite|ask|suggest|offer|propose|encourage)\b/i.test(cta)) return true;
  if (!/\?\s*$/.test(cta)) return true;
  if (/^(?:a\s+)?brief consultation\b/i.test(cta)) return true;
  if (/^would you be open to\b/i.test(cta)) return true;
  if (/^would it be (?:useful|worth)\b/i.test(cta)) return true;
  if (/^could i (?:walk you through|show you)\b/i.test(cta)) return true;
  if (/^could we look at\b/i.test(cta)) return true;
  if (/^can i send (?:you )?(?:a )?brief assessment\b/i.test(cta)) return true;
  if (containsArtificialOutreachLanguage(cta)) return true;
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
  const normalized = value.toLowerCase().replace(/\s+/g, " ");
  const normalizedSender = senderName.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalizedSender && normalized.includes(normalizedSender)) return true;
  return /\bi(?:'m| am)\s+(?:a\s+)?web developer\b|\bi\s+(?:build|design|develop|work on)\s+[^.!?\n]{0,45}\bwebsites?\b|\bi\s+work with\s+service businesses\b|\bi\s+help\s+service businesses\s+[^.!?\n]{0,45}\bwebsites?\b/i.test(value);
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
    || containsArtificialOutreachLanguage(`${bodyText}\n${cta}`)
    || (cta ? ctaNeedsRegeneration(cta) : false);
}

const HARD_OUTREACH_RULES = [
  "Write a short cold email that sounds like one person typed it to another person. Use ordinary spoken English and short sentences.",
  "The supplied observation is a factual note, not copy. Do not mirror its wording or turn it into an audit summary. Rewrite the idea from scratch in everyday language.",
  "Make one point only: what you noticed and one plausible reason the owner may care. Stop there.",
  "Do not use sales-analysis language such as friction, customer journey, visitor experience, prospective customer, high-intent visitor, acquisition, conversion path, material limitation, optimization engagement, responsiveness, primary content, or business proposition.",
  "Do not sound like a consultant presenting findings. Avoid phrases about affecting the experience, evaluating the business, engaging with the site, or where a delay may be getting in the way.",
  "Never invent metrics, traffic loss, revenue loss, ad spend, rankings, business plans, growth, or facts not supplied. Never state imagined behavior as something that definitely happened.",
  "Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, scores, milliseconds, benchmark names, crawlers, evidence sources, or Lead Miner.",
  "Do not explain implementation details or prescribe a repair checklist.",
  "Start bodyText exactly with 'Hi,' on its own line, followed by a blank line. Do not invent a recipient name or team name.",
  "After the greeting, say what you noticed in plain language. First person is fine. Do not use generic filler such as I hope you're well, I wanted to reach out, I'm reaching out, I came across your website, or I found your website.",
  "Work sender context into the email naturally after the observation. The reader only needs to understand that the sender is a web developer who builds custom websites for service businesses. Do not write a standalone biography paragraph or list credentials.",
  "End with one short, low-pressure question that asks for a reply, permission to send the details, or a conversation. Keep the question conversational and specific to the email. Do not use formal consultation language or recurring campaign formulas.",
  "The cta field must exactly match the question used in bodyText and must end with a question mark.",
  "Sign off with the sender's first name on its own line. No long signature block.",
  "Keep the full email roughly 50 to 90 words including greeting, sender context, CTA, and sign-off.",
  "No fake familiarity, generic compliments, flattery, guilt, fearmongering, exaggerated claims, or manufactured urgency.",
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
      .filter((problem) => !containsUnverifiedVisitorVisibility(`${problem.title} ${problem.evidence} ${problem.businessConsequence}`))
      .filter((problem) => problem.confidence >= minFindingConfidence && problem.outreachValue !== "low")
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (legacy) selectedFinding = { id: 1, category: "legacy_problem", title: legacy.title, evidence: legacy.evidence, assetCapability: legacy.businessConsequence, confidence: legacy.confidence, significance: legacy.outreachValue === "high" ? "high" : "medium" };
  }
  if (!selectedFinding) throw new Error("No evidence-backed outreach finding meets the configured safety threshold");
  if (selectedFinding.confidence < minFindingConfidence) throw new Error("Selected outreach finding is below the configured confidence threshold");
  if (containsUnsupportedFormAbsenceClaim(`${selectedFinding.title} ${selectedFinding.evidence} ${selectedFinding.assetCapability}`)) throw new Error("Selected outreach finding contains an unsupported form-absence claim");
  if (containsUnverifiedVisitorVisibility(`${selectedFinding.title} ${selectedFinding.evidence} ${selectedFinding.assetCapability}`)) throw new Error("Selected outreach finding still requires visitor-facing verification");

  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const senderName = input.senderName?.trim() || "Brian Woodson";
  const senderEmail = input.senderEmail?.trim() || "leads@brianwoodson.dev";
  const senderFirstName = senderName.split(/\s+/)[0] || senderName;
  const observation = sanitizeProspectFacingEvidence(input.primaryOutreachAngle)
    ?? sanitizeProspectFacingEvidence(selectedFinding.title)
    ?? selectedFinding.title;
  const packet = {
    businessName: isPlaceholderBusinessName(input.businessName) ? null : input.businessName,
    domain: input.domain,
    businessType: input.keyword,
    qualificationDecision: input.qualificationDecision ?? null,
    observation,
    sender: {
      name: senderName,
      firstName: senderFirstName,
      role: "web developer",
      work: "builds custom websites for service businesses",
      email: senderEmail,
    },
  };

  const strategyGuidance = editableInstructions.trim()
    ? `Campaign strategy preferences follow. Treat them as goals, not as a checklist, outline, or wording template:\n${editableInstructions.trim()}\n\n`
    : "";
  const systemInstructions = `${strategyGuidance}Non-editable writing and safety rules:\n${HARD_OUTREACH_RULES}`;
  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemInstructions }] },
        { role: "user", content: [{ type: "input_text", text: `Write the first cold email from these private notes. Do not copy the note wording; write the email from scratch:\n${JSON.stringify(packet)}` }] },
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
    throw new Error("OpenAI outreach draft omitted natural sender context");
  }
  if (containsMinimizingRemediation(draft.bodyText)) {
    throw new Error("OpenAI outreach draft minimized or prescribed a trivial remediation instead of framing the qualified website opportunity");
  }
  if (containsConsultantJargon(`${draft.bodyText}\n${draft.cta}`)) {
    throw new Error("OpenAI outreach draft used internal consultant jargon instead of owner-facing business language");
  }
  if (containsArtificialOutreachLanguage(`${draft.bodyText}\n${draft.cta}`)) {
    throw new Error("OpenAI outreach draft sounded like analyst or campaign language instead of a natural email");
  }
  if (ctaNeedsRegeneration(draft.cta)) {
    throw new Error("OpenAI outreach draft produced a malformed, meta, or formulaic CTA");
  }
  return {
    draft,
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens,
    cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
