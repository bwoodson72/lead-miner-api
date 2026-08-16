import type { PrismaClient } from "../generated/prisma/client.js";
import { getAppSettings } from "./settings.js";
import { processDueFollowUps, syncReplies } from "./followup-reply-routes.js";
import { reconcileStaleSends, sendApprovedQueue } from "./outreach-sending.js";
import { enrichMissingEmails } from "./enrichment-routes.js";
import { processResearchReadyLeads } from "./research-routes.js";
import { processQualifiedOutreachPreparation } from "./outreach-preparation-job.js";
import { SAFETY_LIMITS } from "./safety-limits.js";

export const AUTOMATION_JOB_NAMES = [
  "sync_replies",
  "enrich",
  "research",
  "prepare_outreach",
  "reconcile_sends",
  "followups",
  "send_approved",
] as const;
export type AutomationJobName = typeof AUTOMATION_JOB_NAMES[number];

function summarizeResults(results: Array<any>) {
  const failed = results.filter((row) => row?.success === false || row?.error);
  return {
    processed: results.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    errorSummary: failed.length ? failed.slice(0, 10).map((row) => row.error ?? "Unknown failure").join(" | ") : null,
  };
}

export async function runNamedAutomationJob(prisma: PrismaClient, jobName: AutomationJobName) {
  const run = await prisma.automationRun.create({ data: { jobName, status: "running" } });
  const started = Date.now();
  try {
    const settings = await getAppSettings(prisma);
    let results: Array<any> = [];
    let skippedReason: string | null = null;
    switch (jobName) {
      case "sync_replies":
        if (!settings.autoSyncReplies) skippedReason = "Reply sync is disabled";
        else results = await syncReplies(prisma, SAFETY_LIMITS.automationReplySyncMax);
        break;
      case "enrich":
        if (!settings.autoEnrich) skippedReason = "Automatic enrichment is disabled";
        else results = await enrichMissingEmails(prisma, SAFETY_LIMITS.automationEnrichmentMax);
        break;
      case "research":
        if (!settings.autoResearch) skippedReason = "Automatic research is disabled";
        else results = await processResearchReadyLeads(prisma, Math.min(settings.researchBatchSize, SAFETY_LIMITS.automationResearchMax));
        break;
      case "prepare_outreach":
        if (!settings.autoPrioritize) skippedReason = "Automatic prioritization is disabled";
        else results = await processQualifiedOutreachPreparation(prisma, SAFETY_LIMITS.automationResearchMax);
        break;
      case "reconcile_sends":
        results = await reconcileStaleSends(prisma, SAFETY_LIMITS.automationStaleSendMax);
        break;
      case "followups":
        if (!settings.autoProcessFollowups) skippedReason = "Automatic follow-ups are disabled";
        else results = await processDueFollowUps(prisma, SAFETY_LIMITS.automationFollowupMax);
        break;
      case "send_approved":
        if (!settings.autoSendApproved) skippedReason = "Automatic approved-message sending is disabled";
        else results = await sendApprovedQueue(prisma, SAFETY_LIMITS.automationSendMax);
        break;
    }
    const summary = summarizeResults(results);
    const finishedAt = new Date();
    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: skippedReason ? "skipped" : summary.failed ? "completed_with_errors" : "complete",
        processed: summary.processed,
        succeeded: summary.succeeded,
        failed: summary.failed,
        errorSummary: summary.errorSummary,
        metadata: { skippedReason, durationMs: Date.now() - started },
        finishedAt,
      },
    });
    return { jobName, runId: run.id, skipped: Boolean(skippedReason), skippedReason, ...summary, results, durationMs: Date.now() - started, finishedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.automationRun.update({ where: { id: run.id }, data: { status: "failed", failed: 1, errorSummary: message, metadata: { durationMs: Date.now() - started }, finishedAt: new Date() } });
    throw error;
  }
}
