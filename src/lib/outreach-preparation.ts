import type { PrismaClient } from "../generated/prisma/client.js";
import { getAppSettings } from "./settings.js";
import { calculateOpportunityPriority } from "./prioritization.js";
import { selectOutreachAngle, OUTREACH_ANGLE_PROMPT_VERSION } from "./ai-outreach-angle.js";
import { generateOutreachDraft, OUTREACH_PROMPT_VERSION } from "./ai-outreach.js";
import { assertAiBudgetAvailable, hashAiPacket } from "./ai-budget.js";
import { estimateAiCost } from "./ai-cost.js";
import { withAiCapacity } from "./ai-capacity.js";

const QUALIFIED_ASSET_DECISIONS = new Set(["rebuild_candidate", "optimization_candidate"]);

async function loadOpportunity(prisma: PrismaClient, leadId: number) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      assetAssessments: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { findings: { orderBy: [{ significance: "desc" }, { confidence: "desc" }] } },
      },
    },
  });
  if (!lead) throw new Error("Lead not found");
  const assessment = lead.assetAssessments[0];
  if (!assessment) throw new Error("Lead has no business-asset assessment");
  if (!QUALIFIED_ASSET_DECISIONS.has(assessment.decision)) throw new Error(`Lead decision ${assessment.decision} is not outreach-eligible`);
  if (!lead.email) throw new Error("Lead has no email address");
  return { lead, assessment };
}

function siteMaturityRating(dimensions: unknown) {
  const object = dimensions && typeof dimensions === "object" ? dimensions as Record<string, any> : {};
  return typeof object.siteMaturity?.rating === "string" ? object.siteMaturity.rating : null;
}

export async function prioritizeLead(prisma: PrismaClient, leadId: number) {
  const settings = await getAppSettings(prisma);
  const { lead, assessment } = await loadOpportunity(prisma, leadId);
  const priority = calculateOpportunityPriority({
    decision: assessment.decision,
    assetStrength: assessment.assetStrength,
    assessmentConfidence: assessment.confidence,
    siteMaturityRating: siteMaturityRating(assessment.dimensions),
    findings: assessment.findings.map((finding) => ({ significance: finding.significance, confidence: finding.confidence })),
    email: lead.email,
    phone: lead.phone,
    adSource: lead.adSource,
    isAgencyManaged: lead.isAgencyManaged,
    isNationalChain: lead.isNationalChain,
  }, settings.priorityWeights);

  await prisma.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: leadId }, data: { priorityScore: priority.score, priorityBreakdown: priority } });
    await tx.activity.create({
      data: {
        leadId,
        type: "priority_calculated",
        summary: `Opportunity priority calculated: ${priority.score}`,
        metadata: priority,
      },
    });
  });
  return priority;
}

export async function selectLeadOutreachAngle(prisma: PrismaClient, leadId: number, force = false) {
  const settings = await getAppSettings(prisma);
  const { lead, assessment } = await loadOpportunity(prisma, leadId);
  const findings = assessment.findings.filter((finding) => finding.confidence >= settings.minProblemConfidence);
  if (!findings.length) throw new Error("No material finding meets the configured outreach confidence threshold");

  const packet = {
    promptVersion: OUTREACH_ANGLE_PROMPT_VERSION,
    model: settings.outreachModel,
    leadId,
    assessmentId: assessment.id,
    decision: assessment.decision,
    assetStrength: assessment.assetStrength,
    researchSummary: assessment.researchSummary,
    findings: findings.map((finding) => ({
      id: finding.id,
      category: finding.category,
      title: finding.title,
      evidence: finding.evidence,
      assetCapability: finding.assetCapability,
      confidence: finding.confidence,
      significance: finding.significance,
      evidenceSources: finding.evidenceSources,
    })),
  };
  const packetHash = hashAiPacket(packet);
  if (!force && lead.primaryOutreachAngle && lead.primaryOutreachFindingId) {
    const identical = await prisma.aIJob.findFirst({ where: { leadId, type: "outreach_angle", packetHash, status: "complete" }, orderBy: { createdAt: "desc" } });
    if (identical) return { reused: true, findingId: lead.primaryOutreachFindingId, angle: lead.primaryOutreachAngle, confidence: lead.primaryOutreachAngleConfidence ?? 0, rationale: lead.primaryOutreachAngleReason ?? "Previously selected from identical evidence", packetHash };
  }

  await assertAiBudgetAvailable(prisma, settings);
  const job = await prisma.aIJob.create({ data: { leadId, type: "outreach_angle", status: "running", model: settings.outreachModel, promptVersion: OUTREACH_ANGLE_PROMPT_VERSION, packetHash, startedAt: new Date() } });
  try {
    const generated = await withAiCapacity(prisma, () => selectOutreachAngle({
      businessName: lead.businessName,
      domain: lead.domain,
      keyword: lead.keyword,
      decision: assessment.decision,
      assetStrength: assessment.assetStrength,
      researchSummary: assessment.researchSummary,
      findings: findings.map((finding) => ({
        id: finding.id,
        category: finding.category,
        title: finding.title,
        evidence: finding.evidence,
        assetCapability: finding.assetCapability,
        confidence: finding.confidence,
        significance: finding.significance,
        evidenceSources: finding.evidenceSources,
      })),
    }, settings.outreachModel));
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: leadId },
        data: {
          primaryOutreachAngle: generated.result.angle,
          primaryOutreachAngleReason: generated.result.rationale,
          primaryOutreachAngleConfidence: generated.result.confidence,
          primaryOutreachFindingId: generated.result.findingId,
          outreachPreparedAt: new Date(),
        },
      });
      await tx.activity.create({
        data: {
          leadId,
          type: "outreach_angle_selected",
          summary: generated.result.angle,
          metadata: { findingId: generated.result.findingId, confidence: generated.result.confidence, rationale: generated.result.rationale, model: generated.model },
        },
      });
      await tx.aIJob.update({
        where: { id: job.id },
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
    });
    return { reused: false, ...generated.result, packetHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.aIJob.update({ where: { id: job.id }, data: { status: "failed", error: message, completedAt: new Date() } });
    throw error;
  }
}

export async function ensureInitialOutreachDraft(prisma: PrismaClient, leadId: number, force = false) {
  const settings = await getAppSettings(prisma);
  const { lead, assessment } = await loadOpportunity(prisma, leadId);
  const existing = await prisma.outreachMessage.findFirst({
    where: { leadId, kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved", "sending", "sent"] } },
    orderBy: { generatedAt: "desc" },
  });
  if (existing && !force) {
    if (lead.status === "qualified") await prisma.lead.update({ where: { id: leadId }, data: { status: "ready_for_outreach" } });
    return existing;
  }
  if (!lead.primaryOutreachAngle || !lead.primaryOutreachFindingId) throw new Error("Outreach angle has not been selected");
  const selectedFinding = assessment.findings.find((finding) => finding.id === lead.primaryOutreachFindingId);
  if (!selectedFinding) throw new Error("Selected outreach finding is no longer part of the latest assessment");

  const packet = {
    promptVersion: OUTREACH_PROMPT_VERSION,
    model: settings.outreachModel,
    instructions: settings.outreachInstructions,
    leadId,
    assessmentId: assessment.id,
    decision: assessment.decision,
    assetStrength: assessment.assetStrength,
    researchSummary: assessment.researchSummary,
    decisionReason: assessment.decisionReason,
    angle: lead.primaryOutreachAngle,
    finding: {
      id: selectedFinding.id,
      category: selectedFinding.category,
      title: selectedFinding.title,
      evidence: selectedFinding.evidence,
      assetCapability: selectedFinding.assetCapability,
      confidence: selectedFinding.confidence,
      significance: selectedFinding.significance,
    },
  };
  const packetHash = hashAiPacket(packet);
  if (!force) {
    const identical = await prisma.aIJob.findFirst({ where: { leadId, type: "outreach_draft", packetHash, status: "complete" }, orderBy: { createdAt: "desc" } });
    if (identical && existing) return existing;
  }

  await assertAiBudgetAvailable(prisma, settings);
  const aiJob = await prisma.aIJob.create({ data: { leadId, type: "outreach_draft", status: "running", model: settings.outreachModel, promptVersion: OUTREACH_PROMPT_VERSION, packetHash, startedAt: new Date() } });
  try {
    const generated = await withAiCapacity(prisma, () => generateOutreachDraft({
      businessName: lead.businessName,
      domain: lead.domain,
      keyword: lead.keyword,
      primaryOutreachAngle: lead.primaryOutreachAngle!,
      researchSummary: assessment.researchSummary,
      qualificationReason: assessment.decisionReason,
      qualificationDecision: assessment.decision,
      assetStrength: assessment.assetStrength,
      selectedFinding: {
        id: selectedFinding.id,
        category: selectedFinding.category,
        title: selectedFinding.title,
        evidence: selectedFinding.evidence,
        assetCapability: selectedFinding.assetCapability,
        confidence: selectedFinding.confidence,
        significance: selectedFinding.significance,
      },
    }, settings.outreachModel, settings.minProblemConfidence, settings.outreachInstructions));
    const shouldAutoApprove = settings.approvalMode === "auto_safe"
      && (lead.priorityScore ?? 0) >= settings.minAutoApprovePriority
      && generated.draft.confidence >= settings.minAutoApproveConfidence
      && !generated.draft.requiresReview;
    const status = shouldAutoApprove ? "approved" : "draft";
    return await prisma.$transaction(async (tx) => {
      if (force && existing && ["draft", "approved"].includes(existing.status)) await tx.outreachMessage.update({ where: { id: existing.id }, data: { status: "cancelled" } });
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
          requiresReview: generated.draft.requiresReview,
          generationReason: force ? "Regenerated by operator request" : null,
          status,
          approvedAt: shouldAutoApprove ? new Date() : null,
        },
      });
      await tx.lead.update({ where: { id: leadId }, data: { status: "ready_for_outreach", outreachPreparedAt: new Date() } });
      await tx.activity.create({
        data: {
          leadId,
          type: shouldAutoApprove ? "message_auto_approved" : "message_generated",
          summary: `${shouldAutoApprove ? "Auto-approved" : "Generated"} initial outreach: ${generated.draft.subject}`,
          metadata: { confidence: generated.draft.confidence, requiresReview: generated.draft.requiresReview, findingId: selectedFinding.id, qualificationDecision: assessment.decision, model: generated.model, approvalMode: settings.approvalMode },
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
    await prisma.activity.create({ data: { leadId, type: "message_generation_failed", summary: message } });
    throw error;
  }
}

export async function prepareLeadForOutreach(prisma: PrismaClient, leadId: number, options: { forceAngle?: boolean; forceDraft?: boolean; generateDraft?: boolean } = {}) {
  const settings = await getAppSettings(prisma);
  const priority = await prioritizeLead(prisma, leadId);
  if (priority.score < settings.minPriorityScore) {
    await prisma.activity.create({ data: { leadId, type: "outreach_held_low_priority", summary: `Qualified opportunity held below minimum priority (${priority.score} < ${settings.minPriorityScore})`, metadata: { score: priority.score, minimum: settings.minPriorityScore } } });
    return { priority, angle: null, draft: null, held: true };
  }
  if (!settings.autoSelectOutreachAngle && !options.forceAngle) return { priority, angle: null, draft: null, held: false };
  const angle = await selectLeadOutreachAngle(prisma, leadId, options.forceAngle ?? false);
  const shouldDraft = options.generateDraft ?? settings.autoDraftOutreach;
  const draft = shouldDraft ? await ensureInitialOutreachDraft(prisma, leadId, options.forceDraft ?? false) : null;
  return { priority, angle, draft, held: false };
}
