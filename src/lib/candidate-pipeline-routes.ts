import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  calculateResearchQueueScore,
  isResearchQueueEligible,
  rankResearchCandidates,
  researchQueueWhere,
} from "./research-queue.js";
import { qualifiedContactWhere } from "./qualified-enrichment.js";

export function resolveContactPipelineState(lead: {
  qualificationDecision: string | null;
  email: string | null;
  emailEnrichmentStatus: string;
  nextEmailEnrichmentAt: Date | null;
}, now = new Date()) {
  if (lead.qualificationDecision !== "rebuild_candidate") return "not_required" as const;
  if (lead.email) return "ready" as const;
  if (lead.emailEnrichmentStatus === "exhausted") return "exhausted" as const;
  if (lead.emailEnrichmentStatus === "retry" && lead.nextEmailEnrichmentAt && lead.nextEmailEnrichmentAt > now) {
    return "retry_scheduled" as const;
  }
  return "waiting" as const;
}

export function registerCandidatePipelineRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/pipeline/summary", async (_req, res) => {
    try {
      const now = new Date();
      const [
        researchQueue,
        waitingForContact,
        contactEnrichmentDue,
        contactExhausted,
        screeningPending,
        screeningPartial,
        performanceStrong,
        performanceModerate,
      ] = await Promise.all([
        prisma.lead.count({ where: researchQueueWhere() as any }),
        prisma.lead.count({ where: { qualificationDecision: "rebuild_candidate", email: null, status: { in: ["qualified", "ready_for_outreach"] } } }),
        prisma.lead.count({ where: qualifiedContactWhere(now) as any }),
        prisma.lead.count({ where: { qualificationDecision: "rebuild_candidate", email: null, status: { in: ["qualified", "ready_for_outreach"] }, emailEnrichmentStatus: "exhausted" } }),
        prisma.lead.count({ where: { screeningStatus: "pending" } }),
        prisma.lead.count({ where: { screeningStatus: "partial" } }),
        prisma.lead.count({ where: { performanceOpportunity: "strong" } }),
        prisma.lead.count({ where: { performanceOpportunity: "moderate" } }),
      ]);
      res.json({
        researchQueue,
        waitingForContact,
        contactEnrichmentDue,
        contactExhausted,
        screeningPending,
        screeningPartial,
        performanceStrong,
        performanceModerate,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/pipeline/research-queue", async (req, res) => {
    try {
      const requested = Number(req.query["limit"] ?? 50);
      const limit = Math.min(100, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 50));
      const candidates = await prisma.lead.findMany({
        where: researchQueueWhere() as any,
        orderBy: { createdAt: "asc" },
        take: 2000,
        select: {
          id: true,
          businessName: true,
          domain: true,
          keyword: true,
          adSource: true,
          performanceOpportunity: true,
          screeningStatus: true,
          phone: true,
          address: true,
          createdAt: true,
        },
      });
      const ranked = rankResearchCandidates(candidates).slice(0, limit).map(({ candidate, score }) => ({
        ...candidate,
        researchQueueScore: score.total,
        researchQueueBreakdown: score,
      }));
      res.json({ candidates: ranked, totalEligible: candidates.length, returned: ranked.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/leads/:id/pipeline-state", async (req, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    try {
      const lead = await prisma.lead.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          qualificationDecision: true,
          lastResearchedAt: true,
          screeningStatus: true,
          performanceOpportunity: true,
          adSource: true,
          businessName: true,
          keyword: true,
          city: true,
          region: true,
          phone: true,
          address: true,
          email: true,
          priorityScore: true,
          primaryOutreachAngle: true,
          emailEnrichmentStatus: true,
          emailEnrichmentReason: true,
          nextEmailEnrichmentAt: true,
          createdAt: true,
          assetAssessments: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              decision: true,
              confidence: true,
              assetStrength: true,
              findings: {
                orderBy: { confidence: "desc" },
                take: 1,
                select: { title: true, category: true, confidence: true, significance: true },
              },
            },
          },
        },
      });
      if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
      const researchEligible = isResearchQueueEligible(lead);
      const researchQueueBreakdown = researchEligible ? calculateResearchQueueScore(lead) : null;
      const assessment = lead.assetAssessments[0] ?? null;
      res.json({
        leadId: id,
        businessName: lead.businessName,
        status: lead.status,
        adSource: lead.adSource,
        keyword: lead.keyword,
        city: lead.city,
        region: lead.region,
        createdAt: lead.createdAt,
        screeningStatus: lead.screeningStatus,
        performanceOpportunity: lead.performanceOpportunity,
        researchEligible,
        researchQueueScore: researchQueueBreakdown?.total ?? null,
        researchQueueBreakdown,
        lastResearchedAt: lead.lastResearchedAt,
        qualificationDecision: lead.qualificationDecision,
        assessment: assessment ? {
          decision: assessment.decision,
          confidence: assessment.confidence,
          assetStrength: assessment.assetStrength,
          topFinding: assessment.findings[0] ?? null,
        } : null,
        salesPriority: lead.priorityScore,
        selectedOutreachFinding: lead.primaryOutreachAngle,
        email: lead.email,
        phone: lead.phone,
        address: lead.address,
        contactState: resolveContactPipelineState(lead),
        emailEnrichmentStatus: lead.emailEnrichmentStatus,
        emailEnrichmentReason: lead.emailEnrichmentReason,
        nextEmailEnrichmentAt: lead.nextEmailEnrichmentAt,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
