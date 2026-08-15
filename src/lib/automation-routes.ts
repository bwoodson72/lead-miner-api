import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { getAppSettings } from "./settings.js";
import { processDueFollowUps, syncReplies } from "./followup-reply-routes.js";
import { reconcileStaleSends, sendApprovedQueue } from "./outreach-sending.js";
import { acquireAutomationLease, releaseAutomationLease } from "./automation-lock.js";

export function registerAutomationRoutes(app: Express, prisma: PrismaClient) {
  app.post("/api/automation/tick", async (req, res) => {
    const secret = process.env["CRON_SECRET"];
    if (secret && req.headers.authorization !== `Bearer ${secret}`) { res.status(401).json({ error: "Unauthorized" }); return; }

    const lease = await acquireAutomationLease(prisma, "automation-tick", 10 * 60_000);
    if (!lease) { res.status(409).json({ error: "Automation tick already running" }); return; }

    try {
      const settings = await getAppSettings(prisma);
      const replies = settings.emailProvider === "gmail" ? await syncReplies(prisma, 100) : [];
      const reconciled = await reconcileStaleSends(prisma, 10);
      const followups = await processDueFollowUps(prisma, 50);
      const sends = await sendApprovedQueue(prisma, 50);
      res.json({
        success: true,
        replyThreadsChecked: replies.length,
        repliesFound: replies.filter((r) => r.reply).length,
        staleSendsChecked: reconciled.length,
        staleSendsRecovered: reconciled.filter((r) => r.success).length,
        followupsProcessed: followups.length,
        followupsSent: followups.filter((r) => r.sent).length,
        approvedProcessed: sends.length,
        approvedSent: sends.filter((r) => r.success).length,
        replyErrors: replies.filter((r) => !r.success),
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
