import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { calculatePriority, researchLead, RESEARCH_VERSION } from "./ai-research.js";
import { generateOutreachDraft, OUTREACH_PROMPT_VERSION } from "./ai-outreach.js";
import { getAppSettings } from "./settings.js";

export async function ensureInitialOutreachDraft(prisma: PrismaClient, leadId: number) {
  const settings = await getAppSettings(prisma);
  if (!settings.autoDraftOutreach) return null;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { problems: { orderBy: [{ outreachValue: "desc" }, { confidence: "desc" }] } },
  });
  if (!lead || lead.qualificationDecision !== "qualified" || !lead.email) return null;

  const existing = await prisma.outreachMessage.findFirst({
    where: { leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved", "sent"] } },
    orderBy: { generatedAt: "desc" },
  });
  if (existing) {
    if (lead.status === "qualified") await prisma.lead.update({ where: { id: leadId }, data: { status: "ready_for_outreach" } });
    return existing;
  }

  const aiJob = await prisma.aIJob.create({ data: { leadId, type: "outreach_draft", status: "running", model: settings.outreachModel, promptVersion: OUTREACH_PROMPT_VERSION, startedAt: new Date() } });
  try {
    const generated = await generateOutreachDraft({ businessName: lead.businessName, domain: lead.domain, keyword: lead.keyword, primaryOutreachAngle: lead.primaryOutreachAngle, researchSummary: lead.researchSummary, qualificationReason: lead.qualificationReason, problems: lead.problems }, settings.outreachModel, settings.minProblemConfidence, settings.outreachInstructions);
    const shouldAutoApprove = settings.approvalMode === "auto_safe" && (lead.priorityScore ?? 0) >= settings.minAutoApprovePriority && generated.draft.confidence >= settings.minAutoApproveConfidence;
    const status = shouldAutoApprove ? "approved" : "draft";
    return prisma.$transaction(async (tx) => {
      const message = await tx.outreachMessage.create({ data: { leadId, kind: "initial", sequenceNumber: 1, subject: generated.draft.subject, bodyText: generated.draft.bodyText, angle: generated.draft.angle, status, approvedAt: shouldAutoApprove ? new Date() : null } });
      await tx.lead.update({ where: { id: leadId }, data: { status: "ready_for_outreach" } });
      await tx.activity.create({ data: { leadId, type: shouldAutoApprove ? "message_auto_approved" : "message_generated", summary: `${shouldAutoApprove ? "Auto-approved" : "Generated"} initial outreach: ${generated.draft.subject}`, metadata: { confidence: generated.draft.confidence, model: generated.model, approvalMode: settings.approvalMode } } });
      await tx.aIJob.update({ where: { id: aiJob.id }, data: { status: "complete", model: generated.model, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, completedAt: new Date() } });
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
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error("Lead not found");
  const settings = await getAppSettings(prisma);
  const job = await prisma.aIJob.create({ data: { leadId, type: "lead_research", status: "running", model: settings.researchModel, promptVersion: RESEARCH_VERSION, startedAt: new Date() } });
  try {
    const { result, model, inputTokens, outputTokens } = await researchLead(lead, settings.researchModel, settings.researchInstructions);
    const priorityScore = calculatePriority(result.scores);
    const nextStatus = result.decision === "qualified" ? "qualified" : result.decision === "disqualified" ? "disqualified" : lead.status;
    await prisma.$transaction(async (tx) => {
      await tx.leadProblem.deleteMany({ where: { leadId } });
      if (result.problems.length) await tx.leadProblem.createMany({ data: result.problems.map((p) => ({ leadId, category: p.category, title: p.title, evidence: p.evidence, businessConsequence: p.businessConsequence, recommendedImprovement: p.recommendedImprovement || null, confidence: p.confidence, outreachValue: p.outreachValue })) });
      await tx.leadScore.create({ data: { leadId, ...result.scores, compositeScore: priorityScore, model, researchVersion: RESEARCH_VERSION } });
      await tx.lead.update({ where: { id: leadId }, data: { status: nextStatus, qualificationDecision: result.decision, qualificationReason: result.qualificationReason, priorityScore, primaryOutreachAngle: result.primaryOutreachAngle, researchSummary: result.researchSummary, researchVersion: RESEARCH_VERSION, lastResearchedAt: new Date() } });
      await tx.activity.create({ data: { leadId, type: "research_completed", summary: `${result.decision}: ${result.qualificationReason}`, metadata: { priorityScore, confidence: result.confidence, model } } });
      await tx.aIJob.update({ where: { id: job.id }, data: { status: "complete", model, inputTokens, outputTokens, completedAt: new Date() } });
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
}

export function registerResearchRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/leads/:id/research", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    const lead = await prisma.lead.findUnique({ where: { id }, include: { problems: { orderBy: { confidence: "desc" } }, scores: { orderBy: { createdAt: "desc" }, take: 1 }, activities: { orderBy: { createdAt: "desc" }, take: 50 }, outreachMessages: { orderBy: { generatedAt: "desc" } } } });
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; } res.json(lead);
  });
  app.post("/api/leads/:id/research", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    try { await processLeadResearch(prisma, id); res.json(await prisma.lead.findUnique({ where: { id }, include: { problems: true, scores: { orderBy: { createdAt: "desc" }, take: 1 }, outreachMessages: { orderBy: { generatedAt: "desc" } } } })); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/leads/bulk-research", async (req, res) => {
    const requested = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => Number.isInteger(id)) : [];
    const settings = await getAppSettings(prisma);
    const leads = requested.length ? await prisma.lead.findMany({ where: { id: { in: requested } }, take: settings.researchBatchSize, select: { id: true } }) : await prisma.lead.findMany({ where: { status: { in: ["new", "research_pending"] } }, orderBy: { createdAt: "asc" }, take: settings.researchBatchSize, select: { id: true } });
    const results: Array<{ id:number; success:boolean; decision?:string; priorityScore?:number; error?:string }> = [];
    for (const lead of leads) { try { const processed = await processLeadResearch(prisma, lead.id); results.push({ id: lead.id, success: true, decision: processed.result.decision, priorityScore: processed.priorityScore }); } catch (error) { results.push({ id: lead.id, success: false, error: error instanceof Error ? error.message : String(error) }); } }
    res.json({ processed: results.length, results });
  });
}
