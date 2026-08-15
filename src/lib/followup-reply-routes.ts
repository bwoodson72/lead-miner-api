import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { generateFollowUp, FOLLOWUP_PROMPT_VERSION } from "./ai-followup.js";
import { classifyReply, REPLY_PROMPT_VERSION } from "./ai-reply.js";
import { getActiveOutreachSequence, getAppSettings } from "./settings.js";
import { getGmailThread } from "./gmail.js";
import { sendApprovedMessage } from "./outreach-sending.js";
import { estimateAiCost } from "./ai-cost.js";

async function generateDueFollowUp(prisma: PrismaClient, leadId: number) {
  const settings = await getAppSettings(prisma);
  const sequence = await getActiveOutreachSequence(prisma);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { problems: { orderBy: { confidence: "desc" }, take: 5 }, outreachMessages: { where: { status: "sent" }, orderBy: { sequenceNumber: "asc" } }, suppressions: true } });
  if (!lead) throw new Error("Lead not found");
  if (!lead.email) throw new Error("Lead has no email");
  if (lead.replyStatus || lead.lastReplyAt) throw new Error("Lead has replied");
  if (!lead.followUpDate || lead.followUpDate > new Date()) throw new Error("Follow-up is not due");
  if (lead.suppressions.length) throw new Error("Lead is suppressed");

  const sent = lead.outreachMessages;
  if (!sent.length) throw new Error("No sent initial outreach exists");
  const delays = Array.isArray(sequence.delaysDays) ? sequence.delaysDays : [];
  const followupsAlreadySent = sent.filter((m) => m.kind === "followup").length;
  if (followupsAlreadySent >= delays.length || sent.length >= sequence.maxTouches) { await prisma.lead.update({ where: { id: leadId }, data: { status: "closed_no_response", followUpDate: null } }); return null; }

  const sequenceNumber = sent.length + 1;
  const existing = await prisma.outreachMessage.findFirst({ where: { leadId, sequenceNumber, kind: "followup", status: { in: ["draft", "approved", "sending", "sent"] } } });
  if (existing) return existing;

  const subject = sent[0]?.subject ?? "";
  const job = await prisma.aIJob.create({ data: { leadId, type: "followup_draft", status: "running", model: settings.outreachModel, promptVersion: FOLLOWUP_PROMPT_VERSION, startedAt: new Date() } });
  try {
    const generated = await generateFollowUp({ instructions: settings.followUpInstructions, sequenceNumber, businessName: lead.businessName, domain: lead.domain, researchSummary: lead.researchSummary, primaryOutreachAngle: lead.primaryOutreachAngle, problems: lead.problems, priorMessages: sent.map((m) => ({ kind: m.kind, sequenceNumber: m.sequenceNumber, subject: m.subject, bodyText: m.bodyText })) }, settings.outreachModel);
    const autoApprove = settings.approvalMode === "auto_safe" && generated.draft.confidence >= settings.minAutoApproveConfidence;
    return prisma.$transaction(async (tx) => {
      const message = await tx.outreachMessage.create({ data: { leadId, kind: "followup", sequenceNumber, subject, bodyText: generated.draft.bodyText, angle: generated.draft.angle, status: autoApprove ? "approved" : "draft", approvedAt: autoApprove ? new Date() : null } });
      await tx.activity.create({ data: { leadId, type: autoApprove ? "followup_auto_approved" : "followup_generated", summary: `${autoApprove ? "Auto-approved" : "Generated"} follow-up ${sequenceNumber - 1}`, metadata: { confidence: generated.draft.confidence, model: generated.model, sequenceId: sequence.id } } });
      await tx.aIJob.update({ where: { id: job.id }, data: { status: "complete", model: generated.model, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, estimatedCost: estimateAiCost(generated.model, generated.inputTokens, generated.outputTokens), completedAt: new Date() } });
      return message;
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await prisma.aIJob.update({ where: { id: job.id }, data: { status: "failed", error: text, completedAt: new Date() } });
    throw error;
  }
}

export async function processDueFollowUps(prisma: PrismaClient, limit = 25) {
  const leads = await prisma.lead.findMany({ where: { status: "contacted", followUpDate: { lte: new Date() }, replyStatus: null, lastReplyAt: null }, orderBy: { followUpDate: "asc" }, take: limit, select: { id: true } });
  const results: Array<{ leadId: number; generated?: number; sent?: boolean; success: boolean; error?: string }> = [];
  for (const lead of leads) {
    try { const message = await generateDueFollowUp(prisma, lead.id); if (!message) { results.push({ leadId: lead.id, success: true }); continue; } let sent = false; if (message.status === "approved") { await sendApprovedMessage(prisma, message.id); sent = true; } results.push({ leadId: lead.id, generated: message.id, sent, success: true }); }
    catch (error) { results.push({ leadId: lead.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

async function syncLeadReply(prisma: PrismaClient, leadId: number) {
  const settings = await getAppSettings(prisma);
  if (settings.emailProvider !== "gmail") throw new Error("Reply sync requires Gmail provider");
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { outreachMessages: { where: { status: "sent", providerMessageId: { not: null } }, orderBy: { sequenceNumber: "asc" } }, emailThreads: { where: { provider: "gmail", status: "open" }, orderBy: { updatedAt: "desc" }, take: 1 } } });
  if (!lead?.outreachMessages.length) return null;
  const canonicalThread = lead.emailThreads[0];
  const threadId = canonicalThread?.providerThreadId ?? lead.outreachMessages.at(-1)?.providerThreadId;
  if (!threadId) return null;
  const sentIds = new Set(lead.outreachMessages.map((m) => m.providerMessageId).filter(Boolean));
  const thread = await getGmailThread(threadId);
  const inbound = thread.filter((m) => !sentIds.has(m.id) && !(m.from ?? "").toLowerCase().includes(settings.senderEmail.toLowerCase())).sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());
  const latest = inbound.at(-1);
  if (!latest || (lead.lastReplyAt && latest.internalDate <= lead.lastReplyAt)) return null;

  const job = await prisma.aIJob.create({ data: { leadId, type: "reply_classification", status: "running", model: settings.outreachModel, promptVersion: REPLY_PROMPT_VERSION, startedAt: new Date() } });
  try {
    const classified = await classifyReply({ instructions: settings.replyInstructions, replyText: latest.text, threadContext: thread.map((m) => ({ from: m.from, text: m.text })).slice(-8) }, settings.outreachModel);
    const c = classified.result.classification;
    const status = c === "interested" || c === "booking_intent" ? "interested" : c === "bounce" ? "bounced" : c === "unsubscribe" ? "unsubscribed" : "replied";
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { status, replyStatus: c, replySummary: classified.result.summary, lastReplyAt: latest.internalDate, replyHandledAt: null, followUpDate: null } });
      await tx.emailThread.upsert({ where: { providerThreadId: threadId }, update: { status: c === "bounce" || c === "unsubscribe" ? "closed" : "replied", lastInboundAt: latest.internalDate, recipientEmail: lead.email }, create: { leadId, provider: "gmail", providerThreadId: threadId, recipientEmail: lead.email, status: c === "bounce" || c === "unsubscribe" ? "closed" : "replied", lastInboundAt: latest.internalDate } });
      await tx.activity.create({ data: { leadId, type: "reply_received", summary: `${c}: ${classified.result.summary}`, metadata: { gmailMessageId: latest.id, providerThreadId: threadId, recommendedAction: classified.result.recommendedAction, confidence: classified.result.confidence } } });
      if ((c === "unsubscribe" || c === "bounce") && lead.email) await tx.suppression.upsert({ where: { type_value: { type: "email", value: lead.email.toLowerCase() } }, update: { reason: c }, create: { leadId, type: "email", value: lead.email.toLowerCase(), reason: c } });
      await tx.aIJob.update({ where: { id: job.id }, data: { status: "complete", model: classified.model, inputTokens: classified.inputTokens, outputTokens: classified.outputTokens, estimatedCost: estimateAiCost(classified.model, classified.inputTokens, classified.outputTokens), completedAt: new Date() } });
    });
    return classified.result;
  } catch (error) {
    await prisma.aIJob.update({ where: { id: job.id }, data: { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date() } });
    throw error;
  }
}

export async function syncReplies(prisma: PrismaClient, limit = 50) {
  const leads = await prisma.lead.findMany({ where: { OR: [{ emailThreads: { some: { provider: "gmail" } } }, { outreachMessages: { some: { status: "sent", providerThreadId: { not: null } } } }], status: { in: ["contacted", "replied", "interested"] } }, orderBy: { lastOutreachDate: "desc" }, take: limit, select: { id: true } });
  const results: Array<{ leadId: number; reply?: string; success: boolean; error?: string }> = [];
  for (const lead of leads) { try { const result = await syncLeadReply(prisma, lead.id); results.push({ leadId: lead.id, reply: result?.classification, success: true }); } catch (error) { results.push({ leadId: lead.id, success: false, error: error instanceof Error ? error.message : String(error) }); } }
  return results;
}

export function registerFollowupReplyRoutes(app: Express, prisma: PrismaClient) {
  app.post("/api/followups/process", async (req, res) => { try { const results = await processDueFollowUps(prisma, Math.min(Math.max(Number(req.body?.limit ?? 25), 1), 100)); res.json({ processed: results.length, results }); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/inbox/sync", async (req, res) => { try { const results = await syncReplies(prisma, Math.min(Math.max(Number(req.body?.limit ?? 50), 1), 200)); res.json({ processed: results.length, results }); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.get("/api/inbox/actions", async (_req, res) => { try { const leads = await prisma.lead.findMany({ where: { replyHandledAt: null, replyStatus: { in: ["interested", "question", "objection", "not_now", "wrong_person", "referral", "booking_intent", "other"] } }, orderBy: { lastReplyAt: "desc" }, include: { activities: { where: { type: "reply_received" }, orderBy: { createdAt: "desc" }, take: 1 }, outreachMessages: { orderBy: { sequenceNumber: "asc" } }, emailThreads: { orderBy: { updatedAt: "desc" } }, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } } }); res.json({ leads, total: leads.length }); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/inbox/:id/resolve", async (req, res) => { const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; } try { const lead = await prisma.lead.update({ where: { id }, data: { replyHandledAt: new Date() } }); await prisma.activity.create({ data: { leadId: id, type: "reply_handled", summary: "Reply marked handled" } }); res.json(lead); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); } });
}
