import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  DEFAULT_FOLLOW_UP_INSTRUCTIONS,
  FOLLOW_UP_COUNT,
  LEGACY_FOLLOW_UP_INSTRUCTIONS,
  TOTAL_OUTREACH_TOUCHES,
  normalizeFollowUpDelays,
} from "./outreach-sequence.js";

export const LEGACY_OUTREACH_INSTRUCTIONS = "Write a concise personalized cold email about one specific evidence-backed business problem. Use plain business language, one CTA, and no invented facts or metrics. Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, audit scores, performance scores, milliseconds, or benchmark terminology.";

export const EARLIER_DEFAULT_OUTREACH_INSTRUCTIONS = [
  "Write Touch 1 as a short email Brian Woodson would personally type to a business owner after noticing something on their website.",
  "The goal is to get a reply or permission to send the details. Do not try to sell the project, book a consultation, or ask for a meeting in Touch 1.",
  "Use the supplied verified observation and private psychological strategy. Make one point.",
  "Show why the observation may matter to the owner in a way they can easily picture. Use the supplied owner stake and buyer moment only when they fit naturally. State possible customer behavior as a possibility, never as something known to have happened.",
  "Let persuasion come from self-interest, loss aversion, competitive choice, trust, protecting money already being spent, or making the next step easier. Do not name or explain the persuasion technique in the email.",
  "Write in ordinary spoken English. It should sound like Brian noticed something, thought the owner should know, and sent a quick email.",
  "Briefly establish why Brian notices this kind of thing: he builds custom websites for service businesses. Do not turn this into a bio or credentials paragraph.",
  "Do not explain the whole diagnosis or the fix. Leave enough unanswered that replying is worthwhile.",
  "Start with Hi, and end with one small, low-pressure question that makes replying easy. Sign Brian.",
  "Keep it roughly 55 to 100 words. Never invent facts, losses, metrics, urgency, recipient identity, or customer behavior. Never mention audit or performance-testing terminology.",
].join(" ");

export const PREVIOUS_DEFAULT_OUTREACH_INSTRUCTIONS = [
  "Write Touch 1 as a short email Brian Woodson would personally type to a business owner after noticing something on their website.",
  "The goal is to get a reply or permission to send the details. Do not try to sell the project, book a consultation, or ask for a meeting in Touch 1.",
  "Use the supplied verified observation and private psychological strategy. Make one point.",
  "Show why the observation may matter to the owner in a way they can easily picture. Use the supplied owner stake and buyer moment only when they fit naturally. State possible customer behavior as a possibility, never as something known to have happened.",
  "Let persuasion come from self-interest, loss aversion, competitive choice, trust, protecting money already being spent, or making the next step easier. Do not name or explain the persuasion technique in the email.",
  "Write in ordinary spoken English. It should sound like Brian noticed something, thought the owner should know, and sent a quick email.",
  "Give brief natural context that Brian works on websites or web development for service businesses, but vary the wording to fit the message. Do not force the same sender sentence into every email and do not turn it into a bio.",
  "Treat exact performance measurements as private evidence. Do not put numeric or spelled-out seconds, milliseconds, percentages, scores, or benchmark values in the prospect-facing subject or message; describe the experience qualitatively.",
  "Do not explain the whole diagnosis or the fix. Leave enough unanswered that replying is worthwhile.",
  "Start with Hi, and end with one small, low-pressure question that makes replying easy. Sign Brian.",
  "Keep it roughly 55 to 100 words. Never invent facts, losses, metrics, urgency, recipient identity, or customer behavior. Never mention audit or performance-testing terminology.",
].join(" ");

export const REBUILD_DEFAULT_OUTREACH_INSTRUCTIONS_V17 = [
  "Write Touch 1 as a short email Brian Woodson would personally type to a business owner after noticing something on their website.",
  "Brian's service is a new custom-coded website built on Astro. He does not optimize, repair, maintain, tune, or patch the prospect's existing WordPress, Wix, Elementor, or other page-builder implementation.",
  "Only custom-rebuild candidates reach this writing stage. Do not pitch the rebuild in Touch 1; the goal is to get a reply or permission to send the details, not to book a consultation or ask for a meeting yet.",
  "Use the supplied verified observation and private psychological strategy. Make one point.",
  "Show why the observation may matter to the owner in a way they can easily picture. Use the supplied owner stake and buyer moment only when they fit naturally. State possible customer behavior as a possibility, never as something known to have happened.",
  "Let persuasion come from self-interest, loss aversion, competitive choice, trust, protecting money already being spent, or making the next step easier. Do not name or explain the persuasion technique in the email.",
  "Write in ordinary spoken English. It should sound like Brian noticed something, thought the owner should know, and sent a quick email.",
  "Give brief natural context that Brian builds custom websites or works in web development for service businesses, but vary the wording to fit the message. Do not force the same sender sentence into every email and do not turn it into a bio. Astro does not need to be mentioned unless it becomes naturally relevant later.",
  "Treat exact performance measurements as private evidence. Do not put numeric or spelled-out seconds, milliseconds, percentages, scores, or benchmark values in the prospect-facing subject or message; describe the experience qualitatively.",
  "Do not offer to optimize, fix, tune, repair, speed up, or otherwise work on the existing implementation. Do not explain the whole diagnosis or the solution. Leave enough unanswered that replying is worthwhile.",
  "Start with Hi, and end with one small, low-pressure question that makes replying easy. The CTA should ask permission to send or show what was found, not offer existing-site work. Sign Brian.",
  "Keep it roughly 55 to 100 words. Never invent facts, losses, metrics, urgency, recipient identity, or customer behavior. Never mention audit or performance-testing terminology.",
].join(" ");

export const DEFAULT_OUTREACH_INSTRUCTIONS = `Write the initial cold email using evidence-backed CASHVERTISING-style direct-response psychology.

This is Touch 1 of a five-touch outreach sequence. Its job is to make the prospect recognize one meaningful website problem, understand why it could matter to the business, and become interested enough to reply or ask to see what was found.

Do not try to make every sales argument in the first email. Later follow-ups will deepen the consequence, add another perspective, reduce resistance, connect the symptom to the broader opportunity when supported, and eventually close the sequence.

Start from the single evidence-backed outreach angle selected by Lead Miner. Use that finding as the specific hook, but do not assume it is necessarily the entire website opportunity.

OFFER CONTEXT

Only REBUILD_CANDIDATE leads reach this writing stage. Brian builds new custom websites for service businesses. He does not sell optimization, repair, maintenance, tuning, plugin work, or page-builder fixes on the prospect's existing website.

Do not reduce a genuine rebuild opportunity to a small repair. At the same time, do not pitch a rebuild in Touch 1. Lead with the verified observation and earn a reply first.

Never mention the framework, CMS, platform, page builder, coding approach, or implementation stack. Prospect-facing positioning is simply that Brian builds custom websites.

PSYCHOLOGICAL OBJECTIVES

1. SELF-INTEREST

Translate the finding into something the business owner actually cares about: making the business easier to choose, protecting customer confidence, making it easier for interested people to contact the business, getting more value from traffic already reaching the site, or helping the website do a better job turning interest into calls or inquiries.

2. LOSS AVERSION

Where supported by the evidence, show what the current situation may put at risk. A prospect might return to Google, hesitate while comparing businesses, find another company easier to choose, or fail to reach the point where they contact the business.

These are possible consequences, not established losses. Never claim the company has definitely lost customers, leads, revenue, rankings, traffic, or sales unless that fact is actually present in the evidence.

3. SPECIFICITY

Open with a real observation from the website research. Avoid generic openings such as your website could be better, you need a modern website, I help businesses grow, I came across your website, I wanted to reach out, or I hope you're doing well.

4. MENTAL IMAGERY

When appropriate, help the owner picture a believable customer situation. For example, someone comparing several roofers may decide the easier or clearer site is the easier company to contact.

Keep scenarios plausible and hypothetical. Never present imagined customer behavior as known fact.

5. CURIOSITY

Do not explain the whole diagnosis or solution. Give enough information to make the problem meaningful, but leave enough unanswered that replying is worthwhile.

Do not offer a technical diagnosis of what may be causing or contributing to the issue. The Touch 1 offer is to send or show what was noticed, not to troubleshoot the prospect's current implementation.

PERFORMANCE EVIDENCE

If measured elapsed time helps the owner understand the severity, it may be stated in normal human language when it is supported by the evidence. Phrases such as close to a minute, about 20 seconds, or over a minute are acceptable.

Do not expose technical measurement language or tool output. Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, performance scores, audit scores, milliseconds, benchmark values, crawler failures, evidence sources, Lead Miner, or AI research. Avoid overly precise decimal timing that sounds copied from a testing tool.

Translate technical evidence into ordinary language a business owner immediately understands.

STRUCTURE

The email should normally move through: specific observation → possible business consequence → why Brian noticed it → one low-friction reply CTA.

Use one finding. Do not stack unrelated problems. Do not provide implementation instructions. Do not prescribe a repair checklist. Do not offer to optimize, fix, tune, repair, speed up, or patch the existing website.

Do not minimize a qualified opportunity with language such as simple cleanup, quick fix, easy change, small tweak, one primary phone, or one monitored email.

STYLE

Write like one businessperson who noticed something important speaking to another businessperson. Use ordinary spoken English, contractions, and simple wording.

Do not sound like automated audit software, a marketing-agency template, a technical report, or generic cold-email spam. Avoid analyst and consultant terms such as customer journey, friction, prospective customers, acquisition asset, business asset, material limitation, or conversion path.

Give brief natural context that Brian builds custom websites or works in web development for service businesses, but do not force the same sender sentence into every email.

Start with Hi, on its own line. Do not invent a recipient name or team name. Keep the complete email roughly 55 to 100 words. Use a mundane, specific subject under nine words. Do not put performance timing in the subject.

Use one small CTA whose job is to earn a reply or permission to send the details. Do not ask for a consultation, meeting, calendar slot, or call in Touch 1. Sign Brian.

Do not use fake familiarity, generic compliments, flattery, guilt, fearmongering, exaggerated claims, or manufactured urgency.

The desired reaction is: "This might be making my business harder to choose, and it may be worth understanding what's really going on."`;

export const ApprovalModeSchema = z.enum(["manual", "shadow", "auto_safe"]);
const PriorityWeightsSchema = z.object({
  opportunityType: z.number().min(0).max(100),
  findingStrength: z.number().min(0).max(100),
  contactability: z.number().min(0).max(100),
  businessMaturity: z.number().min(0).max(100),
  acquisitionIntent: z.number().min(0).max(100),
  evidenceQuality: z.number().min(0).max(100),
}).refine((weights) => Object.values(weights).some((value) => value > 0), { message: "At least one priority weight must be greater than zero" });

export const AppSettingsInputSchema = z.object({
  autoEnrich: z.boolean(),
  autoResearch: z.boolean(),
  autoPrioritize: z.boolean(),
  autoSelectOutreachAngle: z.boolean(),
  autoDraftOutreach: z.boolean(),
  autoSyncReplies: z.boolean(),
  autoProcessFollowups: z.boolean(),
  autoSendApproved: z.boolean(),
  autoGenerateSuggestedReplies: z.boolean(),
  approvalMode: ApprovalModeSchema,
  researchModel: z.string().min(1).max(100),
  outreachModel: z.string().min(1).max(100),
  researchInstructions: z.string().min(20).max(20000),
  outreachInstructions: z.string().min(20).max(20000),
  followUpInstructions: z.string().min(20).max(20000),
  replyInstructions: z.string().min(20).max(20000),
  researchBatchSize: z.number().int().min(1).max(100),
  minPriorityScore: z.number().int().min(0).max(100),
  minAutoApprovePriority: z.number().int().min(0).max(100),
  minAutoApproveConfidence: z.number().min(0).max(1),
  minProblemConfidence: z.number().min(0).max(1),
  priorityWeights: PriorityWeightsSchema,
  dailyAiSpendLimit: z.number().min(0.01).max(10000),
  monthlyAiSpendLimit: z.number().min(0.01).max(100000),
  dailySendLimit: z.number().int().min(1).max(1000),
  sendWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sendWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sendTimezone: z.string().min(1).max(100),
  weekendSendingEnabled: z.boolean(),
  reanalysisAgeDays: z.number().int().min(1).max(365),
  followUpDelaysDays: z.array(z.number().int().min(1).max(90)).length(FOLLOW_UP_COUNT),
  senderName: z.string().min(1).max(100),
  senderEmail: z.string().email().max(254),
});

export const AppSettingsPatchSchema = AppSettingsInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one setting is required" },
);

export type AppSettingsInput = z.infer<typeof AppSettingsInputSchema>;
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

async function syncDefaultSequence(prisma: PrismaClient, inputDelays: unknown) {
  const delays = normalizeFollowUpDelays(inputDelays);
  await prisma.outreachSequence.updateMany({ where: { isActive: true, name: { not: "Default outreach sequence" } }, data: { isActive: false } });
  return prisma.outreachSequence.upsert({
    where: { name: "Default outreach sequence" },
    update: { delaysDays: delays, maxTouches: TOTAL_OUTREACH_TOUCHES, isActive: true },
    create: { name: "Default outreach sequence", delaysDays: delays, maxTouches: TOTAL_OUTREACH_TOUCHES, isActive: true },
  });
}

function usesObsoleteOutreachInstructions(value: string) {
  if ([
    LEGACY_OUTREACH_INSTRUCTIONS,
    EARLIER_DEFAULT_OUTREACH_INSTRUCTIONS,
    PREVIOUS_DEFAULT_OUTREACH_INSTRUCTIONS,
    REBUILD_DEFAULT_OUTREACH_INSTRUCTIONS_V17,
  ].includes(value)) return true;

  return value.includes("This is Touch 1 of a five-touch outreach sequence.")
    && value.includes("For OPTIMIZATION_CANDIDATE leads:")
    && value.includes("customer-acquisition asset")
    && value.includes("The preferred objective is a reply or consultation");
}

export async function getAppSettings(prisma: PrismaClient) {
  let settings = await prisma.appSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, outreachInstructions: DEFAULT_OUTREACH_INSTRUCTIONS },
  });
  const delays = normalizeFollowUpDelays(settings.followUpDelaysDays);
  const delaysChanged = JSON.stringify(settings.followUpDelaysDays) !== JSON.stringify(delays);
  const followUpInstructionsChanged = settings.followUpInstructions === LEGACY_FOLLOW_UP_INSTRUCTIONS;
  const outreachInstructionsChanged = usesObsoleteOutreachInstructions(settings.outreachInstructions);

  if (delaysChanged || followUpInstructionsChanged || outreachInstructionsChanged) {
    settings = await prisma.appSettings.update({
      where: { id: 1 },
      data: {
        ...(delaysChanged ? { followUpDelaysDays: delays } : {}),
        ...(followUpInstructionsChanged ? { followUpInstructions: DEFAULT_FOLLOW_UP_INSTRUCTIONS } : {}),
        ...(outreachInstructionsChanged ? { outreachInstructions: DEFAULT_OUTREACH_INSTRUCTIONS } : {}),
      },
    });
  }

  await syncDefaultSequence(prisma, delays);
  return settings;
}

export async function getActiveOutreachSequence(prisma: PrismaClient) {
  const settings = await getAppSettings(prisma);
  return syncDefaultSequence(prisma, settings.followUpDelaysDays);
}

export async function updateAppSettings(prisma: PrismaClient, input: unknown) {
  const parsed = AppSettingsInputSchema.parse(input);
  const settings = await prisma.appSettings.upsert({ where: { id: 1 }, update: parsed, create: { id: 1, ...parsed } });
  await syncDefaultSequence(prisma, parsed.followUpDelaysDays);
  return settings;
}

export async function patchAppSettings(prisma: PrismaClient, input: unknown) {
  const parsed = AppSettingsPatchSchema.parse(input);
  const settings = await prisma.appSettings.upsert({
    where: { id: 1 },
    update: parsed,
    create: { id: 1, outreachInstructions: DEFAULT_OUTREACH_INSTRUCTIONS, ...parsed },
  });
  if (parsed.followUpDelaysDays) await syncDefaultSequence(prisma, parsed.followUpDelaysDays);
  return settings;
}
