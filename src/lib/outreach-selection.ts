import type { PrismaClient } from "../generated/prisma/client.js";
import { decodeOutreachPsychology, encodeOperatorNotesSelection } from "./ai-outreach-angle.js";
import { normalizeOutreachNotes } from "./operator-outreach-notes.js";
import { selectLeadOutreachAngle } from "./outreach-preparation.js";

export type OutreachSelectionInput =
  | { mode: "auto" }
  | { mode: "finding"; findingId: number }
  | { mode: "notes" };

async function cancelUnsentInitialDrafts(prisma: PrismaClient, leadId: number, reason: string) {
  await prisma.outreachMessage.updateMany({
    where: { leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved"] } },
    data: { status: "cancelled", requiresReview: true, sendError: reason },
  });
}

export function currentOutreachSelection(reason: string | null | undefined, findingId: number | null | undefined) {
  const psychology = decodeOutreachPsychology(reason);
  if (psychology?.selectionSource === "operator_notes") return { mode: "notes" as const, findingId: null };
  if (psychology?.selectionSource === "operator") return { mode: "finding" as const, findingId: findingId ?? null };
  return { mode: "auto" as const, findingId: findingId ?? null };
}

export async function setLeadOutreachSelection(prisma: PrismaClient, leadId: number, selection: OutreachSelectionInput) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      assetAssessments: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { findings: true },
      },
    },
  });
  if (!lead) throw new Error("Lead not found");

  if (selection.mode === "auto") {
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          primaryOutreachAngle: null,
          primaryOutreachAngleReason: null,
          primaryOutreachAngleConfidence: null,
          primaryOutreachFindingId: null,
          outreachPreparedAt: null,
        },
      });
      await tx.outreachMessage.updateMany({
        where: { leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved"] } },
        data: { status: "cancelled", requiresReview: true, sendError: "Superseded because operator reset outreach selection to automatic" },
      });
      await tx.activity.create({
        data: {
          leadId,
          type: "outreach_selection_changed",
          summary: "Outreach selection reset to automatic",
          metadata: { mode: "auto" },
        },
      });
    });
    return { mode: "auto" as const, findingId: null, observation: null };
  }

  if (selection.mode === "notes") {
    const notes = normalizeOutreachNotes(lead.outreachNotes);
    if (!notes) throw new Error("Add My Notes before choosing them as the primary outreach basis");
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          primaryOutreachAngle: notes,
          primaryOutreachAngleReason: encodeOperatorNotesSelection(notes),
          primaryOutreachAngleConfidence: 1,
          primaryOutreachFindingId: null,
          outreachPreparedAt: new Date(),
        },
      });
      await tx.outreachMessage.updateMany({
        where: { leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved"] } },
        data: { status: "cancelled", requiresReview: true, sendError: "Superseded because operator chose My Notes as the outreach basis" },
      });
      await tx.activity.create({
        data: {
          leadId,
          type: "outreach_selection_changed",
          summary: "Operator chose My Notes as the primary outreach basis",
          metadata: { mode: "notes" },
        },
      });
    });
    return { mode: "notes" as const, findingId: null, observation: notes };
  }

  const assessment = lead.assetAssessments[0];
  if (!assessment) throw new Error("Lead has no business-asset assessment");
  const finding = assessment.findings.find((item) => item.id === selection.findingId);
  if (!finding) throw new Error("Selected finding is not part of the latest research assessment");

  const selected = await selectLeadOutreachAngle(prisma, leadId, true, {
    preferredFindingId: selection.findingId,
    selectionSource: "operator",
  });
  await cancelUnsentInitialDrafts(prisma, leadId, "Superseded because operator changed the primary outreach finding");
  await prisma.activity.create({
    data: {
      leadId,
      type: "outreach_selection_changed",
      summary: `Operator selected outreach finding: ${finding.title}`,
      metadata: { mode: "finding", findingId: finding.id, category: finding.category },
    },
  });
  return { mode: "finding" as const, findingId: finding.id, observation: selected.observation };
}
