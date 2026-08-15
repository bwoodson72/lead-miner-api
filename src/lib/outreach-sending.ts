import { Resend } from "resend";
import type { PrismaClient } from "../generated/prisma/client.js";
import { getEnv } from "./env.js";
import { getAppSettings } from "./settings.js";
import { getGmailMessage, sendGmailMessage } from "./gmail.js";
import { acquireAutomationLease, releaseAutomationLease } from "./automation-lock.js";

const DAY_MS = 86_400_000;
const STALE_SEND_MS = 2 * 60_000;

export function nextFollowUpDate(delays: unknown, sequenceNumber: number): Date | null {
  const values = Array.isArray(delays) ? delays.filter((v): v is number => Number.isInteger(v) && Number(v) > 0) : [];
  const delay = values[sequenceNumber - 1];
  return delay ? new Date(Date.now() + delay * DAY_MS) : null;
}

function inSendWindow(start: string, end: string, now = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return minutes >= sh * 60 + sm && minutes <= eh * 60 + em;
}

function idempotencyKey(messageId: number) {
  return `lead-miner/outreach/${messageId}`;
}

function gmailRfcMessageId(messageId: number, senderEmail: string) {
  const domain = senderEmail.split("@")[1] || "lead-miner.local";
  return `<lead-miner-outreach-${messageId}@${domain}>`;
}

async function providerSend(prisma: PrismaClient, message: any, settings: any, key: string) {
  if (settings.emailProvider === "gmail") {
    const prior = await prisma.outreachMessage.findFirst({ where: { leadId: message.leadId, status: "sent", providerThreadId: { not: null } }, orderBy: { sequenceNumber: "desc" } });
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
      messageId: gmailRfcMessageId(message.id, settings.senderEmail),
      threadId: prior?.providerThreadId ?? null,
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
  if (!message.lead.email) throw new Error("Lead has no email address");
  if (message.lead.replyStatus || message.lead.lastReplyAt) throw new Error("Lead has already replied");
  if (["replied", "responded", "interested", "call_scheduled", "proposal_sent", "won", "lost", "rejected", "bounced", "unsubscribed", "closed_no_response"].includes(message.lead.status)) throw new Error(`Lead status ${message.lead.status} is not send-eligible`);
  const email = message.lead.email.toLowerCase();
  const domain = message.lead.domain.toLowerCase();
  if (message.lead.suppressions.some((s) => s.value.toLowerCase() === email || s.value.toLowerCase() === domain)) throw new Error("Lead or email is suppressed");
  return message;
}

async function completeSend(prisma: PrismaClient, message: any, settings: any, provider: { providerMessageId: string; providerThreadId: string | null; reconciled: boolean }) {
  const sentAt = new Date();
  const followUpDate = nextFollowUpDate(settings.followUpDelaysDays, message.sequenceNumber);
  const nextStatus = followUpDate ? "contacted" : "closed_no_response";

  return prisma.$transaction(async (tx) => {
    const updated = await tx.outreachMessage.update({ where: { id: message.id }, data: { status: "sent", sentAt, sendError: null, providerMessageId: provider.providerMessageId, providerThreadId: provider.providerThreadId } });
    await tx.lead.update({ where: { id: message.leadId }, data: { status: nextStatus, outreachCount: { increment: 1 }, firstContactAt: message.lead.firstContactAt ?? sentAt, lastOutreachDate: sentAt, followUpDate } });
    await tx.activity.create({ data: { leadId: message.leadId, type: provider.reconciled ? "message_send_reconciled" : "message_sent", summary: `${message.kind === "initial" ? "Initial outreach" : `Follow-up ${message.sequenceNumber - 1}`} ${provider.reconciled ? "reconciled as already sent" : "sent"} to ${message.lead.email}`, metadata: { messageId: message.id, provider: settings.emailProvider, providerMessageId: provider.providerMessageId, providerThreadId: provider.providerThreadId, followUpDate: followUpDate?.toISOString() ?? null, idempotencyKey: message.idempotencyKey } } });
    return updated;
  });
}

async function sendClaimedMessage(prisma: PrismaClient, messageId: number) {
  const settings = await getAppSettings(prisma);
  const message = await assertSendEligible(prisma, messageId);
  if (message.status !== "sending") throw new Error("Message is not claimed for sending");
  const key = message.idempotencyKey ?? idempotencyKey(message.id);

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
    if (!inSendWindow(settings.sendWindowStart, settings.sendWindowEnd)) throw new Error(`Outside configured send window (${settings.sendWindowStart}-${settings.sendWindowEnd})`);

    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const sentOrClaimedToday = await prisma.outreachMessage.count({ where: { OR: [{ status: "sent", sentAt: { gte: startOfDay } }, { status: "sending", sendAttemptedAt: { gte: startOfDay } }] } });
    if (sentOrClaimedToday >= settings.dailySendLimit) throw new Error(`Daily send limit reached (${settings.dailySendLimit})`);

    await assertSendEligible(prisma, messageId);
    const key = idempotencyKey(messageId);
    const claimed = await prisma.outreachMessage.updateMany({
      where: { id: messageId, status: "approved" },
      data: { status: "sending", sendAttemptedAt: new Date(), sendError: null, idempotencyKey: key },
    });
    if (claimed.count !== 1) {
      const current = await prisma.outreachMessage.findUnique({ where: { id: messageId } });
      if (current?.status === "sent") return current;
      throw new Error(`Message is not available to send (status: ${current?.status ?? "missing"})`);
    }

    return await sendClaimedMessage(prisma, messageId);
  } finally {
    await releaseAutomationLease(prisma, lease);
  }
}

export async function reconcileStaleSends(prisma: PrismaClient, limit = 10) {
  const cutoff = new Date(Date.now() - STALE_SEND_MS);
  const messages = await prisma.outreachMessage.findMany({ where: { status: "sending", sendAttemptedAt: { lte: cutoff } }, orderBy: { sendAttemptedAt: "asc" }, take: limit, select: { id: true } });
  const results: Array<{ messageId: number; success: boolean; error?: string }> = [];

  for (const message of messages) {
    const lease = await acquireAutomationLease(prisma, "outreach-send", 60_000);
    if (!lease) { results.push({ messageId: message.id, success: false, error: "Send lock busy" }); break; }
    try {
      await prisma.outreachMessage.update({ where: { id: message.id }, data: { sendAttemptedAt: new Date() } });
      await sendClaimedMessage(prisma, message.id);
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
