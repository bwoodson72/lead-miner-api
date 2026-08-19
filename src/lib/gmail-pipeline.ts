import type { PrismaClient } from "../generated/prisma/client.js";
import {
  ensureGmailLabelIds,
  findGmailLabelIds,
  getGmailThreadLabelIds,
  modifyGmailThreadLabels,
} from "./gmail.js";
import { TOTAL_OUTREACH_TOUCHES } from "./outreach-sequence.js";

export const GMAIL_PIPELINE_LABELS = {
  root: "Lead Miner",
  active: {
    group: "Lead Miner/Active",
    initialSent: "Lead Miner/Active/Initial Sent",
    followUp1: "Lead Miner/Active/Follow-up 1",
    followUp2: "Lead Miner/Active/Follow-up 2",
    followUp3: "Lead Miner/Active/Follow-up 3",
    outOfOffice: "Lead Miner/Active/Out of Office",
  },
  replies: {
    group: "Lead Miner/Replies",
    interested: "Lead Miner/Replies/Interested",
    question: "Lead Miner/Replies/Question",
    objection: "Lead Miner/Replies/Objection",
    notNow: "Lead Miner/Replies/Not Now",
    referral: "Lead Miner/Replies/Referral",
    wrongPerson: "Lead Miner/Replies/Wrong Person",
    needsReview: "Lead Miner/Replies/Needs Review",
  },
  needsAttention: {
    group: "Lead Miner/Needs Attention",
    sendFailed: "Lead Miner/Needs Attention/Send Failed",
    replyUnhandled: "Lead Miner/Needs Attention/Reply Unhandled",
  },
  closed: {
    group: "Lead Miner/Closed",
    noResponse: "Lead Miner/Closed/No Response",
    notInterested: "Lead Miner/Closed/Not Interested",
    badFit: "Lead Miner/Closed/Bad Fit",
    bounced: "Lead Miner/Closed/Bounced",
    unsubscribed: "Lead Miner/Closed/Unsubscribed",
    rejected: "Lead Miner/Closed/Rejected",
    won: "Lead Miner/Closed/Won",
  },
} as const;

export const GMAIL_PIPELINE_HIERARCHY = [
  GMAIL_PIPELINE_LABELS.root,
  GMAIL_PIPELINE_LABELS.active.group,
  GMAIL_PIPELINE_LABELS.replies.group,
  GMAIL_PIPELINE_LABELS.needsAttention.group,
  GMAIL_PIPELINE_LABELS.closed.group,
  GMAIL_PIPELINE_LABELS.active.initialSent,
  GMAIL_PIPELINE_LABELS.active.followUp1,
  GMAIL_PIPELINE_LABELS.active.followUp2,
  GMAIL_PIPELINE_LABELS.active.followUp3,
  GMAIL_PIPELINE_LABELS.active.outOfOffice,
  GMAIL_PIPELINE_LABELS.replies.interested,
  GMAIL_PIPELINE_LABELS.replies.question,
  GMAIL_PIPELINE_LABELS.replies.objection,
  GMAIL_PIPELINE_LABELS.replies.notNow,
  GMAIL_PIPELINE_LABELS.replies.referral,
  GMAIL_PIPELINE_LABELS.replies.wrongPerson,
  GMAIL_PIPELINE_LABELS.replies.needsReview,
  GMAIL_PIPELINE_LABELS.needsAttention.sendFailed,
  GMAIL_PIPELINE_LABELS.needsAttention.replyUnhandled,
  GMAIL_PIPELINE_LABELS.closed.noResponse,
  GMAIL_PIPELINE_LABELS.closed.notInterested,
  GMAIL_PIPELINE_LABELS.closed.badFit,
  GMAIL_PIPELINE_LABELS.closed.bounced,
  GMAIL_PIPELINE_LABELS.closed.unsubscribed,
  GMAIL_PIPELINE_LABELS.closed.rejected,
  GMAIL_PIPELINE_LABELS.closed.won,
] as const;

export const GMAIL_PIPELINE_STATE_LABELS = GMAIL_PIPELINE_HIERARCHY.filter(
  (name) => ![
    GMAIL_PIPELINE_LABELS.root,
    GMAIL_PIPELINE_LABELS.active.group,
    GMAIL_PIPELINE_LABELS.replies.group,
    GMAIL_PIPELINE_LABELS.needsAttention.group,
    GMAIL_PIPELINE_LABELS.closed.group,
  ].includes(name as never),
);

export const GMAIL_PIPELINE_LEGACY_LABELS = [
  "✔",
  "✔✔",
  "Closed – No Response",
  "Closed – Not Interested",
  "Closed – Bad Fit",
] as const;

export type GmailPipelineStateInput = {
  status: string | null | undefined;
  replyStatus: string | null | undefined;
  latestSentSequenceNumber: number | null | undefined;
  latestSendError: string | null | undefined;
};

type GmailPipelineStateLabel = typeof GMAIL_PIPELINE_STATE_LABELS[number];

const replyLabels: Record<string, GmailPipelineStateLabel> = {
  interested: GMAIL_PIPELINE_LABELS.replies.interested,
  booking_intent: GMAIL_PIPELINE_LABELS.replies.interested,
  question: GMAIL_PIPELINE_LABELS.replies.question,
  objection: GMAIL_PIPELINE_LABELS.replies.objection,
  not_now: GMAIL_PIPELINE_LABELS.replies.notNow,
  referral: GMAIL_PIPELINE_LABELS.replies.referral,
  wrong_person: GMAIL_PIPELINE_LABELS.replies.wrongPerson,
  other: GMAIL_PIPELINE_LABELS.replies.needsReview,
};

export function resolveGmailPipelineLabel(input: GmailPipelineStateInput): GmailPipelineStateLabel | null {
  const status = input.status ?? "";
  const replyStatus = input.replyStatus ?? "";

  if (replyStatus === "bounce" || status === "bounced") return GMAIL_PIPELINE_LABELS.closed.bounced;
  if (replyStatus === "unsubscribe" || status === "unsubscribed") return GMAIL_PIPELINE_LABELS.closed.unsubscribed;
  if (replyStatus === "spam_or_scam" || status === "rejected") return GMAIL_PIPELINE_LABELS.closed.rejected;
  if (replyStatus === "not_interested" || status === "lost") return GMAIL_PIPELINE_LABELS.closed.notInterested;
  if (status === "won") return GMAIL_PIPELINE_LABELS.closed.won;
  if (status === "disqualified") return GMAIL_PIPELINE_LABELS.closed.badFit;
  if (status === "closed_no_response") return GMAIL_PIPELINE_LABELS.closed.noResponse;

  if (replyStatus === "out_of_office") return GMAIL_PIPELINE_LABELS.active.outOfOffice;
  if (replyStatus && replyLabels[replyStatus]) return replyLabels[replyStatus];
  if (["interested", "call_scheduled", "proposal_sent"].includes(status)) return GMAIL_PIPELINE_LABELS.replies.interested;

  if (input.latestSendError) return GMAIL_PIPELINE_LABELS.needsAttention.sendFailed;
  if (status === "replied" || status === "responded") return GMAIL_PIPELINE_LABELS.needsAttention.replyUnhandled;

  const sequence = input.latestSentSequenceNumber ?? 0;
  if (sequence >= TOTAL_OUTREACH_TOUCHES) return GMAIL_PIPELINE_LABELS.closed.noResponse;
  if (sequence === 4) return GMAIL_PIPELINE_LABELS.active.followUp3;
  if (sequence === 3) return GMAIL_PIPELINE_LABELS.active.followUp2;
  if (sequence === 2) return GMAIL_PIPELINE_LABELS.active.followUp1;
  if (sequence === 1) return GMAIL_PIPELINE_LABELS.active.initialSent;
  return null;
}

type GmailPipelineDependencies = {
  ensureLabelIds: typeof ensureGmailLabelIds;
  findLabelIds: typeof findGmailLabelIds;
  getThreadLabelIds: typeof getGmailThreadLabelIds;
  modifyThreadLabels: typeof modifyGmailThreadLabels;
};

const defaultDependencies: GmailPipelineDependencies = {
  ensureLabelIds: ensureGmailLabelIds,
  findLabelIds: findGmailLabelIds,
  getThreadLabelIds: getGmailThreadLabelIds,
  modifyThreadLabels: modifyGmailThreadLabels,
};

export async function syncLeadGmailPipelineLabel(
  prisma: PrismaClient,
  leadId: number,
  options: { threadId?: string | null; dependencies?: GmailPipelineDependencies } = {},
) {
  const dependencies = options.dependencies ?? defaultDependencies;
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      status: true,
      replyStatus: true,
      emailThreads: {
        where: { provider: "gmail" },
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: { providerThreadId: true },
      },
    },
  });
  if (!lead) return { success: false, skipped: true, reason: "lead_missing" as const };

  const [latestSent, latestFailed] = await Promise.all([
    prisma.outreachMessage.findFirst({
      where: { leadId, status: "sent" },
      orderBy: { sequenceNumber: "desc" },
      select: { sequenceNumber: true, providerThreadId: true },
    }),
    prisma.outreachMessage.findFirst({
      where: { leadId, sendError: { not: null }, status: { in: ["sending", "approved", "draft"] } },
      orderBy: { sendAttemptedAt: "desc" },
      select: { sendError: true, providerThreadId: true },
    }),
  ]);

  const threadId = options.threadId
    ?? lead.emailThreads[0]?.providerThreadId
    ?? latestSent?.providerThreadId
    ?? latestFailed?.providerThreadId
    ?? null;
  if (!threadId) return { success: true, skipped: true, reason: "no_gmail_thread" as const };

  const targetLabel = resolveGmailPipelineLabel({
    status: lead.status,
    replyStatus: lead.replyStatus,
    latestSentSequenceNumber: latestSent?.sequenceNumber,
    latestSendError: latestFailed?.sendError,
  });
  if (!targetLabel) return { success: true, skipped: true, reason: "no_pipeline_state" as const, threadId };

  const managedIds = await dependencies.ensureLabelIds([...GMAIL_PIPELINE_HIERARCHY]);
  const legacyIds = await dependencies.findLabelIds([...GMAIL_PIPELINE_LEGACY_LABELS]);
  const targetId = managedIds.get(targetLabel);
  if (!targetId) throw new Error(`Gmail pipeline label was not created: ${targetLabel}`);

  const stateIds = new Set(
    GMAIL_PIPELINE_STATE_LABELS.map((name) => managedIds.get(name)).filter((id): id is string => Boolean(id)),
  );
  const currentIds = await dependencies.getThreadLabelIds(threadId);
  const removeLabelIds = Array.from(new Set([
    ...currentIds.filter((id) => stateIds.has(id) && id !== targetId),
    ...Array.from(legacyIds.values()).filter((id) => currentIds.includes(id)),
  ]));
  const addLabelIds = currentIds.includes(targetId) ? [] : [targetId];

  if (addLabelIds.length || removeLabelIds.length) {
    await dependencies.modifyThreadLabels(threadId, { addLabelIds, removeLabelIds });
  }

  return {
    success: true,
    skipped: false,
    changed: Boolean(addLabelIds.length || removeLabelIds.length),
    threadId,
    label: targetLabel,
  };
}

export async function syncLeadGmailPipelineLabelSafely(
  prisma: PrismaClient,
  leadId: number,
  context: string,
  options: { threadId?: string | null; dependencies?: GmailPipelineDependencies } = {},
) {
  try {
    return await syncLeadGmailPipelineLabel(prisma, leadId, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.activity.create({
      data: {
        leadId,
        type: "gmail_pipeline_label_sync_failed",
        summary: `Gmail pipeline label sync failed after ${context}: ${message}`,
        metadata: { context, threadId: options.threadId ?? null },
      },
    }).catch(() => undefined);
    return { success: false, skipped: false, error: message };
  }
}

export async function reconcileGmailPipelineLabels(prisma: PrismaClient, limit = 500) {
  const threads = await prisma.emailThread.findMany({
    where: { provider: "gmail" },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { leadId: true, providerThreadId: true },
  });
  const results: Array<{ leadId: number; threadId: string; success: boolean; changed?: boolean; error?: string }> = [];
  for (const thread of threads) {
    const result = await syncLeadGmailPipelineLabelSafely(prisma, thread.leadId, "Gmail pipeline reconciliation", { threadId: thread.providerThreadId });
    results.push({
      leadId: thread.leadId,
      threadId: thread.providerThreadId,
      success: result.success,
      changed: "changed" in result ? result.changed : undefined,
      error: "error" in result ? result.error : undefined,
    });
  }
  return results;
}
