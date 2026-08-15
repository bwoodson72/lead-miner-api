import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { ensureInitialOutreachDraft, processLeadResearch } from "./research-routes.js";
import { authorizeCronRequest, getAutomationRuntimePolicy } from "./automation-policy.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

const STALE_RESEARCH_VERSION = "lead-research-v3";
const TARGET_RESEARCH_VERSION = "lead-research-v4";
const SAFE_MAINTENANCE_STATUSES = ["new", "research_pending", "qualified", "disqualified", "ready_for_outreach"];

type ProcessResearchFn = typeof processLeadResearch;
type EnsureDraftFn = typeof ensureInitialOutreachDraft;

function staleResearchWhere() {
  return {
    researchVersion: STALE_RESEARCH_VERSION,
    email: { not: null },
    status: { in: SAFE_MAINTENANCE_STATUSES },
    outreachMessages: { none: { status: { in: ["sending", "sent"] } } },
  };
}

export async function refreshStaleResearch(
  prisma: PrismaClient,
  limit = 10,
  processResearch: ProcessResearchFn = processLeadResearch,
  ensureDraft: EnsureDraftFn = ensureInitialOutreachDraft,
) {
  const safeLimit = capRequestedLimit(limit, 10, SAFETY_LIMITS.bulkResearchMax);
  const leads = await prisma.lead.findMany({
    where: staleResearchWhere(),
    orderBy: [{ lastResearchedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: safeLimit,
    select: { id: true },
  });

  const results: Array<{
    leadId: number;
    success: boolean;
    decision?: string;
    staleDraftsCancelled?: number;
    replacementDraftId?: number;
    draftError?: string;
    error?: string;
  }> = [];

  for (const lead of leads) {
    const staleMessages = await prisma.outreachMessage.findMany({
      where: {
        leadId: lead.id,
        kind: "initial",
        sequenceNumber: 1,
        status: { in: ["draft", "approved"] },
      },
      select: { id: true },
    });

    try {
      const processed = await processResearch(prisma, lead.id);
      let staleDraftsCancelled = 0;
      let replacementDraftId: number | undefined;
      let draftError: string | undefined;

      if (staleMessages.length) {
        const staleIds = staleMessages.map((message) => message.id);
        const cancelled = await prisma.outreachMessage.updateMany({
          where: { id: { in: staleIds }, status: { in: ["draft", "approved"] } },
          data: { status: "cancelled" },
        });
        staleDraftsCancelled = cancelled.count;

        if (staleDraftsCancelled) {
          await prisma.activity.create({
            data: {
              leadId: lead.id,
              type: "stale_research_outreach_cancelled",
              summary: `Cancelled ${staleDraftsCancelled} unsent outreach message(s) after ${TARGET_RESEARCH_VERSION} refresh`,
              metadata: { staleResearchVersion: STALE_RESEARCH_VERSION, targetResearchVersion: TARGET_RESEARCH_VERSION, messageIds: staleIds },
            },
          });
        }
      }

      if (processed.result.decision === "qualified" && staleDraftsCancelled > 0) {
        try {
          const replacement = await ensureDraft(prisma, lead.id);
          replacementDraftId = replacement?.id;
        } catch (error) {
          draftError = error instanceof Error ? error.message : String(error);
        }
      }

      results.push({
        leadId: lead.id,
        success: true,
        decision: processed.result.decision,
        staleDraftsCancelled,
        replacementDraftId,
        draftError,
      });
    } catch (error) {
      results.push({ leadId: lead.id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const remaining = await prisma.lead.count({ where: staleResearchWhere() });
  return {
    staleResearchVersion: STALE_RESEARCH_VERSION,
    targetResearchVersion: TARGET_RESEARCH_VERSION,
    selected: leads.length,
    refreshed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    staleDraftsCancelled: results.reduce((sum, result) => sum + (result.staleDraftsCancelled ?? 0), 0),
    replacementDraftsGenerated: results.filter((result) => result.replacementDraftId).length,
    remaining,
    results,
  };
}

export function registerResearchMaintenanceRoutes(app: Express, prisma: PrismaClient) {
  app.post("/api/maintenance/research-v4", async (req, res) => {
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
  });
}
