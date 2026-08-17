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
export const OUTREACH_PROMPT_VERSION = "outreach-draft-v11";

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
    || (cta ? ctaNeedsRegeneration(cta) : false);
}

const HARD_OUTREACH_RULES = [
  "Write Touch 1 like a real one-to-one cold email from one businessperson to another. The finished email should sound natural when read aloud, not like a checklist of persuasion techniques or an audit summary.",
  "Build the email around exactly one selected, evidence-backed material finding. Make one persuasive argument from that finding rather than trying to make every possible sales argument in Touch 1.",
  "Use the supplied qualification decision and research context only to understand the scope of the opportunity. Do not introduce a second unsupported website problem.",
  "Never invent metrics, traffic loss, revenue loss, ad spend, rankings, business plans, growth, or facts not supplied.",
  "Never state imagined visitor behavior as observed fact. Conditional business consequences are allowed when they follow directly from the selected finding.",
  "Treat CASHVERTISING principles as tools, not boxes to check. Use self-interest, loss aversion, mental imagery, competitive risk, or curiosity only when they make this particular email stronger. Do not force all of them into every draft.",
  "If a hypothetical buying situation makes the consequence clearer, use at most one short scenario and frame it as a possibility. Otherwise skip the scenario and state the consequence plainly.",
  "Do not stack multiple consequence frames in one email. For example, do not combine an urgent-customer scenario, returning to Google, choosing a competitor, lost traffic value, weakened trust, and reduced inquiries in the same paragraph. Pick the single consequence that best fits the finding.",
  "Prefer plain owner-facing language. Avoid analyst phrasing such as primary page, acquisition path, acquisition asset, business proposition, material limitation, conversion path, or people already reaching the site when simpler language would sound more natural.",
  "Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, performance scores, numeric audit scores, milliseconds, benchmark names, crawler failures, evidence sources, or internal Lead Miner terminology.",
  "Translate technical evidence into ordinary business language without overstating it. A slow measured page can be described as taking a while to show its important content; do not turn the email into a performance report.",
  "Do not prescribe the implementation fix or give a DIY checklist. Create enough understanding of the problem to make a reply or conversation worthwhile.",
  "Never minimize the opportunity with language such as simple cleanup, quick fix, easy change, small update, just change, simply replace, one primary phone, or one monitored email.",
  "If qualificationDecision is rebuild_candidate, the selected finding may be one symptom of a broader website weakness. Do not imply that a tiny standalone edit resolves the opportunity, but do not force a rebuild pitch into Touch 1 either.",
  "If qualificationDecision is optimization_candidate, treat the existing website as fundamentally viable. Focus on the meaningful limitation without exaggerating it into a rebuild case.",
  "If the supplied context does not support a meaningful web-development engagement, set requiresReview true rather than manufacturing one.",
  "Start bodyText exactly with 'Hi,' on its own line, followed by a blank line. No verified contact-person name is supplied, so do not add a recipient name, business name, team, owner, 'there', or any invented personalization to the greeting.",
  "After the greeting, get to the observation quickly. A natural specific opener such as 'I noticed the Weatherford page takes a while to show the quote options' is acceptable. Do not use filler such as I hope you're well, I wanted to reach out, I'm reaching out, I came across your website, or I found your website.",
  "Keep the problem and consequence compact. Usually one short paragraph or two brief paragraphs is enough before the sender context.",
  "Include a brief, natural sender-context sentence or clause using senderIdentity so the prospect understands who is emailing them and why the observation is relevant. Do not force the exact wording 'I'm Brian Woodson, a web developer who builds custom websites for service businesses.' Vary it naturally. Examples of acceptable shapes include 'I build custom websites for service businesses, and this is the kind of issue I work on,' 'I'm Brian, a web developer focused on service-business websites,' or another concise equivalent grounded only in senderIdentity.",
  "Do not lead with the sender bio, list credentials, brag, or make the email about the sender. The prospect's problem comes first.",
  "Use one simple low-friction CTA. The CTA does not need to restate the whole problem or demonstrate another persuasion technique. Natural questions such as 'Would you be open to a quick conversation about it?' are allowed when the preceding copy has already established the reason to care.",
  "Make the cta field the exact prospect-facing question used in bodyText. It must be a complete question, not an instruction to the writer or a fragment.",
  "After the CTA, sign off with the sender's first name on its own line. Do not add a long signature block to bodyText.",
  "Never emit placeholder text or placeholder identities such as [Name], {First Name}, <Company>, Acme Roofing, Example Company, Company Name, Business Name, Your Company, Placeholder, or TBD.",
  "Keep the email concise. Prefer roughly 70 to 120 words including greeting, sender context, CTA, and sign-off. Shorter is better when the point is already clear.",
  "Do not use fake familiarity, generic compliments, flattery, guilt, fearmongering, exaggerated claims, or manufactured urgency.",
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
      openingRequirement: "After the neutral greeting, get quickly to the specific evidence-backed observation without fabricating a recipient identity.",
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
    throw new Error("OpenAI outreach draft omitted natural sender context");
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