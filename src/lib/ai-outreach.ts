import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import {
  buildHardOutreachRules,
  containsDisallowedExistingSiteServiceOffer,
  containsProhibitedSubjectLanguage,
  containsProhibitedTouch1Ask,
  containsProspectFacingImplementationStack,
  getOutreachOfferContext,
  OUTREACH_POLICY,
  OUTREACH_VALIDATION_MESSAGES,
} from "./outreach-policy.js";
import {
  containsUnsupportedFormAbsenceClaim,
  containsUnverifiedVisitorVisibility,
} from "./research-evidence-safety.js";

export {
  containsDisallowedExistingSiteServiceOffer,
  containsProspectFacingImplementationStack,
} from "./outreach-policy.js";

const PsychologicalLeverSchema = z.enum([
  "loss_aversion",
  "self_interest",
  "competitive_choice",
  "protect_existing_spend",
  "trust",
  "ease_of_action",
]);

const OutreachDraftSchema = z.object({
  subject: z.string().min(1).max(120),
  bodyText: z.string().min(1).max(2500),
  angle: z.string().min(1).max(500),
  cta: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
  requiresReview: z.boolean(),
});

export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
export const OUTREACH_PROMPT_VERSION = "outreach-draft-v19";

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

const SPELLED_NUMBER = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)";
const HUMAN_DURATION_RE = new RegExp(`\\b(?:(?:about|around|roughly|nearly|almost|close to|over|under)\\s+)?(?:\\d+(?:\\.\\d+)?|${SPELLED_NUMBER}|half a|a)\\s*(?:seconds?|secs?|minutes?|mins?)\\b`, "i");
const OVERPRECISE_DURATION_RE = /\b\d+\.\d{2,}\s*(?:seconds?|secs?|minutes?|mins?)\b/i;

export function containsProspectFacingPerformanceMeasurement(value: string) {
  if (/\b\d+(?:\.\d+)?\s*(?:milliseconds?|ms)\b/i.test(value)) return true;
  if (OVERPRECISE_DURATION_RE.test(value)) return true;
  return /\b(?:load(?:ing)?|page|homepage|content|respond|response|delay|performance|speed)\b[^.!?\n]{0,70}\b\d+(?:\.\d+)?\s*%\b/i.test(value);
}

function humanizeSeconds(raw: string) {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return "a noticeable amount of time";
  if (seconds >= 50 && seconds <= 70) return "close to a minute";
  if (seconds > 70 && seconds < 110) return "over a minute";
  if (seconds >= 110) return `about ${Math.max(2, Math.round(seconds / 60))} minutes`;
  return `about ${Math.max(1, Math.round(seconds))} seconds`;
}

function humanizeMinutes(raw: string) {
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return "a noticeable amount of time";
  if (minutes < 0.75) return humanizeSeconds(String(minutes * 60));
  if (minutes < 1.25) return "about a minute";
  return `about ${Math.max(1, Math.round(minutes))} minutes`;
}

function sanitizePerformanceMeasurements(value: string | null): string | null {
  if (!value) return value;
  return value
    .replace(/\b\d+(?:\.\d+)?\s*(?:milliseconds?|ms)\b/gi, "a noticeable delay")
    .replace(/\b(?:(?:about|around|roughly|nearly|almost|close to|over|under)\s+)?(\d+(?:\.\d+)?)\s*(?:s|seconds?|secs?)\b/gi, (_match, raw: string) => humanizeSeconds(raw))
    .replace(/\b(?:(?:about|around|roughly|nearly|almost|close to|over|under)\s+)?(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/gi, (_match, raw: string) => humanizeMinutes(raw))
    .replace(/\b(?:performance|speed|load(?:ing)?)\s+(?:score|rating)?\s*(?:of|at|:)\s*\d+(?:\.\d+)?%?/gi, "measured site performance")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function sanitizeProspectFacingEvidence(value: string | null): string | null {
  if (!value) return value;
  return sanitizePerformanceMeasurements(value
    .replace(/\s*\[Sources:[^\]]+\]/gi, "")
    .replace(/\bLighthouse\b/gi, "site performance testing")
    .replace(/\bPageSpeed(?: Insights)?\b/gi, "site performance testing")
    .replace(/\bCore Web Vitals?\b/gi, "site performance")
    .replace(/\bLCP\b/gi, "load time")
    .replace(/\bCLS\b/gi, "layout stability")
    .replace(/\bTBT\b/gi, "page responsiveness")
    .replace(/\bperformance score\b/gi, "site performance")
    .replace(/\bscore(?:d)?\s*(?:of|at|:)\s*\d+(?:\/100)?\b/gi, "showed weak performance")
    .replace(/\s{2,}/g, " ")
    .trim());
}

export function containsMinimizingRemediation(value: string) {
  return /\b(?:simple|quick|easy|small)\s+(?:cleanup|fix|change|update|adjustment)|\b(?:just|simply)\s+(?:change|update|replace|add|remove)|\bone primary phone\b|\bone monitored email\b/i.test(value);
}

export function containsConsultantJargon(value: string) {
  return /\b(?:acquisition asset|business asset|material limitation|optimization engagement|conversion paths?|customer-acquisition asset|acquisition paths?|material constraint|meaningful optimization)\b/i.test(value);
}

export function containsArtificialOutreachLanguage(value: string) {
  return /\b(?:customer journey|visitor experience|prospective customers?|prospective clients?|high-intent visitors?|business proposition|initial presentation|initial usability|first-visit friction|page responsiveness)\b|\bfriction\b|\b(?:evaluate|engage) the business\b/i.test(value);
}

export function containsAuditDiagnosisLanguage(value: string) {
  return /\b(?:what|which|where)\s+(?:may|might|could)\s+be\s+(?:contributing|causing|behind)\b|\bwhat(?:'s| is)\s+(?:contributing|causing|behind)\b|\bwhere it affects the page\b|\broot causes?\b|\bcontributing factors?\b/i.test(value);
}

export function containsTechnicalAuditLanguage(value: string) {
  return /\b(?:Lighthouse|PageSpeed(?: Insights)?|Core Web Vitals?|LCP|CLS|TBT|performance score|audit score|crawler|crawl result|evidence source|milliseconds?|\d+(?:\.\d+)?\s*ms)\b/i.test(value);
}

export function ctaNeedsRegeneration(value: string) {
  const cta = value.trim();
  if (!cta) return true;
  if (!/\?\s*$/.test(cta)) return true;
  if (/^(?:invite|ask|suggest|offer|propose|encourage)\b/i.test(cta)) return true;
  if (containsProhibitedTouch1Ask(cta)) return true;
  if (/^(?:a\s+)?brief consultation\b/i.test(cta)) return true;
  if (containsConsultantJargon(cta) || containsArtificialOutreachLanguage(cta) || containsAuditDiagnosisLanguage(cta) || containsTechnicalAuditLanguage(cta) || containsProspectFacingPerformanceMeasurement(cta) || containsProspectFacingImplementationStack(cta) || containsDisallowedExistingSiteServiceOffer(cta)) return true;
  return false;
}

function normalizedCtaSignature(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");
}

export function ctaTooSimilarToRecent(value: string, recentCtas: string[]) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  const signature = normalizedCtaSignature(value);
  return recentCtas.some((recent) => {
    const normalizedRecent = recent.trim().toLowerCase().replace(/\s+/g, " ");
    return normalized === normalizedRecent || (signature.length > 0 && signature === normalizedCtaSignature(recent));
  });
}

export function subjectNeedsRegeneration(value: string) {
  const subject = value.trim();
  if (!subject) return true;
  if (subject.split(/\s+/).length > OUTREACH_POLICY.touch1.subjectMaxWords) return true;
  if (containsProhibitedSubjectLanguage(subject)) return true;
  if (/[!]{1,}/.test(subject)) return true;
  if (HUMAN_DURATION_RE.test(subject)) return true;
  if (containsProspectFacingPerformanceMeasurement(subject)) return true;
  if (containsProspectFacingImplementationStack(subject)) return true;
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
  return /\bi(?:'m| am)\s+(?:a\s+)?(?:web developer|website developer)\b|\bi\s+(?:build|design|develop|work on|spend[^.!?\n]{0,35}building)\s+[^.!?\n]{0,65}\b(?:websites?|sites?)\b|\bi\s+work (?:in|on|with)\s+[^.!?\n]{0,55}\b(?:web development|websites?|sites?|service businesses)\b|\bi\s+help\s+service businesses\s+[^.!?\n]{0,55}\b(?:websites?|sites?)\b|\bmy work\s+(?:is|includes|involves)\s+[^.!?\n]{0,55}\b(?:websites?|web development)\b/i.test(value);
}

export function normalizeOutreachBody(value: string) {
  return value.trim();
}

function stripNeutralGreeting(value: string) {
  return value.replace(/^\s*Hi,\s*(?:\r?\n\s*)+/i, "").trim();
}

export function containsGenericOpening(value: string) {
  return /^\s*(?:i hope\b|i (?:just )?wanted to (?:reach out|contact you)|i(?:'m| am) reaching out\b|i came across (?:your|the) (?:website|site)\b|i found (?:your|the) (?:website|site)\b|my name is\b)/i.test(value);
}

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function ctaAppearsInBody(bodyText: string, cta: string) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  return normalize(bodyText).includes(normalize(cta));
}

function endsWithSenderFirstName(bodyText: string, senderName: string) {
  const firstName = senderName.trim().split(/\s+/)[0];
  if (!firstName) return true;
  const lastLine = bodyText.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  return lastLine?.toLowerCase() === firstName.toLowerCase();
}

type PreviousDraft = {
  subject: string;
  bodyText: string;
  cta: string | null;
};

function normalizedWords(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function draftTooSimilarToPrevious(draft: Pick<OutreachDraft, "bodyText" | "cta">, previous: PreviousDraft) {
  const currentBody = normalizedWords(draft.bodyText);
  const previousBody = normalizedWords(previous.bodyText);
  if (!currentBody.length || !previousBody.length) return false;
  if (currentBody.join(" ") === previousBody.join(" ")) return true;

  const currentSet = new Set(currentBody);
  const previousSet = new Set(previousBody);
  let intersection = 0;
  for (const token of currentSet) if (previousSet.has(token)) intersection += 1;
  const union = new Set([...currentSet, ...previousSet]).size || 1;
  const jaccard = intersection / union;
  const sameOpening = currentBody.slice(0, 8).join(" ") === previousBody.slice(0, 8).join(" ");
  const sameCta = normalizedCtaSignature(draft.cta) === normalizedCtaSignature(previous.cta ?? "");
  return jaccard >= 0.82 || (sameOpening && sameCta);
}

function draftValidationIssues(draft: OutreachDraft, senderName: string, recentCtas: string[], previousDraft?: PreviousDraft | null) {
  const issues: string[] = [];
  if (!hasNeutralGreeting(draft.bodyText)) issues.push(`Start exactly with ${OUTREACH_POLICY.touch1.greeting} on its own line.`);
  if (hasUnverifiedSalutation(draft.bodyText)) issues.push("Do not invent a recipient name, owner name, or team greeting.");
  if (containsPlaceholderText(`${draft.subject}\n${draft.bodyText}\n${draft.cta}`)) issues.push("Remove placeholder or fabricated identity text.");
  if (containsGenericOpening(stripNeutralGreeting(draft.bodyText))) issues.push("Open with the specific observation, not generic cold-email filler.");
  if (containsMinimizingRemediation(draft.bodyText)) issues.push("Do not prescribe or minimize a quick fix in Touch 1.");
  if (containsConsultantJargon(`${draft.bodyText}\n${draft.cta}`)) issues.push("Replace consultant/business-analysis jargon with ordinary spoken English.");
  if (containsArtificialOutreachLanguage(`${draft.bodyText}\n${draft.cta}`)) issues.push("Replace campaign/analyst language with words a person would actually use in an email.");
  if (containsAuditDiagnosisLanguage(`${draft.bodyText}\n${draft.cta}`)) issues.push("Offer the observation or details, not a technical diagnosis of what may be causing or contributing to the issue.");
  if (containsTechnicalAuditLanguage(`${draft.subject}\n${draft.bodyText}\n${draft.cta}`)) issues.push("Remove technical audit and measurement terminology.");
  if (containsProspectFacingPerformanceMeasurement(`${draft.subject}\n${draft.bodyText}\n${draft.cta}`)) issues.push("Use rounded, human-readable elapsed time only. Remove milliseconds, benchmark-style percentages, or overly precise tool-like timing.");
  if (containsProspectFacingImplementationStack(`${draft.subject}\n${draft.bodyText}\n${draft.cta}`)) issues.push(OUTREACH_VALIDATION_MESSAGES.implementationStack);
  if (containsDisallowedExistingSiteServiceOffer(`${draft.bodyText}\n${draft.cta}`)) issues.push(OUTREACH_VALIDATION_MESSAGES.existingSiteWork);
  if (ctaNeedsRegeneration(draft.cta)) issues.push(OUTREACH_VALIDATION_MESSAGES.cta);
  if (!ctaAppearsInBody(draft.bodyText, draft.cta)) issues.push("The cta field must exactly match the question used in the email body.");
  if (ctaTooSimilarToRecent(draft.cta, recentCtas)) issues.push("Rewrite the CTA so it does not reuse the same opening pattern as recent campaign emails.");
  if (subjectNeedsRegeneration(draft.subject)) issues.push(OUTREACH_VALIDATION_MESSAGES.subject);
  const words = wordCount(draft.bodyText);
  if (words < OUTREACH_POLICY.touch1.validationMinWords || words > OUTREACH_POLICY.touch1.validationMaxWords) issues.push(OUTREACH_VALIDATION_MESSAGES.length);
  if (!endsWithSenderFirstName(draft.bodyText, senderName)) issues.push("Sign off with the sender's first name on its own line.");
  if (previousDraft && draftTooSimilarToPrevious(draft, previousDraft)) issues.push("This regeneration is too similar to the previous draft. Rebuild the email with a different opening, sentence structure, framing, and CTA wording while preserving the supported facts.");
  return issues;
}

export function outreachDraftNeedsRegeneration(bodyText: string, subject = "", cta = "") {
  return !hasNeutralGreeting(bodyText)
    || hasUnverifiedSalutation(bodyText)
    || containsPlaceholderText(`${subject}\n${bodyText}`)
    || containsGenericOpening(stripNeutralGreeting(normalizeOutreachBody(bodyText)))
    || containsMinimizingRemediation(bodyText)
    || containsConsultantJargon(bodyText)
    || containsArtificialOutreachLanguage(`${bodyText}\n${cta}`)
    || containsAuditDiagnosisLanguage(`${bodyText}\n${cta}`)
    || containsTechnicalAuditLanguage(`${subject}\n${bodyText}\n${cta}`)
    || containsProspectFacingPerformanceMeasurement(`${subject}\n${bodyText}\n${cta}`)
    || containsProspectFacingImplementationStack(`${subject}\n${bodyText}\n${cta}`)
    || containsDisallowedExistingSiteServiceOffer(`${bodyText}\n${cta}`)
    || (subject ? subjectNeedsRegeneration(subject) : false)
    || (cta ? ctaNeedsRegeneration(cta) : false);
}

type LegacyProblem = {
  title: string;
  evidence: string;
  businessConsequence: string;
  confidence: number;
  outreachValue: string;
};

type SelectedFinding = {
  id: number;
  category: string;
  title: string;
  evidence: string;
  assetCapability: string;
  confidence: number;
  significance: string;
};

type OutreachStrategy = {
  observation: string;
  ownerStake: string;
  buyerMoment: string | null;
  psychologicalLever: z.infer<typeof PsychologicalLeverSchema>;
};

async function requestDraft(
  model: string,
  systemInstructions: string,
  packet: Record<string, unknown>,
  rewrite?: { previousDraft: OutreachDraft; issues: string[] },
) {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const userText = rewrite
    ? `Rewrite the email from scratch. The previous attempt failed the checks below. Fix the problems without copying its wording or turning the checks into visible prose.\n\nProblems:\n- ${rewrite.issues.join("\n- ")}\n\nPrevious attempt:\n${JSON.stringify(rewrite.previousDraft)}\n\nPrivate strategy notes:\n${JSON.stringify(packet)}`
    : `Write the first cold email from these private strategy notes. Do not copy the note wording; write the email from scratch:\n${JSON.stringify(packet)}`;
  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemInstructions }] },
        { role: "user", content: [{ type: "input_text", text: userText }] },
      ],
      text: { format: { type: "json_schema", name: "outreach_draft", strict: true, schema: schema() } },
    }),
  }, "OpenAI outreach");
  if (!response.ok) throw new Error(`OpenAI outreach failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((output: any) => output.content ?? []).find((content: any) => content.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no outreach draft");
  const parsed = OutreachDraftSchema.parse(JSON.parse(raw));
  return {
    draft: { ...parsed, bodyText: normalizeOutreachBody(parsed.bodyText) },
    model: data.model ?? model,
    inputTokens: data.usage?.input_tokens ?? 0,
    cachedTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

export async function generateOutreachDraft(input: {
  businessName: string | null;
  domain: string;
  keyword: string;
  senderName?: string;
  senderEmail?: string;
  qualificationDecision?: string | null;
  strategy?: OutreachStrategy;
  recentCtas?: string[];
  selectedFinding?: SelectedFinding;
  operatorNotes?: string | null;
  previousDraft?: PreviousDraft | null;
  primaryOutreachAngle?: string | null;
  researchSummary?: string | null;
  qualificationReason?: string | null;
  assetStrength?: string | null;
  problems?: LegacyProblem[];
}, model: string, minFindingConfidence: number, editableInstructions: string): Promise<{
  draft: OutreachDraft;
  model: string;
  attempts: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
}> {
  if (input.qualificationDecision && input.qualificationDecision !== "rebuild_candidate") {
    throw new Error(`Initial outreach is only generated for custom rebuild candidates; received ${input.qualificationDecision}`);
  }

  let selectedFinding = input.selectedFinding;
  if (!selectedFinding) {
    const legacy = (input.problems ?? [])
      .filter((problem) => !containsUnsupportedFormAbsenceClaim(`${problem.title} ${problem.evidence} ${problem.businessConsequence}`))
      .filter((problem) => !containsUnverifiedVisitorVisibility(`${problem.title} ${problem.evidence} ${problem.businessConsequence}`))
      .filter((problem) => problem.confidence >= minFindingConfidence && problem.outreachValue !== "low")
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (legacy) {
      selectedFinding = {
        id: 1,
        category: "legacy_problem",
        title: legacy.title,
        evidence: legacy.evidence,
        assetCapability: legacy.businessConsequence,
        confidence: legacy.confidence,
        significance: legacy.outreachValue === "high" ? "high" : "medium",
      };
    }
  }
  if (!selectedFinding) throw new Error("No evidence-backed outreach finding meets the configured safety threshold");
  if (selectedFinding.confidence < minFindingConfidence) throw new Error("Selected outreach finding is below the configured confidence threshold");
  const findingText = `${selectedFinding.title} ${selectedFinding.evidence} ${selectedFinding.assetCapability}`;
  if (containsUnsupportedFormAbsenceClaim(findingText)) throw new Error("Selected outreach finding contains an unsupported form-absence claim");
  if (containsUnverifiedVisitorVisibility(findingText)) throw new Error("Selected outreach finding still requires visitor-facing verification");

  const senderName = input.senderName?.trim() || "Brian Woodson";
  const senderEmail = input.senderEmail?.trim() || "leads@brianwoodson.dev";
  const senderFirstName = senderName.split(/\s+/)[0] || senderName;
  const strategy: OutreachStrategy = input.strategy ?? {
    observation: sanitizeProspectFacingEvidence(input.primaryOutreachAngle ?? null) ?? sanitizeProspectFacingEvidence(selectedFinding.title) ?? selectedFinding.title,
    ownerStake: sanitizeProspectFacingEvidence(selectedFinding.assetCapability) ?? "The issue may make it harder for someone to understand the business or take the next step.",
    buyerMoment: null,
    psychologicalLever: "self_interest",
  };
  const writerStrategy: OutreachStrategy = {
    observation: sanitizePerformanceMeasurements(strategy.observation) ?? strategy.observation,
    ownerStake: sanitizePerformanceMeasurements(strategy.ownerStake) ?? strategy.ownerStake,
    buyerMoment: sanitizePerformanceMeasurements(strategy.buyerMoment),
    psychologicalLever: strategy.psychologicalLever,
  };
  const recentCtas = (input.recentCtas ?? []).slice(0, 20);
  const operatorNotes = input.operatorNotes?.trim() || null;
  const packet = {
    policyVersion: OUTREACH_POLICY.version,
    businessName: isPlaceholderBusinessName(input.businessName) ? null : input.businessName,
    domain: input.domain,
    businessType: input.keyword,
    qualificationDecision: input.qualificationDecision ?? null,
    offerContext: getOutreachOfferContext(),
    strategy: writerStrategy,
    operatorContext: operatorNotes ? {
      source: "human My Notes",
      observations: operatorNotes,
      usage: "First-class private message context supplied by Brian. It may contribute at most one relevant firsthand observation alongside the selected research finding. It does not change qualification, priority, or the stored outreach angle. Do not quote it mechanically or expose it as notes.",
    } : null,
    regeneration: input.previousDraft ? {
      previousDraft: input.previousDraft,
      requirement: "Create a materially different Touch 1. Do not lightly paraphrase this draft. Change the opening construction, sentence structure, framing/body sequence, and CTA wording while preserving supported facts and the same low-friction objective.",
    } : null,
    recentCtas,
    sender: {
      name: senderName,
      firstName: senderFirstName,
      role: "web developer",
      work: OUTREACH_POLICY.offer.senderWork,
      email: senderEmail,
    },
  };

  const strategyGuidance = editableInstructions.trim()
    ? `Campaign preferences follow. They may guide tone, emphasis, and wording but must not override the factual strategy, operatorContext, or non-editable safety rules:\n${editableInstructions.trim()}\n\n`
    : "";
  const systemInstructions = `${strategyGuidance}Non-editable Touch 1 writing and safety rules (${OUTREACH_POLICY.version}):\n${buildHardOutreachRules()}`;

  const first = await requestDraft(model, systemInstructions, packet);
  first.draft.angle = strategy.observation;
  let issues = draftValidationIssues(first.draft, senderName, recentCtas, input.previousDraft);
  if (!issues.length) {
    return {
      draft: first.draft,
      model: first.model,
      attempts: 1,
      inputTokens: first.inputTokens,
      cachedTokens: first.cachedTokens,
      outputTokens: first.outputTokens,
    };
  }

  const second = await requestDraft(model, systemInstructions, packet, { previousDraft: first.draft, issues });
  second.draft.angle = strategy.observation;
  issues = draftValidationIssues(second.draft, senderName, recentCtas, input.previousDraft);
  if (issues.length) throw new Error(`OpenAI outreach draft failed quality checks after rewrite: ${issues.join(" ")}`);

  return {
    draft: second.draft,
    model: second.model,
    attempts: 2,
    inputTokens: first.inputTokens + second.inputTokens,
    cachedTokens: first.cachedTokens + second.cachedTokens,
    outputTokens: first.outputTokens + second.outputTokens,
  };
}
