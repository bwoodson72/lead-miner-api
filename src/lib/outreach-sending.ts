import type { PrismaClient } from "../generated/prisma/client.js";
import { getActiveOutreachSequence, getAppSettings } from "./settings.js";
import { getGmailMessage, sendGmailMessage } from "./gmail.js";
import { syncLeadGmailPipelineLabelSafely } from "./gmail-pipeline.js";
import { acquireAutomationLease, releaseAutomationLease } from "./automation-lock.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";
import { TOTAL_OUTREACH_TOUCHES, isBreakupSequenceNumber, normalizeFollowUpDelays } from "./outreach-sequence.js";
import { isCurrentOutreachPromptVersion, outreachMessageNeedsRegeneration, staleOutreachReason } from "./outreach-version.js";
import {
  GmailSendSafetyError,
  assertGmailSendAllowed,
  isGmailMailSendingLimitError,
  startGmailQuotaCooldown,
} from "./gmail-send-safety.js";
import {
  getSendIneligibilityReason,
  isWithinSendWindow,
  nextEligibleSendTime,
  makeGmailRfcMessageId,
  makeOutreachIdempotencyKey,
} from "./workflow-policy.js";

const DAY_MS = 86_400_000;
const STALE_SEND_MS = 2 * 60_000;
const MIN_MESSAGE_INTERVAL_MS = 12 * 60 * 60_000;

export function nextFollowUpDate(
  delays: unknown,
  sequenceNumber: number,
  options?: { from?: Date; sendWindowStart?: string; sendWindowEnd?: string; sendTimezone?: string; weekendSendingEnabled?: boolean },
): Date | null {
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1 || sequenceNumber >= TOTAL_OUTREACH_TOUCHES) return null;
  const values = normalizeFollowUpDelays(delays);
  const delay = values[sequenceNumber - 1];
  if (!delay) return null;
  const target = new Date((options?.from ?? new Date()).getTime() + delay * DAY_MS);
  if (!options?.sendWindowStart || !options?.sendWindowEnd) return target;
  return nextEligibleSendTime(target, options.sendWindowStart, options.sendWindowEnd, options.sendTimezone, options.weekendSendingEnabled);
}

async function sendViaGmail(prisma: PrismaClient, message: any, settings: any) {
  const thread = await prisma.emailThread.findFirst({ where: { leadId: message.leadId, provider: "gmail", status: "open" }, orderBy: { updatedAt: "desc" } });
  const prior = await prisma.outreachMessage.findFirst({ where: { leadId: message.leadId, status: "sent", providerMessageId: { not: null } }, orderBy: { sequenceNumber: "desc" } });
  let inReplyToMessageId: string | null = null;
  if (prior?.providerMessageId) {
    try { inReplyToMessageId = (await getGmailMessage(prior.providerMessageId)).rfcMessageId; } catch { inReplyToMessageId = null; }
  }
  const result = await sendGmailMessage({
    fromName: settings.senderName,
    fromEmail: settings.senderEmail,
    to: message.lead.email,
    subject: message.subject,
    bodyText: message.bodyText,
    messageId: makeGmailRfcMessageId(message.id, settings.senderEmail),
    threadId: thread?.providerThreadId ?? prior?.providerThreadId ?? null,
    inReplyToMessageId,
    beforeSend: () => assertGmailSendAllowed(prisma, { dailySendLimit: settings.dailySendLimit }).then(() => undefined),
  });
  return { providerMessageId: result.id, providerThreadId: result.threadId, reconciled: result.reconciled };
}

async function globalSuppressionReason(prisma: PrismaClient, lead: any) {
  const checks: Array<{ type: string; value: string }> = [];
  if (lead.email) checks.push({ type: "email", value: lead.email.toLowerCase() });
  if (lead.domain) checks.push({ type: "domain", value: lead.domain.toLowerCase().replace(/^www\./, "") });
  if (lead.category) checks.push({ type: "category", value: lead.category.toLowerCase() });
  if (!checks.length) return null;
  const suppression = await prisma.suppression.findFirst({ where: { OR: checks.map((check) => ({ type: check.type, value: check.value })) } });
  return suppression ? `Suppressed by ${suppression.type}: ${suppression.reason}` : null;
}

async function assertSendEligible(prisma: PrismaClient, messageId: number) {
  const message = await prisma.outreachMessage.findUnique({ where: { id: messageId }, include: { lead: { include: { suppressions: true, contacts: true } } } });
  if (!message) throw new Error("Message not found");
  if (!isCurrentOutreachPromptVersion(message.kind, message.promptVersion)) throw new Error(staleOutreachReason(message.kind, message.promptVersion) ?? "Outreach draft is stale");
  if (outreachMessageNeedsRegeneration(message.kind, message.bodyText, message.subject, message.cta ?? "")) throw new Error("Outreach draft failed current message-quality checks and must be regenerated or manually edited before sending");
  if (message.sequenceNumber > TOTAL_OUTREACH_TOUCHES) throw new Error(`Outreach sequence is capped at ${TOTAL_OUTREACH_TOUCHES} total touches`);
  const paused = await prisma.suppression.findUnique({ where: { type_value: { type: "global", value: "outreach" } } });
  if (paused) throw new Error("Outreach is paused");
  const globalReason = await globalSuppressionReason(prisma, message.lead);
  if (globalReason) throw new Error(globalReason);
  const reason = getSendIneligibilityReason(message.lead);
  if (reason) throw new Error(reason);
  if (message.lead.lastOutreachDate && message.sequenceNumber > 1 && Date.now() - message.lead.lastOutreachDate.getTime() < MIN_MESSAGE_INTERVAL_MS) throw new Error("Minimum interval between messages to this lead has not elapsed");
  return message;
}

export type ClaimApprovedResult = { state: "claimed"; idempotencyKey: string } | { state: "already_sent"; message: any };

export async function claimApprovedMessage(prisma: PrismaClient, messageId: number, attemptedAt = new Date()): Promise<ClaimApprovedResult> {
  const key = makeOutreachIdempotencyKey(messageId);
  const claimed = await prisma.outreachMessage.updateMany({ where: { id: messageId, status: "approved" }, data: { status: "sending", sendAttemptedAt: attemptedAt, sendError: null, idempotencyKey: key } });
  if (claimed.count === 1) return { state: "claimed", idempotencyKey: key };
  const current = await prisma.outreachMessage.findUnique({ where: { id: messageId } });
  if (current?.status === "sent") return { state: "already_sent", message: current };
  throw new Error(`Message is not available to send (status: ${current?.status ?? "missing"})`);
}

async function completeSend(prisma: PrismaClient, message: any, provider: { providerMessageId: string; providerThreadId: string | null; reconciled: boolean }) {
  const [sequence, settings] = await Promise.all([getActiveOutreachSequence(prisma), getAppSettings(prisma)]);
  const sentAt = new Date();
  const breakup = message.kind === "followup" && isBreakupSequenceNumber(message.sequenceNumber);
  const followUpDate = breakup ? null : nextFollowUpDate(sequence.delaysDays, message.sequenceNumber, { from: sentAt, sendWindowStart: settings.sendWindowStart, sendWindowEnd: settings.sendWindowEnd, sendTimezone: settings.sendTimezone, weekendSendingEnabled: settings.weekendSendingEnabled });
  const nextStatus = followUpDate ? "contacted" : "closed_no_response";

  const updated = await prisma.$transaction(async (tx) => {
    const sent = await tx.outreachMessage.update({ where: { id: message.id }, data: { status: "sent", sentAt, scheduledAt: null, sendError: null, providerMessageId: provider.providerMessageId, providerThreadId: provider.providerThreadId } });
    await tx.lead.update({ where: { id: message.leadId }, data: { status: nextStatus, outreachCount: { increment: 1 }, firstContactAt: message.lead.firstContactAt ?? sentAt, lastOutreachDate: sentAt, followUpDate } });
    if (provider.providerThreadId) await tx.emailThread.upsert({ where: { providerThreadId: provider.providerThreadId }, update: { leadId: message.leadId, provider: "gmail", recipientEmail: message.lead.email, status: breakup ? "closed" : "open", lastOutboundAt: sentAt }, create: { leadId: message.leadId, provider: "gmail", providerThreadId: provider.providerThreadId, recipientEmail: message.lead.email, status: breakup ? "closed" : "open", lastOutboundAt: sentAt } });
    const followUpNumber = message.kind === "followup" ? message.sequenceNumber - 1 : null;
    await tx.activity.create({ data: { leadId: message.leadId, type: provider.reconciled ? "message_send_reconciled" : "message_sent", summary: `${message.kind === "initial" ? "Initial outreach" : `Follow-up ${followUpNumber}${breakup ? " (breakup)" : ""}`} ${provider.reconciled ? "reconciled as already sent" : "sent"} to ${message.lead.email}`, metadata: { messageId: message.id, provider: "gmail", providerMessageId: provider.providerMessageId, providerThreadId: provider.providerThreadId, followUpDate: followUpDate?.toISOString() ?? null, sequenceId: sequence.id, idempotencyKey: message.idempotencyKey, followUpNumber, breakup, promptVersion: message.promptVersion } } });
    if (followUpDate) await tx.activity.create({ data: { leadId: message.leadId, type: "followup_scheduled", summary: `Next follow-up scheduled for ${followUpDate.toISOString()}`, metadata: { followUpDate: followUpDate.toISOString(), sequenceNumber: message.sequenceNumber + 1 } } });
    return sent;
  });

  await syncLeadGmailPipelineLabelSafely(prisma, message.leadId, "successful send", { threadId: provider.providerThreadId });
  return updated;
}

async function deferClaimedMessage(prisma: PrismaClient, message: any, reason: string, retryAt: Date | null) {
  const scheduledAt = retryAt ?? new Date(Date.now() + 10 * 60_000);
  await prisma.$transaction(async (tx) => {
    await tx.outreachMessage.update({
      where: { id: message.id },
      data: { status: "approved", scheduledAt, sendAttemptedAt: null, sendError: reason },
    });
    await tx.activity.create({
      data: {
        leadId: message.leadId,
        type: "message_send_deferred",
        summary: `Message send deferred until ${scheduledAt.toISOString()}: ${reason}`,
        metadata: { messageId: message.id, scheduledAt: scheduledAt.toISOString(), reason },
      },
    });
  });
  return scheduledAt;
}

async function sendClaimedMessage(prisma: PrismaClient, messageId: number) {
  const settings = await getAppSettings(prisma);
  const message = await assertSendEligible(prisma, messageId);
  if (message.status !== "sending") throw new Error("Message is not claimed for sending");
  const key = message.idempotencyKey ?? makeOutreachIdempotencyKey(message.id);
  let providerThreadId = message.providerThreadId ?? null;
  try {
    const provider = await sendViaGmail(prisma, message, settings);
    providerThreadId = provider.providerThreadId;
    return await completeSend(prisma, { ...message, idempotencyKey: key }, provider);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (error instanceof GmailSendSafetyError) {
      await deferClaimedMessage(prisma, message, text, error.retryAt);
      throw error;
    }
    if (isGmailMailSendingLimitError(error)) {
      const cooldown = await startGmailQuotaCooldown(prisma, text);
      await deferClaimedMessage(prisma, message, text, cooldown.until);
      await prisma.activity.create({
        data: {
          leadId: message.leadId,
          type: "gmail_quota_cooldown_started",
          summary: `Gmail mail-sending limit reached; outbound mail blocked until ${cooldown.until.toISOString()}`,
          metadata: { messageId: message.id, cooldownUntil: cooldown.until.toISOString(), reason: cooldown.reason },
        },
      }).catch(() => undefined);
      await syncLeadGmailPipelineLabelSafely(prisma, message.leadId, "Gmail quota send failure", { threadId: providerThreadId });
      throw error;
    }
    await prisma.outreachMessage.update({ where: { id: message.id }, data: { sendError: text } }).catch(() => undefined);
    await syncLeadGmailPipelineLabelSafely(prisma, message.leadId, "send failure", { threadId: providerThreadId });
    throw error;
  }
}

export async function sendApprovedMessage(prisma: PrismaClient, messageId: number) {
  const lease = await acquireAutomationLease(prisma, "outreach-send", 60_000);
  if (!lease) throw new Error("Another send operation is already in progress");
  try {
    await assertSendEligible(prisma, messageId);
    const claim = await claimApprovedMessage(prisma, messageId);
    if (claim.state === "already_sent") {
      await syncLeadGmailPipelineLabelSafely(prisma, claim.message.leadId, "already-sent reconciliation", { threadId: claim.message.providerThreadId });
      return claim.message;
    }
    return await sendClaimedMessage(prisma, messageId);
  } finally { await releaseAutomationLease(prisma, lease); }
}

export async function reconcileStaleSends(prisma: PrismaClient, limit = 10, retryClaimed: (prisma: PrismaClient, messageId: number) => Promise<unknown> = sendClaimedMessage) {
  const safeLimit = capRequestedLimit(limit, SAFETY_LIMITS.automationStaleSendMax, SAFETY_LIMITS.automationStaleSendMax);
  const cutoff = new Date(Date.now() - STALE_SEND_MS);
  const messages = await prisma.outreachMessage.findMany({ where: { status: "sending", sendAttemptedAt: { lte: cutoff } }, orderBy: { sendAttemptedAt: "asc" }, take: safeLimit, select: { id: true } });
  const results: Array<{ messageId: number; success: boolean; error?: string }> = [];
  for (const message of messages) {
    const lease = await acquireAutomationLease(prisma, "outreach-send", 60_000);
    if (!lease) { results.push({ messageId: message.id, success: false, error: "Send lock busy" }); break; }
    try { await prisma.outreachMessage.update({ where: { id: message.id }, data: { sendAttemptedAt: new Date() } }); await retryClaimed(prisma, message.id); results.push({ messageId: message.id, success: true }); }
    catch (error) { results.push({ messageId: message.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
    finally { await releaseAutomationLease(prisma, lease); }
  }
  return results;
}

export async function sendApprovedQueue(prisma: PrismaClient, limit = 25) {
  const settings = await getAppSettings(prisma);
  if (!isWithinSendWindow(settings.sendWindowStart, settings.sendWindowEnd, new Date(), settings.sendTimezone, settings.weekendSendingEnabled)) return [];
  const safeLimit = capRequestedLimit(limit, SAFETY_LIMITS.automationSendMax, SAFETY_LIMITS.automationSendMax);
  const now = new Date();
  const messages = await prisma.outreachMessage.findMany({ where: { status: "approved", sequenceNumber: { lte: TOTAL_OUTREACH_TOUCHES }, OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] }, orderBy: [{ lead: { priorityScore: { sort: "desc", nulls: "last" } } }, { approvedAt: "asc" }], take: Math.min(safeLimit, 1), select: { id: true } });
  const results: Array<{ messageId: number; success: boolean; error?: string }> = [];
  for (const message of messages) {
    try { await sendApprovedMessage(prisma, message.id); results.push({ messageId: message.id, success: true }); }
    catch (error) { results.push({ messageId: message.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}
