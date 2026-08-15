import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { calculatePriority, researchLead, RESEARCH_VERSION } from "./ai-research.js";
import { getEnv } from "./env.js";

export function registerResearchRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/leads/:id/research", async (req, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: { problems: { orderBy: { confidence: "desc" } }, scores: { orderBy: { createdAt: "desc" }, take: 1 }, activities: { orderBy: { createdAt: "desc" }, take: 50 }, outreachMessages: { orderBy: { generatedAt: "desc" } } },
    });
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
    res.json(lead);
  });

  app.post("/api/leads/:id/research", async (req, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    const lead = await prisma.lead.findUnique({ where: { id } });
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

    const env = getEnv();
    const job = await prisma.aIJob.create({ data: { leadId: id, type: "lead_research", status: "running", model: env.OPENAI_RESEARCH_MODEL, promptVersion: RESEARCH_VERSION, startedAt: new Date() } });
    try {
      const { result, model, inputTokens, outputTokens } = await researchLead(lead);
      const priorityScore = calculatePriority(result.scores);
      const status = result.decision === "qualified" ? "qualified" : result.decision === "disqualified" ? "disqualified" : lead.status;

      await prisma.$transaction(async (tx) => {
        await tx.leadProblem.deleteMany({ where: { leadId: id } });
        if (result.problems.length) {
          await tx.leadProblem.createMany({ data: result.problems.map(p => ({ leadId: id, category: p.category, title: p.title, evidence: p.evidence, businessConsequence: p.businessConsequence, recommendedImprovement: p.recommendedImprovement || null, confidence: p.confidence, outreachValue: p.outreachValue })) });
        }
        await tx.leadScore.create({ data: { leadId: id, ...result.scores, compositeScore: priorityScore, model, researchVersion: RESEARCH_VERSION } });
        await tx.lead.update({ where: { id }, data: { status, qualificationDecision: result.decision, qualificationReason: result.qualificationReason, priorityScore, primaryOutreachAngle: result.primaryOutreachAngle, researchSummary: result.researchSummary, researchVersion: RESEARCH_VERSION, lastResearchedAt: new Date() } });
        await tx.activity.create({ data: { leadId: id, type: "research_completed", summary: `${result.decision}: ${result.qualificationReason}`, metadata: { priorityScore, confidence: result.confidence, model } } });
        await tx.aIJob.update({ where: { id: job.id }, data: { status: "complete", model, inputTokens, outputTokens, completedAt: new Date() } });
      });
      const updated = await prisma.lead.findUnique({ where: { id }, include: { problems: true, scores: { orderBy: { createdAt: "desc" }, take: 1 } } });
      res.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.aIJob.update({ where: { id: job.id }, data: { status: "failed", error: message, completedAt: new Date() } });
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/leads/bulk-research", async (req, res) => {
    const requested = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => Number.isInteger(id)) : [];
    const env = getEnv();
    const leads = requested.length
      ? await prisma.lead.findMany({ where: { id: { in: requested } }, take: env.AI_RESEARCH_BATCH_SIZE })
      : await prisma.lead.findMany({ where: { status: { in: ["new", "research_pending"] } }, orderBy: { createdAt: "asc" }, take: env.AI_RESEARCH_BATCH_SIZE });

    const results: Array<{ id: number; success: boolean; decision?: string; priorityScore?: number; error?: string }> = [];
    for (const lead of leads) {
      try {
        const researched = await researchLead(lead);
        const priorityScore = calculatePriority(researched.result.scores);
        const r = researched.result;
        await prisma.$transaction(async (tx) => {
          await tx.leadProblem.deleteMany({ where: { leadId: lead.id } });
          if (r.problems.length) await tx.leadProblem.createMany({ data: r.problems.map(p => ({ leadId: lead.id, category: p.category, title: p.title, evidence: p.evidence, businessConsequence: p.businessConsequence, recommendedImprovement: p.recommendedImprovement || null, confidence: p.confidence, outreachValue: p.outreachValue })) });
          await tx.leadScore.create({ data: { leadId: lead.id, ...r.scores, compositeScore: priorityScore, model: researched.model, researchVersion: RESEARCH_VERSION } });
          await tx.lead.update({ where: { id: lead.id }, data: { status: r.decision === "qualified" ? "qualified" : r.decision === "disqualified" ? "disqualified" : lead.status, qualificationDecision: r.decision, qualificationReason: r.qualificationReason, priorityScore, primaryOutreachAngle: r.primaryOutreachAngle, researchSummary: r.researchSummary, researchVersion: RESEARCH_VERSION, lastResearchedAt: new Date() } });
          await tx.activity.create({ data: { leadId: lead.id, type: "research_completed", summary: `${r.decision}: ${r.qualificationReason}`, metadata: { priorityScore, confidence: r.confidence, model: researched.model } } });
        });
        results.push({ id: lead.id, success: true, decision: r.decision, priorityScore });
      } catch (error) {
        results.push({ id: lead.id, success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    res.json({ processed: results.length, results });
  });
}
