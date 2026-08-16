import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { z, ZodError } from "zod";
import { getAppSettings } from "./settings.js";
import { acquireAutomationLease, releaseAutomationLease } from "./automation-lock.js";
import { RESEARCH_VERSION } from "./ai-research.js";
import { SAFETY_LIMITS } from "./safety-limits.js";
import { authorizeCronRequest, getAutomationRuntimePolicy } from "./automation-policy.js";
import { registerResearchMaintenanceRoutes } from "./research-maintenance-routes.js";
import { AUTOMATION_JOB_NAMES, runNamedAutomationJob, type AutomationJobName } from "./automation-jobs.js";
import { getAiBudgetStatus } from "./ai-budget.js";

const STALE_RESEARCH_VERSIONS = ["lead-research-v3", "lead-research-v4", "lead-research-v5", "lead-research-v6", "lead-research-v7", "lead-research-v8", "lead-research-v9"];
const RunSchema = z.object({ jobName: z.enum(AUTOMATION_JOB_NAMES) });
const PAUSE_TYPE = "global";
const PAUSE_VALUE = "outreach";

async function isOutreachPaused(prisma: PrismaClient) {
  return Boolean(await prisma.suppression.findUnique({ where: { type_value: { type: PAUSE_TYPE, value: PAUSE_VALUE } } }));
}

export function registerAutomationRoutes(app: Express, prisma: PrismaClient) {
  registerResearchMaintenanceRoutes(app, prisma);

  app.get("/api/automation/status", async (req, res) => {
    const auth = authorizeCronRequest(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    try {
      const policy = getAutomationRuntimePolicy();
      const settings = await getAppSettings(prisma);
      const now = new Date();
      const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
      const [
        pendingEnrichment, researchReady, qualifiedNeedsPreparation, approvedMessages, sendingMessages,
        followupsDue, revisitDue, unhandledReplies, staleResearch, sentToday, suppressedCount, recentRuns, outreachPaused, aiBudget,
      ] = await Promise.all([
        prisma.lead.count({ where: { email: null, status: { in: ["new", "research_pending", "qualified"] }, OR: [{ emailEnrichmentStatus: "pending" }, { emailEnrichmentStatus: "retry", nextEmailEnrichmentAt: { lte: now } }] } }),
        prisma.lead.count({ where: { email: { not: null }, status: { in: ["new", "research_pending"] }, lastResearchedAt: null, aiJobs: { none: { type: "lead_research", status: { in: ["running", "complete"] } } } } }),
        prisma.lead.count({ where: { qualificationDecision: { in: ["rebuild_candidate", "optimization_candidate"] }, email: { not: null }, OR: [{ priorityScore: null }, { primaryOutreachAngle: null }, { outreachMessages: { none: { kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved", "sending", "sent"] } } } }] } }),
        prisma.outreachMessage.count({ where: { status: "approved" } }),
        prisma.outreachMessage.count({ where: { status: "sending" } }),
        prisma.lead.count({ where: { status: "contacted", followUpDate: { lte: now }, OR: [{ replyStatus: null }, { replyStatus: "out_of_office" }] } }),
        prisma.lead.count({ where: { replyStatus: "not_now", revisitAt: { lte: now } } }),
        prisma.lead.count({ where: { replyStatus: { not: null }, replyHandledAt: null } }),
        prisma.lead.count({ where: { researchVersion: { in: STALE_RESEARCH_VERSIONS }, email: { not: null } } }),
        prisma.outreachMessage.count({ where: { status: "sent", sentAt: { gte: startOfDay } } }),
        prisma.suppression.count({ where: { type: { in: ["email", "domain"] } } }),
        prisma.automationRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
        isOutreachPaused(prisma),
        getAiBudgetStatus(prisma, settings),
      ]);
      const lastByJob = Object.fromEntries(AUTOMATION_JOB_NAMES.map((name) => [name, recentRuns.find((run) => run.jobName === name) ?? null]));
      res.json({
        automationEnabled: policy.automationEnabled,
        sendAutomationEnabled: policy.sendAutomationEnabled,
        outreachPaused,
        researchVersion: RESEARCH_VERSION,
        staleResearchVersions: STALE_RESEARCH_VERSIONS,
        nextExpectedRun: new Date(now.getTime() + 10 * 60_000).toISOString(),
        settings: {
          autoEnrich: settings.autoEnrich, autoResearch: settings.autoResearch, autoPrioritize: settings.autoPrioritize,
          autoSelectOutreachAngle: settings.autoSelectOutreachAngle, autoDraftOutreach: settings.autoDraftOutreach,
          autoSyncReplies: settings.autoSyncReplies, autoProcessFollowups: settings.autoProcessFollowups,
          autoSendApproved: settings.autoSendApproved, approvalMode: settings.approvalMode,
          dailySendLimit: settings.dailySendLimit, sendWindowStart: settings.sendWindowStart, sendWindowEnd: settings.sendWindowEnd,
          sendTimezone: settings.sendTimezone, weekendSendingEnabled: settings.weekendSendingEnabled, researchBatchSize: settings.researchBatchSize,
        },
        queue: { pendingEnrichment, researchReady, qualifiedNeedsPreparation, approvedMessages, sendingMessages, followupsDue, revisitDue, unhandledReplies, staleResearch },
        blocked: {
          outreachPaused,
          dailySendCapReached: sentToday >= settings.dailySendLimit,
          dailySendRemaining: Math.max(0, settings.dailySendLimit - sentToday),
          aiBudgetReached: aiBudget.reached,
          aiBudgetReason: aiBudget.reason,
          suppressedCount,
        },
        aiBudget,
        lastRuns: lastByJob,
        recentRuns,
        hardLimits: {
          replySync: SAFETY_LIMITS.automationReplySyncMax, emailEnrichment: SAFETY_LIMITS.automationEnrichmentMax,
          research: SAFETY_LIMITS.automationResearchMax, staleSendReconciliation: SAFETY_LIMITS.automationStaleSendMax,
          followups: SAFETY_LIMITS.automationFollowupMax, sends: SAFETY_LIMITS.automationSendMax,
          aiConcurrency: SAFETY_LIMITS.aiResearchConcurrency, enrichmentConcurrency: SAFETY_LIMITS.emailEnrichmentConcurrency,
        },
      });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/automation/run", async (req, res) => {
    const auth = authorizeCronRequest(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    let parsed: z.infer<typeof RunSchema>;
    try { parsed = RunSchema.parse(req.body); } catch (error) { if (error instanceof ZodError) { res.status(400).json({ error: "Invalid automation job", issues: error.issues }); return; } throw error; }
    const policy = getAutomationRuntimePolicy();
    if (!policy.automationEnabled) { res.status(409).json({ error: "Automation is disabled" }); return; }
    if (["reconcile_sends", "followups", "send_approved"].includes(parsed.jobName) && (!policy.sendAutomationEnabled || await isOutreachPaused(prisma))) {
      res.status(409).json({ error: "Outreach sending is paused or disabled" }); return;
    }
    try { res.json(await runNamedAutomationJob(prisma, parsed.jobName as AutomationJobName)); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/automation/outreach-pause", async (req, res) => {
    const auth = authorizeCronRequest(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const paused = req.body?.paused !== false;
    try {
      if (paused) await prisma.suppression.upsert({ where: { type_value: { type: PAUSE_TYPE, value: PAUSE_VALUE } }, update: { reason: "Emergency outreach pause" }, create: { type: PAUSE_TYPE, value: PAUSE_VALUE, reason: "Emergency outreach pause" } });
      else await prisma.suppression.deleteMany({ where: { type: PAUSE_TYPE, value: PAUSE_VALUE } });
      res.json({ outreachPaused: paused });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/automation/tick", async (req, res) => {
    const auth = authorizeCronRequest(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const policy = getAutomationRuntimePolicy();
    if (!policy.automationEnabled) { res.json({ success: true, skipped: true, automationEnabled: false, sendAutomationEnabled: policy.sendAutomationEnabled, reason: "Automation is disabled" }); return; }
    const lease = await acquireAutomationLease(prisma, "automation-tick", 30 * 60_000);
    if (!lease) { res.status(409).json({ error: "Automation tick already running" }); return; }
    try {
      const runs = [];
      for (const jobName of ["sync_replies", "revisit_due", "enrich", "research", "recalculate_priorities", "prepare_outreach"] as AutomationJobName[]) runs.push(await runNamedAutomationJob(prisma, jobName));
      if (policy.sendAutomationEnabled && !await isOutreachPaused(prisma)) {
        for (const jobName of ["reconcile_sends", "followups", "send_approved"] as AutomationJobName[]) runs.push(await runNamedAutomationJob(prisma, jobName));
      }
      res.json({ success: true, skipped: false, automationEnabled: true, sendAutomationEnabled: policy.sendAutomationEnabled, outreachPaused: await isOutreachPaused(prisma), runs });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
    finally { await releaseAutomationLease(prisma, lease); }
  });
}
