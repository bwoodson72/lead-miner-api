import type { PrismaClient } from "../generated/prisma/client.js";
import { generateOutreachDraft, OUTREACH_PROMPT_VERSION, outreachDraftNeedsRegeneration } from "./ai-outreach.js";
import { assertAiBudgetAvailable, hashAiPacket } from "./ai-budget.js";
import { estimateAiCost } from "./ai-cost.js";
import { withAiCapacity } from "./ai-capacity.js";
import { getContactIdentityRiskReason } from "./contact-safety.js";
import { normalizeOutreachNotes } from "./operator-outreach-notes.js";
import { getAppSettings } from "./settings.js";

const MANUAL_GENERATION_REASON = "Generated manually from My Notes";

export function manualOutreachNotesEligibilityReason(notes: string | null | undefined) {
  return normalizeOutreachNotes(notes)
    ? null
    : "Add My Notes before manually preparing outreach for a lead that research did not qualify.";
}

async function recentInitialCtas(prisma: PrismaClient, leadId: number) {
  const messages = await prisma.outreachMessage.findMany({
    where: { leadId: { not: leadId }, kind: "initial", cta: { not: null }, status: { not: "cancelled" } },
    orderBy: { generatedAt: "desc" },
    take: 20,
    select: { cta: true },
  });
  return messages.map((message) => message.cta).filter((cta): cta is string => Boolean(cta));
}

export async function ensureManualOutreachDraftFromNotes(prisma: PrismaClient, leadId: number, force = false) {
  const settings = await getAppSettings(prisma);
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { contacts: true },
  });
  if (!lead) throw new Error("Lead not found");
  if (!lead.email) throw new Error("Lead has no email address");

  const contactRisk = getContactIdentityRiskReason(lead);
  if (contactRisk) throw new Error(contactRisk);

  const operatorNotes = normalizeOutreachNotes(lead.outreachNotes);
  const notesReason = manualOutreachNotesEligibilityReason(operatorNotes);
  if (notesReason) throw new Error(notesReason);

  const existing = await prisma.outreachMessage.findFirst({
    where: { leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved", "sending", "sent"] } },
    orderBy: { generatedAt: "desc" },
  });
  if (existing && ["sending", "sent"].includes(existing.status)) return existing;

  const notesChangedAfterDraft = Boolean(existing && lead.outreachNotesUpdatedAt && lead.outreachNotesUpdatedAt > existing.generatedAt);
  const reusable = Boolean(
    existing
    && !force
    && !notesChangedAfterDraft
    && existing.promptVersion === OUTREACH_PROMPT_VERSION
    && !outreachDraftNeedsRegeneration(existing.bodyText, existing.subject, existing.cta ?? ""),
  );
  if (existing && reusable) {
    if (lead.status !== "ready_for_outreach") {
      await prisma.lead.update({ where: { id: leadId }, data: { status: "ready_for_outreach", outreachPreparedAt: new Date() } });
    }
    return existing;
  }

  const replaceExisting = Boolean(existing && ["draft", "approved"].includes(existing.status));
  const previousDraft = replaceExisting && existing ? {
    subject: existing.subject,
    bodyText: existing.bodyText,
    cta: existing.cta,
  } : null;
  const recentCtas = await recentInitialCtas(prisma, leadId);

  const manualInstructions = `${settings.outreachInstructions.trim()}\n\nMANUAL OPERATOR OUTREACH\nBrian explicitly chose to contact this lead even though automated research did not produce a rebuild qualification. My Notes below are the primary factual basis for this one manual outreach draft. Use the observation in My Notes directly and do not invent additional website findings. Do not change, discuss, or imply a different stored qualification decision.\n<operator_notes>\n${operatorNotes}\n</operator_notes>`;
  const strategy = {
    observation: operatorNotes!,
    ownerStake: "Explain one simple, plausible business consequence of the operator's observation without claiming known lost customers, leads, revenue, rankings, or conversions.",
    buyerMoment: null,
    psychologicalLever: "self_interest" as const,
  };
  const syntheticFinding = {
    id: 0,
    category: "operator_note",
    title: "Operator-provided website observation",
    evidence: operatorNotes!,
    assetCapability: "Use the operator-provided observation as the factual basis and explain only a plausible consequence.",
    confidence: 1,
    significance: "high",
  };
  const packet = {
    promptVersion: OUTREACH_PROMPT_VERSION,
    mode: "manual_operator_notes",
    model: settings.outreachModel,
    leadId,
    qualificationDecision: lead.qualificationDecision,
    operatorNotes,
    previousDraft,
    recentCtas,
    sender: { name: settings.senderName, email: settings.senderEmail },
  };
  const packetHash = hashAiPacket(packet);

  await assertAiBudgetAvailable(prisma, settings);
  const aiJob = await prisma.aIJob.create({
    data: {
      leadId,
      type: "outreach_draft",
      status: "running",
      model: settings.outreachModel,
      promptVersion: OUTREACH_PROMPT_VERSION,
      packetHash,
      startedAt: new Date(),
    },
  });

  try {
    const generated = await withAiCapacity(prisma, () => generateOutreachDraft({
      businessName: lead.businessName,
      domain: lead.domain,
      keyword: lead.keyword,
      senderName: settings.senderName,
      senderEmail: settings.senderEmail,
      qualificationDecision: null,
      strategy,
      recentCtas,
      operatorNotes: null,
      previousDraft,
      selectedFinding: syntheticFinding,
    }, settings.outreachModel, settings.minProblemConfidence, manualInstructions));

    return await prisma.$transaction(async (tx) => {
      if (replaceExisting && existing) {
        await tx.outreachMessage.update({
          where: { id: existing.id },
          data: {
            status: "cancelled",
            requiresReview: true,
            sendError: notesChangedAfterDraft
              ? "Superseded because My Notes changed"
              : "Superseded by manual outreach generation from My Notes",
          },
        });
      }

      const message = await tx.outreachMessage.create({
        data: {
          leadId,
          kind: "initial",
          sequenceNumber: 1,
          subject: generated.draft.subject,
          bodyText: generated.draft.bodyText,
          angle: generated.draft.angle,
          cta: generated.draft.cta,
          confidence: generated.draft.confidence,
          requiresReview: true,
          generationReason: MANUAL_GENERATION_REASON,
          promptVersion: OUTREACH_PROMPT_VERSION,
          status: "draft",
          approvedAt: null,
        },
      });

      await tx.lead.update({
        where: { id: leadId },
        data: { status: "ready_for_outreach", outreachPreparedAt: new Date() },
      });
      await tx.activity.create({
        data: {
          leadId,
          type: "message_generated",
          summary: `Generated manual initial outreach from My Notes: ${generated.draft.subject}`,
          metadata: {
            manualOperatorNotesOverride: true,
            qualificationDecision: lead.qualificationDecision,
            operatorNotesApplied: true,
            model: generated.model,
            promptVersion: OUTREACH_PROMPT_VERSION,
            generationAttempts: generated.attempts,
            replacedExistingMessageId: replaceExisting ? existing?.id ?? null : null,
          },
        },
      });
      await tx.aIJob.update({
        where: { id: aiJob.id },
        data: {
          status: "complete",
          model: generated.model,
          inputTokens: generated.inputTokens,
          cachedTokens: generated.cachedTokens,
          outputTokens: generated.outputTokens,
          estimatedCost: estimateAiCost(generated.model, generated.inputTokens, generated.outputTokens),
          completedAt: new Date(),
        },
      });
      return message;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.aIJob.update({ where: { id: aiJob.id }, data: { status: "failed", error: message, completedAt: new Date() } });
    await prisma.activity.create({ data: { leadId, type: "message_generation_failed", summary: message, metadata: { manualOperatorNotesOverride: true } } }).catch(() => undefined);
    throw error;
  }
}
