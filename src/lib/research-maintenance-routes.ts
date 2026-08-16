import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { processLeadResearch } from "./research-routes.js";
import { RESEARCH_VERSION } from "./ai-research.js";
import { authorizeCronRequest, getAutomationRuntimePolicy } from "./automation-policy.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

const STALE_RESEARCH_VERSIONS = ["lead-research-v3", "lead-research-v4", "lead-research-v5", "lead-research-v6", "lead-research-v7"];
const SAFE_MAINTENANCE_STATUSES = ["new", "research_pending", "qualified", "disqualified", "ready_for_outreach"];

type ProcessResearchFn = typeof processLeadResearch;

function staleResearchWhere() {
  return {
    researchVersion: { in: STALE_RESEARCH_VERSIONS },
    email: { not: null },
    status: { in: SAFE_MAINTENANCE_STATUSES },
    outreachMessages: { none: { status: { in: ["sending", "sent"] } } },
  };
}

export async function refreshStaleResearch(
  prisma: PrismaClient,
  limit = 10,
  processResearch: ProcessResearchFn = processLeadResearch,
) {
  const safeLimit = capRequestedLimit(limit, 10, SAFETY_LIMITS.bulkResearchMax);
  const leads = await prisma.lead.findMany({
    where: staleResearchWhere(),
    orderBy: [{ lastResearchedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: safeLimit,
    select: { id: true, researchVersion: true },
  });

  const results: Array<{
    leadId: number;
    previousResearchVersion: string | null;
    success: boolean;
    decision?: string;
    invalidatedDrafts?: number;
    error?: string;
  }> = [];

  for (const lead of leads) {
    try {
      const processed = await processResearch(prisma, lead.id);
      results.push({
        leadId: lead.id,
        previousResearchVersion: lead.researchVersion,
        success: true,
        decision: processed.result.decision,
        invalidatedDrafts: processed.invalidatedDrafts,
      });
    } catch (error) {
      results.push({
        leadId: lead.id,
        previousResearchVersion: lead.researchVersion,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const remaining = await prisma.lead.count({ where: staleResearchWhere() });
  return {
    staleResearchVersions: STALE_RESEARCH_VERSIONS,
    targetResearchVersion: RESEARCH_VERSION,
    selected: leads.length,
    refreshed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    invalidatedDrafts: results.reduce((sum, result) => sum + (result.invalidatedDrafts ?? 0), 0),
    replacementDraftsGenerated: 0,
    remaining,
    results,
  };
}

export function registerResearchMaintenanceRoutes(app: Express, prisma: PrismaClient) {
  const handler = async (req: any, res: any) => {
    const auth = authorizeCronRequest(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }

    const policy = getAutomationRuntimePolicy();
    if (policy.sendAutomationEnabled) {
      res.status(409).json({ error: "Disable AUTOMATION_SEND_ENABLED before refreshing stale research" });
      return;
    }

    const requested = Number(req.body?.limit ?? 10);
    if (!Number.isFinite(requested) || requested < 1) { res.status(400).json({ error: "Invalid limit" }); return; }
    if (requested > SAFETY_LIMITS.bulkResearchMax) {
      res.status(400).json({ error: `Research maintenance is capped at ${SAFETY_LIMITS.bulkResearchMax} leads per request` });
      return;
    }

    try {
      res.json(await refreshStaleResearch(prisma, requested));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  app.post("/api/maintenance/research-current", handler);
  app.post("/api/maintenance/research-v8", handler);
  // Compatibility aliases for local scripts created during earlier research rollouts.
  app.post("/api/maintenance/research-v7", handler);
  app.post("/api/maintenance/research-v6", handler);
  app.post("/api/maintenance/research-v5", handler);
}
