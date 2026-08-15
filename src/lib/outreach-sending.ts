import { Resend } from "resend";
import type { PrismaClient } from "../generated/prisma/client.js";
import { getEnv } from "./env.js";
import { getActiveOutreachSequence, getAppSettings } from "./settings.js";
import { getGmailMessage, sendGmailMessage } from "./gmail.js";
import { acquireAutomationLease, releaseAutomationLease } from "./automation-lock.js";
import {
  getSendIneligibilityReason,
  isWithinSendWindow,
  makeGmailRfcMessageId,
  makeOutreachIdempotencyKey,
} from "./workflow-policy.js";

const DAY_MS = 86_400_000;
const STALE_SEND_MS = 2 * 60_000;

export function nextFollowUpDate(delays: unknown, sequenceNumber: number): Date | null {
  const values = Array.isArray(delays) ? delays.filter((v): v is number => Number.isInteger(v) && Number(v) > 0) : [];
  const delay = values[sequenceNumber - 1];
  return delay ? new Date(Date.now() + delay * DAY_MS) : null;
}

async function providerSend(prisma: PrismaClient, message: any, settings: any, key: string) {
  if (settings.emailProvider === "gmail") {
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
    });
    return { providerMessageId: result.id, providerThreadId: result.threadId, reconciled: result.reconciled };
  }

  const env = getEnv();
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const resend = new Resend(env.RESEND_API_KEY);
  const result = await resend.emails.send(
    { from: `${settings.senderName} <${settings.senderEmail}>`, to: message.lead.email, subject: message.subject, text: message.bodyText },
    { idempotencyKey: key },
  );
  if (result.error) throw new Error(result.error.message);
  if (!result.data?.id) throw new Error("Email provider returned no message id");
  return { providerMessageId: result.data.id, providerThreadId: null, reconciled: false };
}

async function assertSendEligible(prisma: PrismaClient, messageId: number) {
  const message = await prisma.outreachMessage.findUnique({ where: { id: messageId }, include: { lead: { include: { suppressions: true } } } });
  if (!message) throw new Error("Message not found");
  const reason = getSendIneligibilityReason(message.lead);
  if (reason) throw new Error(reason);
  return message;
}

export type ClaimApprovedResult =
  | { state: "claimed"; idempotencyKey: string }
  | { state: "already_sent"; message: any };

/**
 * Atomically transitions one approved message into the sending state.
 * The status predicate is the concurrency guard: only one caller can claim it.
 */
export async function claimApprovedMessage(
  prisma: PrismaClient,
  messageId: number,
  attemptedAt = new Date(),
): Promise<ClaimApprovedResult> {
  const key = makeOutreachIdempotencyKey(messageId);
  const claimed = await prisma.outreachMessage.updateMany({
    where: { id: messageId, status: "approved" },
    data: { status: "sending", sendAttemptedAt: attemptedAt, sendError: null, idempotencyKey: key },
  });

  if (claimed.count === 1) return { state: "claimed", idempotencyKey: key };

  const current = await prisma.outreachMessage.findUnique({ where: { id: messageId } });
  if (current?.status === "sent") return { state: "already_sent", message: current };
  throw new Error(`Message is not available to send (status: ${current?.status ?? "missing"})`);
}

async function completeSend(prisma: PrismaClient, message: any, settings: any, provider: { providerMessageId: string; providerThreadId: string | null; reconciled: boolean }) {
  const sequence = await getActiveOutreachSequence(prisma);
  const sentAt = new Date();
  const followUpDate = nextFollowUpDate(sequence.delaysDays, message.sequenceNumber);
  const nextStatus = followUpDate ? "contacted" : "closed_no_response";

  return prisma.$transaction(async (tx) => {
    const updated = await tx.outreachMessage.update({ where: { id: message.id }, data: { status: "sent", sentAt, sendError: null, providerMessageId: provider.providerMessageId, providerThreadId: provider.providerThreadId } });
    await tx.lead.update({ where: { id: message.leadId }, data: { status: nextStatus, outreachCount: { increment: 1 }, firstContactAt: message.lead.firstContactAt ?? sentAt, lastOutreachDate: sentAt, followUpDate } });
    if (provider.providerThreadId) {
      await tx.emailThread.upsert({
        where: { providerThreadId: provider.providerThreadId },
        update: { leadId: message.leadId, provider: settings.emailProvider, recipientEmail: message.lead.email, status: "open", lastOutboundAt: sentAt },
        create: { leadId: message.leadId, provider: settings.emailProvider, providerThreadId: provider.providerThreadId, recipientEmail: message.lead.email, status: "open", lastOutboundAt: sentAt },
      });
    }
    await tx.activity.create({ data: { leadId: message.leadId, type: provider.reconciled ? "message_send_reconciled" : "message_sent", summary: `${message.kind === "initial" ? "Initial outreach" : `Follow-up ${message.sequenceNumber - 1}`} ${provider.reconciled ? "reconciled as already sent" : "sent"} to ${message.lead.email}`, metadata: { messageId: message.id, provider: settings.emailProvider, providerMessageId: provider.providerMessageId, providerThreadId: provider.providerThreadId, followUpDate: followUpDate?.toISOString() ?? null, sequenceId: sequence.id, idempotencyKey: message.idempotencyKey } } });
    return updated;
  });
}

async function sendClaimedMessage(prisma: PrismaClient, messageId: number) {
  const settings = await getAppSettings(prisma);
  const message = await assertSendEligible(prisma, messageId);
  if (message.status !== "sending") throw new Error("Message is not claimed for sending");
  const key = message.idempotencyKey ?? makeOutreachIdempotencyKey(message.id);

  try {
    const provider = await providerSend(prisma, message, settings, key);
    return await completeSend(prisma, { ...message, idempotencyKey: key }, settings, provider);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await prisma.outreachMessage.update({ where: { id: message.id }, data: { sendError: text } }).catch(() => undefined);
    throw error;
  }
}

export async function sendApprovedMessage(prisma: PrismaClient, messageId: number) {
  const lease = await acquireAutomationLease(prisma, "outreach-send", 60_000);
  if (!lease) throw new Error("Another send operation is already in progress");

  try {
    const settings = await getAppSettings(prisma);
    if (!isWithinSendWindow(settings.sendWindowStart, settings.sendWindowEnd)) throw new Error(`Outside configured send window (${settings.sendWindowStart}-${settings.sendWindowEnd})`);

    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const sentOrClaimedToday = await prisma.outreachMessage.count({ where: { OR: [{ status: "sent", sentAt: { gte: startOfDay } }, { status: "sending", sendAttemptedAt: { gte: startOfDay } }] } });
    if (sentOrClaimedToday >= settings.dailySendLimit) throw new Error(`Daily send limit reached (${settings.dailySendLimit})`);

    await assertSendEligible(prisma, messageId);
    const claim = await claimApprovedMessage(prisma, messageId);
    if (claim.state === "already_sent") return claim.message;
    return await sendClaimedMessage(prisma, messageId);
  } finally {
    await releaseAutomationLease(prisma, lease);
  }
}

export async function reconcileStaleSends(
  prisma: PrismaClient,
  limit = 10,
  resendClaimed: (prisma: PrismaClient, messageId: number) => Promise<unknown> = sendClaimedMessage,
) {
  const cutoff = new Date(Date.now() - STALE_SEND_MS);
  const messages = await prisma.outreachMessage.findMany({ where: { status: "sending", sendAttemptedAt: { lte: cutoff } }, orderBy: { sendAttemptedAt: "asc" }, take: limit, select: { id: true } });
  const results: Array<{ messageId: number; success: boolean; error?: string }> = [];

  for (const message of messages) {
    const lease = await acquireAutomationLease(prisma, "outreach-send", 60_000);
    if (!lease) { results.push({ messageId: message.id, success: false, error: "Send lock busy" }); break; }
    try {
      await prisma.outreachMessage.update({ where: { id: message.id }, data: { sendAttemptedAt: new Date() } });
      await resendClaimed(prisma, message.id);
      results.push({ messageId: message.id, success: true });
    } catch (error) {
      results.push({ messageId: message.id, success: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await releaseAutomationLease(prisma, lease);
    }
  }
  return results;
}

export async function sendApprovedQueue(prisma: PrismaClient, limit = 25) {
  const messages = await prisma.outreachMessage.findMany({ where: { status: "approved" }, orderBy: [{ lead: { priorityScore: { sort: "desc", nulls: "last" } } }, { approvedAt: "asc" }], take: limit, select: { id: true } });
  const results: Array<{ messageId: number; success: boolean; error?: string }> = [];
  for (const message of messages) {
    try { await sendApprovedMessage(prisma, message.id); results.push({ messageId: message.id, success: true }); }
    catch (error) { results.push({ messageId: message.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}
