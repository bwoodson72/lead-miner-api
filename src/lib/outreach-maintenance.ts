import type { PrismaClient } from "../generated/prisma/client.js";
import { ensureInitialOutreachDraft, prioritizeLead, selectLeadOutreachAngle } from "./outreach-preparation.js";
import { isCurrentOutreachPromptVersion, outreachMessageNeedsRegeneration, requiredOutreachPromptVersion } from "./outreach-version.js";
import { processLeadResearch } from "./research-routes.js";

export type RegenerateUnsentScope = "all" | "initial" | "followup";

const OUTREACH_ELIGIBLE_DECISIONS = new Set(["rebuild_candidate"]);

type InitialRegenerationOutcome = {
  replacement: Awaited<ReturnType<typeof ensureInitialOutreachDraft>> | null;
  action: "regenerated" | "regenerated_after_research" | "cancelled_after_research_not_eligible";
  researchDecision?: string;
};

async function researchThenRegenerate(prisma: PrismaClient, leadId: number): Promise<InitialRegenerationOutcome> {
  const researched = await processLeadResearch(prisma, leadId);
  const researchDecision = researched.result.decision;
  if (!OUTREACH_ELIGIBLE_DECISIONS.has(researchDecision)) {
    return { replacement: null, action: "cancelled_after_research_not_eligible", researchDecision };
  }
  await prioritizeLead(prisma, leadId);
  await selectLeadOutreachAngle(prisma, leadId, true);
  return {
    replacement: await ensureInitialOutreachDraft(prisma, leadId, true),
    action: "regenerated_after_research",
    researchDecision,
  };
}

async function regenerateInitialWithCurrentEvidence(prisma: PrismaClient, leadId: number): Promise<InitialRegenerationOutcome> {
  try {
    return { replacement: await ensureInitialOutreachDraft(prisma, leadId, true), action: "regenerated" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === "Lead has no business-asset assessment" || /Legacy optimization candidate is not eligible for outreach/i.test(message)) {
      return researchThenRegenerate(prisma, leadId);
    }

    const staleAngle = message === "Outreach angle has not been selected"
      || message === "Selected outreach finding is no longer part of the latest assessment";
    if (!staleAngle) throw error;

    await prioritizeLead(prisma, leadId);
    await selectLeadOutreachAngle(prisma, leadId, true);
    return { replacement: await ensureInitialOutreachDraft(prisma, leadId, true), action: "regenerated" };
  }
}

export async function regenerateUnsentOutreach(
  prisma: PrismaClient,
  options: { scope?: RegenerateUnsentScope; messageIds?: number[]; limit?: number; force?: boolean } = {},
) {
  const scope = options.scope ?? "all";
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 500);
  const messages = await prisma.outreachMessage.findMany({
    where: {
      status: { in: ["draft", "approved"] },
      ...(scope === "initial" ? { kind: "initial" } : scope === "followup" ? { kind: "followup" } : {}),
      ...(options.messageIds?.length ? { id: { in: options.messageIds } } : {}),
    },
    orderBy: { generatedAt: "desc" },
    take: limit,
    select: { id: true, leadId: true, kind: true, sequenceNumber: true, subject: true, bodyText: true, cta: true, promptVersion: true, status: true },
  });

  const latestBySlot = new Map<string, (typeof messages)[number]>();
  for (const message of messages) {
    const key = `${message.leadId}:${message.kind}:${message.sequenceNumber}`;
    if (!latestBySlot.has(key)) latestBySlot.set(key, message);
  }

  const candidates = [...latestBySlot.values()].filter((message) =>
    options.force
    || !isCurrentOutreachPromptVersion(message.kind, message.promptVersion)
    || outreachMessageNeedsRegeneration(message.kind, message.bodyText, message.subject, message.cta ?? ""),
  );

  const results: Array<{ messageId: number; leadId: number; kind: string; success: boolean; replacementMessageId?: number; action?: string; error?: string }> = [];

  for (const message of candidates) {
    try {
      if (message.kind === "initial") {
        const alreadyStarted = await prisma.outreachMessage.findFirst({
          where: {
            leadId: message.leadId,
            kind: "initial",
            sequenceNumber: 1,
            status: { in: ["sending", "sent"] },
          },
          select: { id: true, status: true },
        });

        if (alreadyStarted) {
          await prisma.$transaction(async (tx) => {
            await tx.outreachMessage.updateMany({
              where: { leadId: message.leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved"] } },
              data: { status: "cancelled", requiresReview: true, sendError: `Stale initial draft cancelled because initial outreach is already ${alreadyStarted.status}` },
            });
            await tx.activity.create({
              data: {
                leadId: message.leadId,
                type: "legacy_outreach_invalidated",
                summary: `Cancelled stale unsent initial outreach because an initial message is already ${alreadyStarted.status}`,
                metadata: { previousMessageId: message.id, activeMessageId: alreadyStarted.id, previousPromptVersion: message.promptVersion },
              },
            });
          });
          results.push({ messageId: message.id, leadId: message.leadId, kind: message.kind, success: true, action: "cancelled_already_contacted" });
          continue;
        }

        const regeneration = await regenerateInitialWithCurrentEvidence(prisma, message.leadId);
        if (!regeneration.replacement) {
          await prisma.$transaction(async (tx) => {
            await tx.outreachMessage.updateMany({
              where: { leadId: message.leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved"] } },
              data: { status: "cancelled", requiresReview: true, sendError: `No current custom-rebuild opportunity after re-research (${regeneration.researchDecision ?? "unknown"})` },
            });
            await tx.activity.create({
              data: {
                leadId: message.leadId,
                type: "legacy_outreach_invalidated",
                summary: `Cancelled stale initial outreach because current research did not qualify a custom rebuild (${regeneration.researchDecision ?? "unknown"})`,
                metadata: { previousMessageId: message.id, previousPromptVersion: message.promptVersion, researchDecision: regeneration.researchDecision ?? null },
              },
            });
          });
          results.push({
            messageId: message.id,
            leadId: message.leadId,
            kind: message.kind,
            success: true,
            action: `${regeneration.action}:${regeneration.researchDecision ?? "unknown"}`,
          });
          continue;
        }

        const replacement = regeneration.replacement;
        await prisma.$transaction(async (tx) => {
          await tx.outreachMessage.updateMany({
            where: { leadId: message.leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved"] }, id: { not: replacement.id } },
            data: { status: "cancelled", requiresReview: true, sendError: "Superseded by current outreach prompt version" },
          });
          await tx.activity.create({
            data: {
              leadId: message.leadId,
              type: "legacy_outreach_regenerated",
              summary: `Regenerated unsent initial outreach with ${requiredOutreachPromptVersion("initial")}`,
              metadata: {
                previousMessageId: message.id,
                replacementMessageId: replacement.id,
                previousPromptVersion: message.promptVersion,
                regenerationAction: regeneration.action,
                researchDecision: regeneration.researchDecision ?? null,
              },
            },
          });
        });
        results.push({ messageId: message.id, leadId: message.leadId, kind: message.kind, success: true, replacementMessageId: replacement.id, action: regeneration.action });
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.outreachMessage.updateMany({
            where: {
              leadId: message.leadId,
              kind: "followup",
              sequenceNumber: message.sequenceNumber,
              status: { in: ["draft", "approved"] },
            },
            data: { status: "cancelled", requiresReview: true, sendError: `Stale follow-up cancelled; regenerate when due with ${requiredOutreachPromptVersion("followup")}` },
          });
          await tx.activity.create({
            data: {
              leadId: message.leadId,
              type: "legacy_followup_invalidated",
              summary: `Cancelled stale unsent follow-up ${message.sequenceNumber - 1}; it will be regenerated when due`,
              metadata: { messageId: message.id, previousPromptVersion: message.promptVersion, currentPromptVersion: requiredOutreachPromptVersion("followup") },
            },
          });
        });
        results.push({ messageId: message.id, leadId: message.leadId, kind: message.kind, success: true, action: "cancelled_for_due_regeneration" });
      }
    } catch (error) {
      results.push({ messageId: message.id, leadId: message.leadId, kind: message.kind, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    scanned: messages.length,
    stale: candidates.length,
    processed: results.length,
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    currentVersions: { initial: requiredOutreachPromptVersion("initial"), followup: requiredOutreachPromptVersion("followup") },
    results,
  };
}
