import { Resend } from "resend";
import type { PrismaClient } from "../generated/prisma/client.js";
import { getEnv } from "./env.js";
import { getAppSettings } from "./settings.js";

const DAY_MS = 86_400_000;

function nextFollowUpDate(delays: unknown, sequenceNumber: number): Date | null {
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

export async function sendApprovedMessage(prisma: PrismaClient, messageId: number) {
  const settings = await getAppSettings(prisma);
  if (!inSendWindow(settings.sendWindowStart, settings.sendWindowEnd)) throw new Error(`Outside configured send window (${settings.sendWindowStart}-${settings.sendWindowEnd})`);

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const sentToday = await prisma.outreachMessage.count({ where: { status: "sent", sentAt: { gte: startOfDay } } });
  if (sentToday >= settings.dailySendLimit) throw new Error(`Daily send limit reached (${settings.dailySendLimit})`);

  const message = await prisma.outreachMessage.findUnique({ where: { id: messageId }, include: { lead: { include: { suppressions: true } } } });
  if (!message) throw new Error("Message not found");
  if (message.status !== "approved") throw new Error("Only approved messages can be sent");
  if (!message.lead.email) throw new Error("Lead has no email address");
  if (message.lead.replyStatus || message.lead.lastReplyAt) throw new Error("Lead has already replied");
  if (["replied", "responded", "interested", "call_scheduled", "proposal_sent", "won", "lost", "rejected", "bounced", "unsubscribed"].includes(message.lead.status)) throw new Error(`Lead status ${message.lead.status} is not send-eligible`);
  if (message.lead.suppressions.some((s) => s.value.toLowerCase() === message.lead.email!.toLowerCase() || s.value.toLowerCase() === message.lead.domain.toLowerCase())) throw new Error("Lead or email is suppressed");

  const env = getEnv();
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const resend = new Resend(env.RESEND_API_KEY);
  const from = `${settings.senderName} <${settings.senderEmail}>`;
  const result = await resend.emails.send({ from, to: message.lead.email, subject: message.subject, text: message.bodyText });
  if (result.error) throw new Error(result.error.message);
  if (!result.data?.id) throw new Error("Email provider returned no message id");

  const sentAt = new Date();
  const followUpDate = nextFollowUpDate(settings.followUpDelaysDays, message.sequenceNumber);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.outreachMessage.update({ where: { id: message.id }, data: { status: "sent", sentAt, providerMessageId: result.data!.id } });
    await tx.lead.update({ where: { id: message.leadId }, data: { status: "contacted", outreachCount: { increment: 1 }, firstContactAt: message.lead.firstContactAt ?? sentAt, lastOutreachDate: sentAt, followUpDate } });
    await tx.activity.create({ data: { leadId: message.leadId, type: "message_sent", summary: `${message.kind === "initial" ? "Initial outreach" : `Follow-up ${message.sequenceNumber - 1}`} sent to ${message.lead.email}`, metadata: { messageId: message.id, providerMessageId: result.data!.id, followUpDate: followUpDate?.toISOString() ?? null } } });
    return updated;
  });
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
