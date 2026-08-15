import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { calculatePriority, researchLead, RESEARCH_VERSION } from "./ai-research.js";
import { generateOutreachDraft, OUTREACH_PROMPT_VERSION } from "./ai-outreach.js";
import { getAppSettings } from "./settings.js";
import { estimateAiCost } from "./ai-cost.js";
import { registerEnrichmentRoutes } from "./enrichment-routes.js";
import { prepareLeadForResearch, type ResearchPreparationResult } from "./research-preparation.js";
import { acquireAutomationLease, acquireAutomationSlot, releaseAutomationLease } from "./automation-lock.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

async function withAiCapacity<T>(prisma: PrismaClient, operation: () => Promise<T>): Promise<T> {
  const slot = await acquireAutomationSlot(prisma, "ai-work", SAFETY_LIMITS.aiResearchConcurrency, 10 * 60_000);
  if (!slot) throw new Error(`AI concurrency limit reached (${SAFETY_LIMITS.aiResearchConcurrency})`);
  try { return await operation(); }
  finally { await releaseAutomationLease(prisma, slot); }
}

export async function ensureInitialOutreachDraft(prisma: PrismaClient, leadId: number) {
  const settings = await getAppSettings(prisma);
  if (!settings.autoDraftOutreach) return null;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { problems: { orderBy: [{ outreachValue: "desc" }, { confidence: "desc" }] } } });
  if (!lead || lead.qualificationDecision !== "qualified" || !lead.email) return null;
  const existing = await prisma.outreachMessage.findFirst({ where: { leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved", "sending", "sent"] } }, orderBy: { generatedAt: "desc" } });
  if (existing) { if (lead.status === "qualified") await prisma.lead.update({ where: { id: leadId }, data: { status: "ready_for_outreach" } }); return existing; }
  const aiJob = await prisma.aIJob.create({ data: { leadId, type: "outreach_draft", status: "running", model: settings.outreachModel, promptVersion: OUTREACH_PROMPT_VERSION, startedAt: new Date() } });
  try {
    const generated = await withAiCapacity(prisma, () => generateOutreachDraft({ businessName: lead.businessName, domain: lead.domain, keyword: lead.keyword, primaryOutreachAngle: lead.primaryOutreachAngle, researchSummary: lead.researchSummary, qualificationReason: lead.qualificationReason, problems: lead.problems }, settings.outreachModel, settings.minProblemConfidence, settings.outreachInstructions));
    const shouldAutoApprove = settings.approvalMode === "auto_safe" && (lead.priorityScore ?? 0) >= settings.minAutoApprovePriority && generated.draft.confidence >= settings.minAutoApproveConfidence;
    const status = shouldAutoApprove ? "approved" : "draft";
    return prisma.$transaction(async (tx) => {
      const message = await tx.outreachMessage.create({ data: { leadId, kind: "initial", sequenceNumber: 1, subject: generated.draft.subject, bodyText: generated.draft.bodyText, angle: generated.draft.angle, status, approvedAt: shouldAutoApprove ? new Date() : null } });
      await tx.lead.update({ where: { id: leadId }, data: { status: "ready_for_outreach" } });
      await tx.activity.create({ data: { leadId, type: shouldAutoApprove ? "message_auto_approved" : "message_generated", summary: `${shouldAutoApprove ? "Auto-approved" : "Generated"} initial outreach: ${generated.draft.subject}`, metadata: { confidence: generated.draft.confidence, model: generated.model, approvalMode: settings.approvalMode } } });
      await tx.aIJob.update({ where: { id: aiJob.id }, data: { status: "complete", model: generated.model, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, estimatedCost: estimateAiCost(generated.model, generated.inputTokens, generated.outputTokens), completedAt: new Date() } });
      return message;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.aIJob.update({ where: { id: aiJob.id }, data: { status: "failed", error: message, completedAt: new Date() } });
    await prisma.activity.create({ data: { leadId, type: "message_generation_failed", summary: message } });
    throw error;
  }
}

export async function processLeadResearch(prisma: PrismaClient, leadId: number) {
  const lease = await acquireAutomationLease(prisma, `lead-research-${leadId}`, 10 * 60_000);
  if (!lease) throw new Error("Lead research is already running");
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new Error("Lead not found");
    if (!lead.email) throw new Error("Lead has no email; contact enrichment must succeed before AI research");
    const settings = await getAppSettings(prisma);
    const job = await prisma.aIJob.create({ data: { leadId, type: "lead_research", status: "running", model: settings.researchModel, promptVersion: RESEARCH_VERSION, startedAt: new Date() } });
    try {
      const { result, model, inputTokens, outputTokens } = await withAiCapacity(prisma, () => researchLead(lead, settings.researchModel, settings.researchInstructions));
      const priorityScore = calculatePriority(result.scores);
      const nextStatus = result.decision === "qualified" ? "qualified" : result.decision === "disqualified" ? "disqualified" : lead.status;
      await prisma.$transaction(async (tx) => {
        await tx.leadProblem.deleteMany({ where: { leadId } });
        if (result.problems.length) await tx.leadProblem.createMany({ data: result.problems.map((p) => ({ leadId, category: p.category, title: p.title, evidence: p.evidence, businessConsequence: p.businessConsequence, recommendedImprovement: p.recommendedImprovement || null, confidence: p.confidence, outreachValue: p.outreachValue })) });
        await tx.leadScore.create({ data: { leadId, ...result.scores, compositeScore: priorityScore, model, researchVersion: RESEARCH_VERSION } });
        await tx.lead.update({ where: { id: leadId }, data: { status: nextStatus, qualificationDecision: result.decision, qualificationReason: result.qualificationReason, priorityScore, primaryOutreachAngle: result.primaryOutreachAngle, researchSummary: result.researchSummary, researchVersion: RESEARCH_VERSION, lastResearchedAt: new Date() } });
        await tx.activity.create({ data: { leadId, type: "research_completed", summary: `${result.decision}: ${result.qualificationReason}`, metadata: { priorityScore, confidence: result.confidence, model } } });
        await tx.aIJob.update({ where: { id: job.id }, data: { status: "complete", model, inputTokens, outputTokens, estimatedCost: estimateAiCost(model, inputTokens, outputTokens), completedAt: new Date() } });
      });
      let draft = null;
      if (result.decision === "qualified") { try { draft = await ensureInitialOutreachDraft(prisma, leadId); } catch (error) { console.error(`[AI] Draft generation failed for lead ${leadId}:`, error); } }
      return { result, priorityScore, draft };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.aIJob.update({ where: { id: job.id }, data: { status: "failed", error: message, completedAt: new Date() } });
      await prisma.activity.create({ data: { leadId, type: "research_failed", summary: message } });
      throw error;
    }
  } finally {
    await releaseAutomationLease(prisma, lease);
  }
}

export async function processResearchReadyLeads(prisma: PrismaClient, limit = 10) {
  const safeLimit = capRequestedLimit(limit, 10, SAFETY_LIMITS.bulkResearchMax);
  const leads = await prisma.lead.findMany({
    where: {
      email: { not: null },
      status: { in: ["new", "research_pending"] },
      lastResearchedAt: null,
      aiJobs: { none: { type: "lead_research", status: { in: ["running", "complete"] } } },
    },
    orderBy: { createdAt: "asc" },
    take: safeLimit,
    select: { id: true },
  });
  const results: Array<{ id: number; success: boolean; decision?: string; priorityScore?: number; draftId?: number; error?: string }> = [];
  for (const lead of leads) {
    try {
      const processed = await processLeadResearch(prisma, lead.id);
      results.push({ id: lead.id, success: true, decision: processed.result.decision, priorityScore: processed.priorityScore, draftId: processed.draft?.id });
    } catch (error) {
      results.push({ id: lead.id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

type PreparedResearchResult = {
  id: number;
  preparation: ResearchPreparationResult;
  success: boolean;
  skipped?: boolean;
  decision?: string;
  priorityScore?: number;
  draftId?: number;
  error?: string;
};

export async function processPreparedResearchBatch(prisma: PrismaClient, leadIds: number[]) {
  const results: PreparedResearchResult[] = [];

  for (const id of leadIds) {
    const preparation = await prepareLeadForResearch(prisma, id);
    if (!preparation.ready) {
      results.push({
        id,
        preparation,
        success: false,
        skipped: true,
        error: preparation.reason ?? `Lead is not research-ready (${preparation.status})`,
      });
      continue;
    }

    try {
      const processed = await processLeadResearch(prisma, id);
      results.push({
        id,
        preparation,
        success: true,
        decision: processed.result.decision,
        priorityScore: processed.priorityScore,
        draftId: processed.draft?.id,
      });
    } catch (error) {
      results.push({
        id,
        preparation,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function statusForResearchError(message: string) {
  if (/lead not found/i.test(message)) return 404;
  if (/already running|concurrency limit/i.test(message)) return 409;
  if (/no email|not research-ready|enrichment.*(?:exhausted|retry|found but)/i.test(message)) return 422;
  if (/openai|provider|fetch failed|econn|etimedout|429|502|503|504/i.test(message)) return 502;
  return 500;
}

export function registerResearchRoutes(app: Express, prisma: PrismaClient) {
  registerEnrichmentRoutes(app, prisma);
  app.get("/api/leads/:id/research", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    const lead = await prisma.lead.findUnique({ where: { id }, include: { problems: { orderBy: { confidence: "desc" } }, scores: { orderBy: { createdAt: "desc" }, take: 1 }, activities: { orderBy: { createdAt: "desc" }, take: 50 }, outreachMessages: { orderBy: { generatedAt: "desc" } } } });
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; } res.json(lead);
  });
  app.post("/api/leads/:id/research", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    let preparation: ResearchPreparationResult | null = null;
    try {
      preparation = await prepareLeadForResearch(prisma, id);
      if (!preparation.ready) {
        const message = preparation.reason ?? `Lead is not research-ready (${preparation.status})`;
        const status = preparation.status === "deferred" ? 409 : preparation.status === "missing" ? 404 : 422;
        console.warn(`[Research] Lead ${id} blocked before AI — status=${preparation.status}, reason=${message}`);
        res.status(status).json({ error: message, stage: "preparation", preparation });
        return;
      }
      await processLeadResearch(prisma, id);
      res.json({
        preparation,
        lead: await prisma.lead.findUnique({ where: { id }, include: { problems: true, scores: { orderBy: { createdAt: "desc" }, take: 1 }, outreachMessages: { orderBy: { generatedAt: "desc" } } } }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = statusForResearchError(message);
      console.error(`[Research] Lead ${id} failed — stage=${preparation?.ready ? "research" : "preparation"}, status=${status}, error=${message}`, error);
      res.status(status).json({ error: message, stage: preparation?.ready ? "research" : "preparation", preparation });
    }
  });
  app.post("/api/leads/bulk-research", async (req, res) => {
    const requested = Array.isArray(req.body?.ids)
      ? Array.from(new Set(req.body.ids.filter((id: unknown) => Number.isInteger(id) && Number(id) > 0) as number[]))
      : [];
    if (requested.length > SAFETY_LIMITS.bulkResearchMax) { res.status(400).json({ error: `Bulk research is capped at ${SAFETY_LIMITS.bulkResearchMax} leads per request` }); return; }

    const settings = await getAppSettings(prisma);
    const batchLimit = Math.min(settings.researchBatchSize, SAFETY_LIMITS.bulkResearchMax);
    const leadIds = requested.length
      ? requested.slice(0, batchLimit)
      : (await prisma.lead.findMany({
          where: { status: { in: ["new", "research_pending"] }, lastResearchedAt: null },
          orderBy: { createdAt: "asc" },
          take: batchLimit,
          select: { id: true },
        })).map((lead) => lead.id);

    const results = await processPreparedResearchBatch(prisma, leadIds);
    const alreadyHadEmail = results.filter((r) => r.preparation.alreadyHadEmail).length;
    const enrichmentAttempted = results.filter((r) => r.preparation.enrichmentAttempted).length;
    const emailsDiscovered = results.filter((r) => r.preparation.status === "email_found").length;
    const enrichmentExhausted = results.filter((r) => r.preparation.status === "exhausted").length;
    const enrichmentDeferred = results.filter((r) => r.preparation.status === "deferred").length;
    const enrichmentFailed = results.filter((r) => r.preparation.status === "failed" || r.preparation.status === "missing").length;
    const researched = results.filter((r) => r.success).length;
    const researchFailed = results.filter((r) => r.preparation.ready && !r.success).length;
    const skippedNoEmail = results.filter((r) => !r.preparation.ready && r.preparation.status !== "missing").length;

    res.json({
      selected: requested.length || leadIds.length,
      selectedForThisBatch: leadIds.length,
      cap: batchLimit,
      alreadyHadEmail,
      enrichmentAttempted,
      emailsDiscovered,
      enrichmentExhausted,
      enrichmentDeferred,
      enrichmentFailed,
      researchEligible: results.filter((r) => r.preparation.ready).length,
      researched,
      researchFailed,
      skippedNoEmail,
      processed: results.length,
      results,
    });
  });
}
