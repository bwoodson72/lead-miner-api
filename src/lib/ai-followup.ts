import { z } from "zod";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import { isBreakupSequenceNumber } from "./outreach-sequence.js";
import {
  containsArtificialOutreachLanguage,
  containsConsultantJargon,
  containsDisallowedExistingSiteServiceOffer,
  containsMinimizingRemediation,
  containsPlaceholderText,
  containsProspectFacingImplementationStack,
  containsProspectFacingPerformanceMeasurement,
  containsTechnicalAuditLanguage,
  isPlaceholderBusinessName,
  normalizeOutreachBody,
} from "./ai-outreach.js";

const FollowUpSchema = z.object({
  bodyText: z.string().min(1).max(2200),
  angle: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

export type FollowUpDraft = z.infer<typeof FollowUpSchema>;
export const FOLLOWUP_PROMPT_VERSION = "followup-v4";

function jsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["bodyText", "angle", "confidence"],
    properties: {
      bodyText: { type: "string", maxLength: 2200 },
      angle: { type: "string", maxLength: 300 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

export function followUpNeedsRegeneration(value: string) {
  return containsMinimizingRemediation(value)
    || containsConsultantJargon(value)
    || containsArtificialOutreachLanguage(value)
    || containsTechnicalAuditLanguage(value)
    || containsProspectFacingPerformanceMeasurement(value)
    || containsProspectFacingImplementationStack(value)
    || containsDisallowedExistingSiteServiceOffer(value);
}

export function followUpSequenceGuidance(followUpNumber: number) {
  if (followUpNumber === 1) {
    return "This is follow-up #1. Deepen the original observation with one practical reason it matters to the owner, especially ease of action or protecting an interested prospect from unnecessary confusion. Do not introduce a new website problem. Keep the ask small and make it easy to request the notes or details.";
  }
  if (followUpNumber === 2) {
    return "This is follow-up #2. Reframe the same underlying issue through competitive choice or possible loss: give one believable, conditional buyer moment in which someone comparing businesses could choose the easier or clearer option. Never claim that this customer behavior has actually occurred. Do not introduce a new website problem.";
  }
  if (followUpNumber === 3) {
    return "This is follow-up #3. If the supplied evidence and prior thread support it, shift from the single symptom toward the broader business opportunity: the site may be underselling the business or making it harder to choose. It is okay to connect that broader problem to Brian's work building custom websites, but do not claim the whole site needs replacing unless the supplied evidence supports that conclusion. Do not mention implementation details. The CTA may test whether the broader opportunity is worth discussing, but do not push a calendar slot.";
  }
  return "This is follow-up #4, the terminal breakup message. Close the loop respectfully. Do not introduce a new problem, a new proof point, manufactured urgency, guilt, pressure, challenge, or shame. Do not ask for a meeting, consultation, or calendar slot. Make clear this is the last outreach for now and leave the door open if timing changes. If the prior thread and supplied evidence support a broader rebuild opportunity, it is okay to say Brian would be happy to show what he would approach differently in a new custom website. Do not mention implementation details or imply another follow-up will occur.";
}

export async function generateFollowUp(input: {
  instructions: string;
  sequenceNumber: number;
  businessName: string | null;
  domain: string;
  researchSummary: string | null;
  primaryOutreachAngle: string | null;
  problems: Array<{ title: string; evidence: string; businessConsequence: string; confidence: number }>;
  priorMessages: Array<{ kind: string; sequenceNumber: number; subject: string; bodyText: string }>;
  senderName?: string;
}, model: string) {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const senderName = input.senderName?.trim() || "Brian Woodson";
  const senderFirstName = senderName.split(/\s+/)[0] || senderName;
  const packet = {
    sequenceNumber: input.sequenceNumber,
    businessName: isPlaceholderBusinessName(input.businessName) ? null : input.businessName,
    domain: input.domain,
    offerContext: {
      service: "new custom website",
      prospectFacingPositioning: "custom websites only; no framework, CMS, platform, or implementation details",
    },
    sender: {
      name: senderName,
      firstName: senderFirstName,
      role: "web developer",
      work: "builds custom websites for service businesses",
    },
    recipientPolicy: {
      verifiedPersonNameAvailable: false,
      salutationAllowed: false,
      openingRequirement: "Continue the existing thread directly; do not greet the business, a fabricated team, or an invented person.",
    },
    researchSummary: input.researchSummary,
    primaryOutreachAngle: input.primaryOutreachAngle,
    problems: input.problems.slice(0, 5),
    priorMessages: input.priorMessages,
  };
  const followUpNumber = input.sequenceNumber - 1;
  const isBreakup = isBreakupSequenceNumber(input.sequenceNumber);
  const commonRules = "Write only the body of a follow-up in the existing thread. Use only supplied evidence and prior messages. Never invent facts, metrics, traffic, revenue, ad spend, rankings, urgency, customer behavior, or a new website problem. Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, audit scores, benchmark scores, milliseconds, exact performance measurements, or technical performance scores. Never mention Astro, WordPress, Wix, Elementor, Webflow, Squarespace, Shopify, Next.js, React, a CMS, framework, platform, tech stack, coding approach, or any implementation detail; prospect-facing positioning is simply that Brian builds custom websites. Do not use generic phrases such as just following up, checking in, circling back, touching base, or bumping this. No verified person name is supplied, so do not write a salutation or greet the business/team. Never emit placeholder text such as [Name], Acme Roofing, Example Company, Company Name, Business Name, Your Company, Placeholder, or TBD. Continue directly from the prior thread. Use ordinary spoken English and keep it concise. Sign off with the sender's first name on its own line. Do not generate a subject line.";
  const sequenceRules = followUpSequenceGuidance(followUpNumber);
  if (isBreakup && followUpNumber !== 4) throw new Error(`Breakup sequence mismatch for follow-up #${followUpNumber}`);
  const hardRules = `${commonRules} ${sequenceRules}`;
  const response = await fetchWithProviderBackoff("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: `${hardRules}\n\nEditable instructions:\n${input.instructions}` }] },
        { role: "user", content: [{ type: "input_text", text: `Generate follow-up #${followUpNumber} from this thread context:\n${JSON.stringify(packet)}` }] },
      ],
      text: { format: { type: "json_schema", name: "followup_draft", strict: true, schema: jsonSchema() } },
    }),
  }, "OpenAI follow-up");
  if (!response.ok) throw new Error(`OpenAI follow-up failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as any;
  const raw = data.output_text ?? data.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === "output_text")?.text;
  if (!raw) throw new Error("OpenAI returned no follow-up output");
  const parsed = FollowUpSchema.parse(JSON.parse(raw));
  const draft: FollowUpDraft = { ...parsed, bodyText: normalizeOutreachBody(parsed.bodyText) };
  if (/^\s*(?:hi|hello|hey|dear)\b/i.test(draft.bodyText)) throw new Error("OpenAI follow-up restarted the thread with a greeting");
  if (containsPlaceholderText(`${draft.bodyText}\n${draft.angle}`)) throw new Error("OpenAI follow-up contained placeholder text or a fabricated placeholder identity");
  if (followUpNeedsRegeneration(draft.bodyText)) throw new Error("OpenAI follow-up used unsafe, technical, artificial, or remediation language");
  if (/^\s*(?:just following up|checking in|circling back|touching base|bumping this|wanted to follow up)/i.test(draft.bodyText)) throw new Error("OpenAI follow-up used a generic follow-up opening");
  const lastLine = draft.bodyText.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  if (lastLine?.toLowerCase() !== senderFirstName.toLowerCase()) throw new Error("OpenAI follow-up did not sign off with the sender's first name");
  return { draft, model: data.model ?? model, inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
}
