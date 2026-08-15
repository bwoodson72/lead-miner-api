import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { getAppSettings } from "./settings.js";
import { processDueFollowUps, syncReplies } from "./followup-reply-routes.js";
import { reconcileStaleSends, sendApprovedQueue } from "./outreach-sending.js";
import { acquireAutomationLease, releaseAutomationLease } from "./automation-lock.js";
import { enrichMissingEmails } from "./enrichment-routes.js";
import { processResearchReadyLeads } from "./research-routes.js";
import { SAFETY_LIMITS } from "./safety-limits.js";

export function registerAutomationRoutes(app: Express, prisma: PrismaClient) {
  app.post("/api/automation/tick", async (req, res) => {
    const secret = process.env["CRON_SECRET"];
    if (secret && req.headers.authorization !== `Bearer ${secret}`) { res.status(401).json({ error: "Unauthorized" }); return; }

    const lease = await acquireAutomationLease(prisma, "automation-tick", 30 * 60_000);
    if (!lease) { res.status(409).json({ error: "Automation tick already running" }); return; }

    try {
      const settings = await getAppSettings(prisma);
      const replies = settings.emailProvider === "gmail" ? await syncReplies(prisma, SAFETY_LIMITS.automationReplySyncMax) : [];
      const emailEnrichment = await enrichMissingEmails(prisma, SAFETY_LIMITS.automationEnrichmentMax);
      const researchLimit = Math.min(settings.researchBatchSize, SAFETY_LIMITS.automationResearchMax);
      const research = settings.autoResearch ? await processResearchReadyLeads(prisma, researchLimit) : [];
      const reconciled = await reconcileStaleSends(prisma, SAFETY_LIMITS.automationStaleSendMax);
      const followups = await processDueFollowUps(prisma, SAFETY_LIMITS.automationFollowupMax);
      const sends = await sendApprovedQueue(prisma, SAFETY_LIMITS.automationSendMax);
      res.json({
        success: true,
        limits: {
          replySync: SAFETY_LIMITS.automationReplySyncMax,
          emailEnrichment: SAFETY_LIMITS.automationEnrichmentMax,
          research: researchLimit,
          staleSendReconciliation: SAFETY_LIMITS.automationStaleSendMax,
          followups: SAFETY_LIMITS.automationFollowupMax,
          sends: SAFETY_LIMITS.automationSendMax,
          aiConcurrency: SAFETY_LIMITS.aiResearchConcurrency,
          enrichmentConcurrency: SAFETY_LIMITS.emailEnrichmentConcurrency,
        },
        replyThreadsChecked: replies.length,
        repliesFound: replies.filter((r) => r.reply).length,
        emailEnrichmentProcessed: emailEnrichment.length,
        emailsFound: emailEnrichment.filter((r) => r.found).length,
        emailRetriesScheduled: emailEnrichment.filter((r) => r.status === "retry").length,
        emailEnrichmentExhausted: emailEnrichment.filter((r) => r.status === "exhausted").length,
        researchProcessed: research.length,
        researchCompleted: research.filter((r) => r.success).length,
        draftsGenerated: research.filter((r) => r.draftId).length,
        staleSendsChecked: reconciled.length,
        staleSendsRecovered: reconciled.filter((r) => r.success).length,
        followupsProcessed: followups.length,
        followupsSent: followups.filter((r) => r.sent).length,
        approvedProcessed: sends.length,
        approvedSent: sends.filter((r) => r.success).length,
        replyErrors: replies.filter((r) => !r.success),
        emailEnrichmentErrors: emailEnrichment.filter((r) => r.error),
        researchErrors: research.filter((r) => !r.success),
        reconciliationErrors: reconciled.filter((r) => !r.success),
        followupErrors: followups.filter((r) => !r.success),
        sendErrors: sends.filter((r) => !r.success),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      await releaseAutomationLease(prisma, lease);
    }
  });
}
