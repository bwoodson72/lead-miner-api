import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { generateFollowUp, FOLLOWUP_PROMPT_VERSION } from "./ai-followup.js";
import { classifyReply, REPLY_PROMPT_VERSION } from "./ai-reply.js";
import { getActiveOutreachSequence, getAppSettings } from "./settings.js";
import { getGmailThread } from "./gmail.js";
import { syncLeadGmailPipelineLabelSafely } from "./gmail-pipeline.js";
import { handleGmailSendingLimitDeliveryNotice, isGmailAccountSendingLimitNotice } from "./gmail-send-safety.js";
import { sendApprovedMessage } from "./outreach-sending.js";
import { estimateAiCost } from "./ai-cost.js";
import { applyReplyAutomationStop, leadStatusForReply } from "./reply-state.js";
import { withAiCapacity } from "./ai-capacity.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";
import { FOLLOW_UP_COUNT, TOTAL_OUTREACH_TOUCHES, isBreakupSequenceNumber } from "./outreach-sequence.js";
import { assertAiBudgetAvailable, hashAiPacket } from "./ai-budget.js";
import { nextEligibleSendTime } from "./workflow-policy.js";
import { withOperatorOutreachNotes } from "./operator-outreach-notes.js";

function futureDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date > new Date() ? date : null;
}

function referralParts(value: string | null | undefined) {
  if (!value) return [] as Array<{ type: string; value: string }>;
  const parts: Array<{ type: string; value: string }> = [];
  const email = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = value.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/)?.[0];
  if (email) parts.push({ type: "email", value: email.toLowerCase() });
  if (phone) parts.push({ type: "phone", value: phone });
  return parts;
}

async function closeNoResponse(prisma: PrismaClient, leadId: number) {
  await prisma.lead.update({ where: { id: leadId }, data: { status: "closed_no_response", followUpDate: null } });
  await syncLeadGmailPipelineLabelSafely(prisma, leadId, "no-response closure");
}

async function generateDueFollowUp(prisma: PrismaClient, leadId: number) {
  const settings = await getAppSettings(prisma);
  const sequence = await getActiveOutreachSequence(prisma);
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      problems: { orderBy: { confidence: "desc" }, take: 5 },
      assetAssessments: { orderBy: { createdAt: "desc" }, take: 1, include: { findings: { orderBy: [{ significance: "desc" }, { confidence: "desc" }], take: 5 } } },
      outreachMessages: { where: { status: "sent" }, orderBy: { sequenceNumber: "asc" } },
      suppressions: true,
    },
  });
  if (!lead) throw new Error("Lead not found");
  if (!lead.email) throw new Error("Lead has no email");
  if (lead.replyStatus && lead.replyStatus !== "out_of_office") throw new Error("Lead has replied");
  if (lead.lastReplyAt && lead.replyStatus !== "out_of_office") throw new Error("Lead has replied");
  if (!lead.followUpDate || lead.followUpDate > new Date()) throw new Error("Follow-up is not due");
  if (lead.suppressions.length) throw new Error("Lead is suppressed");

  const sent = lead.outreachMessages;
  if (!sent.length) throw new Error("No sent initial outreach exists");
  const followupsAlreadySent = sent.filter((m) => m.kind === "followup").length;
  if (followupsAlreadySent >= FOLLOW_UP_COUNT || sent.length >= TOTAL_OUTREACH_TOUCHES) {
    await closeNoResponse(prisma, leadId);
    return null;
  }

  const sequenceNumber = Math.max(...sent.map((message) => message.sequenceNumber), 0) + 1;
  if (sequenceNumber > TOTAL_OUTREACH_TOUCHES) {
    await closeNoResponse(prisma, leadId);
    return null;
  }
  const existing = await prisma.outreachMessage.findFirst({ where: { leadId, sequenceNumber, kind: "followup", status: { in: ["draft", "approved", "sending", "sent"] } } });
  if (existing) return existing;

  const subject = sent[0]?.subject ?? "";
  const findings = lead.assetAssessments[0]?.findings ?? [];
  const evidenceProblems = findings.length
    ? findings.map((finding) => ({ title: finding.title, evidence: finding.evidence, businessConsequence: finding.assetCapability, confidence: finding.confidence }))
    : lead.problems.map((problem) => ({ title: problem.title, evidence: problem.evidence, businessConsequence: problem.businessConsequence, confidence: problem.confidence }));
  const followUpInstructions = withOperatorOutreachNotes(settings.followUpInstructions, lead.outreachNotes);
  const packetHash = hashAiPacket({ promptVersion: FOLLOWUP_PROMPT_VERSION, sequenceNumber, leadId, instructions: followUpInstructions, primaryOutreachAngle: lead.primaryOutreachAngle, priorMessages: sent.map((message) => ({ sequenceNumber: message.sequenceNumber, bodyText: message.bodyText })), evidenceProblems });
  await assertAiBudgetAvailable(prisma, settings);
  const job = await prisma.aIJob.create({ data: { leadId, type: "followup_draft", status: "running", model: settings.outreachModel, promptVersion: FOLLOWUP_PROMPT_VERSION, packetHash, startedAt: new Date() } });
  try {
    const generated = await withAiCapacity(prisma, () => generateFollowUp({ instructions: followUpInstructions, sequenceNumber, businessName: lead.businessName, domain: lead.domain, researchSummary: lead.researchSummary, primaryOutreachAngle: lead.primaryOutreachAngle, problems: evidenceProblems, priorMessages: sent.map((m) => ({ kind: m.kind, sequenceNumber: m.sequenceNumber, subject: m.subject, bodyText: m.bodyText })) }, settings.outreachModel));
    const autoApprove = settings.approvalMode === "auto_safe" && generated.draft.confidence >= settings.minAutoApproveConfidence;
    const followUpNumber = sequenceNumber - 1;
    const breakup = isBreakupSequenceNumber(sequenceNumber);
    return prisma.$transaction(async (tx) => {
      const message = await tx.outreachMessage.create({ data: { leadId, kind: "followup", sequenceNumber, subject, bodyText: generated.draft.bodyText, angle: generated.draft.angle, confidence: generated.draft.confidence, requiresReview: !autoApprove, promptVersion: FOLLOWUP_PROMPT_VERSION, status: autoApprove ? "approved" : "draft", approvedAt: autoApprove ? new Date() : null } });
      await tx.lead.update({ where: { id: leadId }, data: { replyStatus: lead.replyStatus === "out_of_office" ? null : lead.replyStatus, replySummary: lead.replyStatus === "out_of_office" ? null : lead.replySummary } });
      await tx.activity.create({ data: { leadId, type: autoApprove ? "followup_auto_approved" : "followup_generated", summary: `${autoApprove ? "Auto-approved" : "Generated"} follow-up ${followUpNumber}${breakup ? " (breakup)" : ""}`, metadata: { confidence: generated.draft.confidence, model: generated.model, sequenceId: sequence.id, followUpNumber, breakup, promptVersion: FOLLOWUP_PROMPT_VERSION } } });
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
  const safeLimit = capRequestedLimit(limit, SAFETY_LIMITS.automationFollowupMax, SAFETY_LIMITS.automationFollowupMax);
  const leads = await prisma.lead.findMany({ where: { status: "contacted", followUpDate: { lte: new Date() }, OR: [{ replyStatus: null }, { replyStatus: "out_of_office" }] }, orderBy: { followUpDate: "asc" }, take: safeLimit, select: { id: true } });
  const results: Array<{ leadId: number; generated?: number; sent?: boolean; success: boolean; error?: string }> = [];
  for (const lead of leads) {
    try {
      const message = await generateDueFollowUp(prisma, lead.id);
      if (!message) { results.push({ leadId: lead.id, success: true }); continue; }
      let sent = false;
      if (message.status === "approved") { await sendApprovedMessage(prisma, message.id); sent = true; }
      results.push({ leadId: lead.id, generated: message.id, sent, success: true });
    } catch (error) { results.push({ leadId: lead.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

async function syncLeadReply(prisma: PrismaClient, leadId: number) {
  const settings = await getAppSettings(prisma);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { outreachMessages: { where: { status: "sent", providerMessageId: { not: null } }, orderBy: { sequenceNumber: "asc" } }, emailThreads: { where: { provider: "gmail" }, orderBy: { updatedAt: "desc" }, take: 1 } } });
  if (!lead?.outreachMessages.length) return null;
  const canonicalThread = lead.emailThreads[0];
  const threadId = canonicalThread?.providerThreadId ?? lead.outreachMessages.at(-1)?.providerThreadId;
  if (!threadId) return null;
  const sentIds = new Set(lead.outreachMessages.map((m) => m.providerMessageId).filter(Boolean));
  const thread = await getGmailThread(threadId);
  const inbound = thread.filter((m) => !sentIds.has(m.id) && !(m.from ?? "").toLowerCase().includes(settings.senderEmail.toLowerCase())).sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());
  const latest = inbound.at(-1);
  const lastObservedInbound = [lead.lastReplyAt, canonicalThread?.lastInboundAt].filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime())[0];
  if (!latest || (lastObservedInbound && latest.internalDate <= lastObservedInbound)) return null;

  if (isGmailAccountSendingLimitNotice(latest)) {
    const handled = await handleGmailSendingLimitDeliveryNotice(prisma, {
      leadId,
      threadId,
      noticeAt: latest.internalDate,
      noticeText: latest.text,
    });
    await syncLeadGmailPipelineLabelSafely(prisma, leadId, "Gmail quota delivery notice", { threadId });
    return handled;
  }

  const replyInstructions = withOperatorOutreachNotes(settings.replyInstructions, lead.outreachNotes, "reply");
  const packetHash = hashAiPacket({ promptVersion: REPLY_PROMPT_VERSION, threadId, messageId: latest.id, text: latest.text, instructions: replyInstructions, context: thread.map((m) => ({ from: m.from, text: m.text })).slice(-8) });
  const identical = await prisma.aIJob.findFirst({ where: { leadId, type: "reply_classification", packetHash, status: "complete" } });
  if (identical) return null;
  await assertAiBudgetAvailable(prisma, settings);
  const job = await prisma.aIJob.create({ data: { leadId, type: "reply_classification", status: "running", model: settings.outreachModel, promptVersion: REPLY_PROMPT_VERSION, packetHash, startedAt: new Date() } });
  try {
    const classified = await withAiCapacity(prisma, () => classifyReply({ instructions: replyInstructions, replyText: latest.text, threadContext: thread.map((m) => ({ from: m.from, text: m.text })).slice(-8) }, settings.outreachModel));
    const c = classified.result.classification;
    const status = leadStatusForReply(c);
    const explicitReturn = futureDate(classified.result.returnDate);
    const oooResume = c === "out_of_office" ? nextEligibleSendTime(explicitReturn ?? new Date(Date.now() + 3 * 86400000), settings.sendWindowStart, settings.sendWindowEnd, settings.sendTimezone, settings.weekendSendingEnabled) : null;
    const revisitAt = c === "not_now" ? explicitReturn ?? new Date(Date.now() + 30 * 86400000) : oooResume;
    const referrals = referralParts(classified.result.referralContact);

    await prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { status, replyStatus: c, replySummary: classified.result.summary, lastReplyAt: c === "out_of_office" ? null : latest.internalDate, replyHandledAt: ["bounce", "unsubscribe", "spam_or_scam"].includes(c) ? new Date() : null, followUpDate: oooResume, revisitAt, ...(c === "bounce" ? { email: null, emailEnrichmentStatus: "retry", nextEmailEnrichmentAt: new Date(), emailEnrichmentReason: "Previous address bounced" } : {}) } });
      await tx.emailThread.upsert({ where: { providerThreadId: threadId }, update: { status: ["bounce", "unsubscribe", "spam_or_scam"].includes(c) ? "closed" : c === "out_of_office" ? "open" : "replied", lastInboundAt: latest.internalDate, recipientEmail: lead.email }, create: { leadId, provider: "gmail", providerThreadId: threadId, recipientEmail: lead.email, status: ["bounce", "unsubscribe", "spam_or_scam"].includes(c) ? "closed" : c === "out_of_office" ? "open" : "replied", lastInboundAt: latest.internalDate } });
      await tx.activity.create({ data: { leadId, type: "reply_received", summary: `${c}: ${classified.result.summary}`, metadata: { gmailMessageId: latest.id, providerThreadId: threadId, recommendedAction: classified.result.recommendedAction, extractedQuestion: classified.result.extractedQuestion, extractedObjection: classified.result.extractedObjection, referralContact: classified.result.referralContact, returnDate: classified.result.returnDate, suggestedResponse: settings.autoGenerateSuggestedReplies ? classified.result.suggestedResponse : null, confidence: classified.result.confidence, revisitAt: revisitAt?.toISOString() ?? null } } });
      await tx.activity.create({ data: { leadId, type: "reply_classified", summary: `Reply classified as ${c}`, metadata: { confidence: classified.result.confidence, recommendedAction: classified.result.recommendedAction } } });
      await applyReplyAutomationStop(tx, { leadId, classification: c, email: lead.email });
      for (const referral of referrals) await tx.contact.upsert({ where: { leadId_type_value: { leadId, type: referral.type, value: referral.value } }, update: { role: "referred contact", source: "reply_referral", verificationStatus: "unverified" }, create: { leadId, type: referral.type, value: referral.value, role: "referred contact", source: "reply_referral", verificationStatus: "unverified" } });
      await tx.aIJob.update({ where: { id: job.id }, data: { status: "complete", model: classified.model, inputTokens: classified.inputTokens, cachedTokens: classified.cachedTokens, outputTokens: classified.outputTokens, estimatedCost: estimateAiCost(classified.model, classified.inputTokens, classified.outputTokens), completedAt: new Date() } });
    });
    await syncLeadGmailPipelineLabelSafely(prisma, leadId, "reply classification", { threadId });
    return classified.result;
  } catch (error) {
    await prisma.aIJob.update({ where: { id: job.id }, data: { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date() } });
    throw error;
  }
}

export async function syncReplies(prisma: PrismaClient, limit = 50) {
  const safeLimit = capRequestedLimit(limit, SAFETY_LIMITS.automationReplySyncMax, SAFETY_LIMITS.automationReplySyncMax);
  const leads = await prisma.lead.findMany({ where: { OR: [{ emailThreads: { some: { provider: "gmail" } } }, { outreachMessages: { some: { status: "sent", providerThreadId: { not: null } } } }], status: { in: ["contacted", "replied", "interested", "closed_no_response", "lost"] } }, orderBy: { lastOutreachDate: "desc" }, take: safeLimit, select: { id: true } });
  const results: Array<{ leadId: number; reply?: string; success: boolean; error?: string }> = [];
  for (const lead of leads) { try { const result = await syncLeadReply(prisma, lead.id); results.push({ leadId: lead.id, reply: result?.classification, success: true }); } catch (error) { results.push({ leadId: lead.id, success: false, error: error instanceof Error ? error.message : String(error) }); } }
  return results;
}

export function registerFollowupReplyRoutes(app: Express, prisma: PrismaClient) {
  app.post("/api/followups/process", async (req, res) => {
    const requested = Number(req.body?.limit ?? SAFETY_LIMITS.automationFollowupMax);
    if (Number.isFinite(requested) && requested > SAFETY_LIMITS.automationFollowupMax) { res.status(400).json({ error: `Follow-up processing is capped at ${SAFETY_LIMITS.automationFollowupMax} leads per request` }); return; }
    try { const results = await processDueFollowUps(prisma, requested); res.json({ processed: results.length, cap: SAFETY_LIMITS.automationFollowupMax, results }); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/inbox/sync", async (req, res) => {
    const requested = Number(req.body?.limit ?? SAFETY_LIMITS.automationReplySyncMax);
    if (Number.isFinite(requested) && requested > SAFETY_LIMITS.automationReplySyncMax) { res.status(400).json({ error: `Inbox sync is capped at ${SAFETY_LIMITS.automationReplySyncMax} leads per request` }); return; }
    try { const results = await syncReplies(prisma, requested); res.json({ processed: results.length, cap: SAFETY_LIMITS.automationReplySyncMax, results }); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/inbox/actions", async (_req, res) => {
    try {
      const leads = await prisma.lead.findMany({ where: { replyHandledAt: null, replyStatus: { in: ["interested", "question", "objection", "not_now", "wrong_person", "referral", "out_of_office", "booking_intent", "other"] } }, orderBy: [{ status: "asc" }, { lastReplyAt: "desc" }], include: { activities: { where: { type: "reply_received" }, orderBy: { createdAt: "desc" }, take: 1 }, outreachMessages: { orderBy: { sequenceNumber: "asc" } }, emailThreads: { orderBy: { updatedAt: "desc" } }, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } } });
      res.json({ leads, total: leads.length });
    } catch (error) { res.status(500).json({ error: error instanceof Error?error.message:String(error) }); }
  });
  app.post("/api/inbox/:id/resolve", async (req, res) => { const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; } try { const lead = await prisma.lead.update({ where: { id }, data: { replyHandledAt: new Date() } }); await prisma.activity.create({ data: { leadId: id, type: "reply_handled", summary: "Reply marked handled" } }); res.json(lead); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); } });
}
