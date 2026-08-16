import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { researchLead, RESEARCH_VERSION, type ResearchResult } from "./ai-research.js";
import { generateOutreachDraft, OUTREACH_PROMPT_VERSION } from "./ai-outreach.js";
import { getAppSettings } from "./settings.js";
import { estimateAiCost } from "./ai-cost.js";
import { registerEnrichmentRoutes } from "./enrichment-routes.js";
import { getPreparedLeadForResearch, ResearchPreparationError, type ResearchPreparationResult } from "./research-preparation.js";
import { acquireAutomationLease, releaseAutomationLease } from "./automation-lock.js";
import { withAiCapacity } from "./ai-capacity.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";
import { assertAiBudgetAvailable, hashAiPacket } from "./ai-budget.js";
import { fetchBusinessAssetResearchPacket } from "./research-site-v10.js";
import { assessPerformance } from "./performance-assessment.js";

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
    const shouldAutoApprove = settings.approvalMode === "auto_safe" && (lead.priorityScore ?? 0) >= settings.minAutoApprovePriority && generated.draft.confidence >= settings.minAutoApproveConfidence && !generated.draft.requiresReview;
    const status = shouldAutoApprove ? "approved" : "draft";
    return prisma.$transaction(async (tx) => {
      const message = await tx.outreachMessage.create({ data: { leadId, kind: "initial", sequenceNumber: 1, subject: generated.draft.subject, bodyText: generated.draft.bodyText, angle: generated.draft.angle, cta: generated.draft.cta, confidence: generated.draft.confidence, requiresReview: generated.draft.requiresReview, status, approvedAt: shouldAutoApprove ? new Date() : null } });
      await tx.lead.update({ where: { id: leadId }, data: { status: "ready_for_outreach" } });
      await tx.activity.create({ data: { leadId, type: shouldAutoApprove ? "message_auto_approved" : "message_generated", summary: `${shouldAutoApprove ? "Auto-approved" : "Generated"} initial outreach: ${generated.draft.subject}`, metadata: { confidence: generated.draft.confidence, model: generated.model, approvalMode: settings.approvalMode } } });
      await tx.aIJob.update({ where: { id: aiJob.id }, data: { status: "complete", model: generated.model, inputTokens: generated.inputTokens, cachedTokens: generated.cachedTokens, outputTokens: generated.outputTokens, estimatedCost: estimateAiCost(generated.model, generated.inputTokens, generated.outputTokens), completedAt: new Date() } });
      return message;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.aIJob.update({ where: { id: aiJob.id }, data: { status: "failed", error: message, completedAt: new Date() } });
    await prisma.activity.create({ data: { leadId, type: "message_generation_failed", summary: message } });
    throw error;
  }
}

async function invalidateUnsentInitialOutreach(prisma: PrismaClient, leadId: number) {
  const cancelled = await prisma.outreachMessage.updateMany({ where: { leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved"] } }, data: { status: "cancelled" } });
  if (cancelled.count > 0) await prisma.activity.create({ data: { leadId, type: "research_outreach_invalidated", summary: `Cancelled ${cancelled.count} unsent initial outreach message(s) after successful re-research`, metadata: { researchVersion: RESEARCH_VERSION, cancelledCount: cancelled.count } } });
  return cancelled.count;
}

function lifecycleStatusForDecision(decision: string, currentStatus: string) {
  if (decision === "rebuild_candidate" || decision === "optimization_candidate") return "qualified";
  if (decision === "no_material_opportunity") return "disqualified";
  return currentStatus;
}

function researchPacketHash(lead: any, performanceAssessment: unknown, website: unknown, settings: any) {
  return hashAiPacket({ researchVersion: RESEARCH_VERSION, model: settings.researchModel, instructions: settings.researchInstructions, lead: { businessName: lead.businessName, domain: lead.domain, landingPageUrl: lead.landingPageUrl, keyword: lead.keyword, adSource: lead.adSource, lighthouseScore: lead.lighthouseScore, lcp: lead.lcp, cls: lead.cls, tbt: lead.tbt, email: lead.email, phone: lead.phone, address: lead.address, enrichmentNotes: lead.enrichmentNotes, isAgencyManaged: lead.isAgencyManaged, agencyName: lead.agencyName, isNationalChain: lead.isNationalChain, chainReason: lead.chainReason }, performanceAssessment, website });
}

async function reusableResearch(prisma: PrismaClient, lead: any, settings: any, preparation: ResearchPreparationResult) {
  if (!lead.lastResearchedAt || lead.researchVersion !== RESEARCH_VERSION) return null;
  const performanceAssessment = assessPerformance(lead);
  const website = await fetchBusinessAssetResearchPacket(lead.landingPageUrl);
  const packetHash = researchPacketHash(lead, performanceAssessment, website, settings);
  const priorJob = await prisma.aIJob.findFirst({ where: { leadId: lead.id, type: "lead_research", status: "complete", packetHash }, orderBy: { createdAt: "desc" } });
  if (!priorJob) return null;
  const assessment = await prisma.leadAssetAssessment.findFirst({ where: { leadId: lead.id, researchVersion: RESEARCH_VERSION }, orderBy: { createdAt: "desc" }, include: { findings: { orderBy: [{ significance: "desc" }, { confidence: "desc" }] } } });
  if (!assessment) return null;
  const result: ResearchResult = {
    decision: assessment.decision as ResearchResult["decision"],
    assetStrength: assessment.assetStrength as ResearchResult["assetStrength"],
    dimensions: assessment.dimensions as unknown as ResearchResult["dimensions"],
    findings: assessment.findings.map((finding) => ({
      category: finding.category as ResearchResult["findings"][number]["category"],
      title: finding.title,
      evidence: finding.evidence,
      assetCapability: finding.assetCapability,
      confidence: finding.confidence,
      significance: finding.significance as ResearchResult["findings"][number]["significance"],
      evidenceSources: finding.evidenceSources as unknown as ResearchResult["findings"][number]["evidenceSources"],
    })),
    researchSummary: assessment.researchSummary,
    decisionReason: assessment.decisionReason,
    confidence: assessment.confidence,
  };
  await prisma.activity.create({ data: { leadId: lead.id, type: "research_reused", summary: "Skipped duplicate AI research because the normalized evidence packet is unchanged", metadata: { packetHash, previousJobId: priorJob.id, assessmentId: assessment.id, researchVersion: RESEARCH_VERSION } } });
  return { result, priorityScore: lead.priorityScore, draft: null, preparation, invalidatedDrafts: 0, assessmentId: assessment.id, reused: true, packetHash };
}

export async function processLeadResearch(prisma: PrismaClient, leadId: number) {
  const lease = await acquireAutomationLease(prisma, `lead-research-${leadId}`, 10 * 60_000);
  if (!lease) throw new Error("Lead research is already running");
  try {
    const { lead, preparation } = await getPreparedLeadForResearch(prisma, leadId);
    const settings = await getAppSettings(prisma);
    const reusable = await reusableResearch(prisma, lead, settings, preparation);
    if (reusable) return reusable;
    await assertAiBudgetAvailable(prisma, settings);
    const job = await prisma.aIJob.create({ data: { leadId, type: "lead_research", status: "running", model: settings.researchModel, promptVersion: RESEARCH_VERSION, startedAt: new Date() } });
    try {
      const { result, performanceAssessment, website, model, inputTokens, outputTokens } = await withAiCapacity(prisma, () => researchLead(lead, settings.researchModel, settings.researchInstructions));
      const packetHash = researchPacketHash(lead, performanceAssessment, website, settings);
      const nextStatus = lifecycleStatusForDecision(result.decision, lead.status);
      let assessmentId: number | null = null;
      await prisma.$transaction(async (tx) => {
        await tx.leadProblem.deleteMany({ where: { leadId } });
        const assessment = await tx.leadAssetAssessment.create({ data: { leadId, decision: result.decision, assetStrength: result.assetStrength, dimensions: result.dimensions, performanceAssessment, siteCoverage: website.siteCoverage, researchSummary: result.researchSummary, decisionReason: result.decisionReason, confidence: result.confidence, model, researchVersion: RESEARCH_VERSION } });
        assessmentId = assessment.id;
        if (result.findings.length) await tx.leadFinding.createMany({ data: result.findings.map((finding) => ({ assessmentId: assessment.id, category: finding.category, title: finding.title, evidence: finding.evidence, assetCapability: finding.assetCapability, confidence: finding.confidence, significance: finding.significance, evidenceSources: finding.evidenceSources })) });
        await tx.lead.update({ where: { id: leadId }, data: { status: nextStatus, qualificationDecision: result.decision, qualificationReason: result.decisionReason, priorityScore: null, priorityBreakdown: {}, primaryOutreachAngle: null, primaryOutreachAngleReason: null, primaryOutreachAngleConfidence: null, primaryOutreachFindingId: null, researchSummary: result.researchSummary, researchVersion: RESEARCH_VERSION, lastResearchedAt: new Date(), assetStrength: result.assetStrength, assetAssessment: { dimensions: result.dimensions, performanceAssessment, siteCoverage: website.siteCoverage, findings: result.findings, confidence: result.confidence } } });
        await tx.activity.create({ data: { leadId, type: "research_completed", summary: `${result.decision}: ${result.decisionReason}`, metadata: { assetStrength: result.assetStrength, confidence: result.confidence, model, researchVersion: RESEARCH_VERSION, packetHash, preparationStatus: preparation.status, enrichmentAttempted: preparation.enrichmentAttempted, strongPerformanceSignal: performanceAssessment.strongPerformanceSignal, representativePagesFetched: website.siteCoverage.representativePagesFetched } } });
        await tx.aIJob.update({ where: { id: job.id }, data: { status: "complete", model, packetHash, inputTokens, outputTokens, estimatedCost: estimateAiCost(model, inputTokens, outputTokens), completedAt: new Date() } });
      });
      const invalidatedDrafts = await invalidateUnsentInitialOutreach(prisma, leadId);
      return { result, priorityScore: null, draft: null, preparation, invalidatedDrafts, assessmentId, reused: false, packetHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.aIJob.update({ where: { id: job.id }, data: { status: "failed", error: message, completedAt: new Date() } });
      await prisma.activity.create({ data: { leadId, type: "research_failed", summary: message } });
      throw error;
    }
  } finally { await releaseAutomationLease(prisma, lease); }
}

export async function processResearchReadyLeads(prisma: PrismaClient, limit = 10) {
  const safeLimit = capRequestedLimit(limit, 10, SAFETY_LIMITS.bulkResearchMax);
  const leads = await prisma.lead.findMany({ where: { email: { not: null }, status: { in: ["new", "research_pending"] }, lastResearchedAt: null, aiJobs: { none: { type: "lead_research", status: { in: ["running", "complete"] } } } }, orderBy: { createdAt: "asc" }, take: safeLimit, select: { id: true } });
  const results: Array<{ id: number; success: boolean; decision?: string; priorityScore?: number | null; draftId?: number; error?: string }> = [];
  for (const lead of leads) {
    try { const processed = await processLeadResearch(prisma, lead.id); results.push({ id: lead.id, success: true, decision: processed.result.decision, priorityScore: processed.priorityScore }); }
    catch (error) { results.push({ id: lead.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

type PreparedResearchResult = { id: number; preparation: ResearchPreparationResult; success: boolean; skipped?: boolean; decision?: string; priorityScore?: number | null; draftId?: number; error?: string };
export async function processPreparedResearchBatch(prisma: PrismaClient, leadIds: number[]) {
  const results: PreparedResearchResult[] = [];
  for (const id of leadIds) {
    try { const processed = await processLeadResearch(prisma, id); results.push({ id, preparation: processed.preparation, success: true, decision: processed.result.decision, priorityScore: processed.priorityScore }); }
    catch (error) {
      if (error instanceof ResearchPreparationError) { results.push({ id, preparation: error.preparation, success: false, skipped: true, error: error.message }); continue; }
      results.push({ id, preparation: { leadId: id, ready: true, status: "ready", email: null, alreadyHadEmail: false, enrichmentAttempted: false, reason: null }, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function statusForResearchError(message: string) {
  if (/lead not found/i.test(message)) return 404;
  if (/already running|concurrency limit/i.test(message)) return 409;
  if (/AI budget reached|Daily AI budget|Monthly AI budget/i.test(message)) return 429;
  if (/no email|not research-ready|enrichment.*(?:exhausted|retry|found but)|no email was persisted/i.test(message)) return 422;
  if (/openai|provider|fetch failed|econn|etimedout|429|502|503|504/i.test(message)) return 502;
  return 500;
}

const assetAssessmentInclude = { orderBy: { createdAt: "desc" as const }, take: 1, include: { findings: { orderBy: [{ significance: "desc" as const }, { confidence: "desc" as const }] } } };

export function registerResearchRoutes(app: Express, prisma: PrismaClient) {
  registerEnrichmentRoutes(app, prisma);

  app.get("/api/leads/:id/research", async (req, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    const lead = await prisma.lead.findUnique({ where: { id }, include: { problems: { orderBy: { confidence: "desc" } }, scores: { orderBy: { createdAt: "desc" }, take: 1 }, assetAssessments: assetAssessmentInclude, activities: { orderBy: { createdAt: "desc" }, take: 50 }, outreachMessages: { orderBy: { generatedAt: "desc" } } } });
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
    res.json(lead);
  });

  app.post("/api/leads/:id/research", async (req, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    try {
      const processed = await processLeadResearch(prisma, id);
      res.json({ preparation: processed.preparation, invalidatedDrafts: processed.invalidatedDrafts, assessmentId: processed.assessmentId, reused: processed.reused ?? false, packetHash: processed.packetHash, lead: await prisma.lead.findUnique({ where: { id }, include: { problems: true, scores: { orderBy: { createdAt: "desc" }, take: 1 }, assetAssessments: assetAssessmentInclude, outreachMessages: { orderBy: { generatedAt: "desc" } } } }) });
    } catch (error) {
      if (error instanceof ResearchPreparationError) {
        const preparation = error.preparation;
        const status = preparation.status === "deferred" ? 409 : preparation.status === "missing" ? 404 : 422;
        console.warn(`[Research] Lead ${id} blocked before AI — status=${preparation.status}, reason=${error.message}`);
        res.status(status).json({ error: error.message, stage: "preparation", preparation });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const status = statusForResearchError(message);
      console.error(`[Research] Lead ${id} failed — stage=research, status=${status}, error=${message}`, error);
      res.status(status).json({ error: message, stage: "research" });
    }
  });

  app.post("/api/leads/bulk-research", async (req, res) => {
    const requested = Array.isArray(req.body?.ids) ? Array.from(new Set(req.body.ids.filter((id: unknown) => Number.isInteger(id) && Number(id) > 0) as number[])) : [];
    if (requested.length > SAFETY_LIMITS.bulkResearchMax) { res.status(400).json({ error: `Bulk research is capped at ${SAFETY_LIMITS.bulkResearchMax} leads per request` }); return; }
    const settings = await getAppSettings(prisma);
    const batchLimit = Math.min(settings.researchBatchSize, SAFETY_LIMITS.bulkResearchMax);
    const leadIds = requested.length ? requested.slice(0, batchLimit) : (await prisma.lead.findMany({ where: { status: { in: ["new", "research_pending"] }, lastResearchedAt: null }, orderBy: { createdAt: "asc" }, take: batchLimit, select: { id: true } })).map((lead) => lead.id);
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
    res.json({ selected: requested.length || leadIds.length, selectedForThisBatch: leadIds.length, cap: batchLimit, alreadyHadEmail, enrichmentAttempted, emailsDiscovered, enrichmentExhausted, enrichmentDeferred, enrichmentFailed, researchEligible: results.filter((r) => r.preparation.ready).length, researched, researchFailed, skippedNoEmail, processed: results.length, results });
  });
}
