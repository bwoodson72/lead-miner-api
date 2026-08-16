import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { z, ZodError } from "zod";
import { ensureInitialOutreachDraft, prepareLeadForOutreach, prioritizeLead, selectLeadOutreachAngle } from "./outreach-preparation.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { sendApprovedMessage, sendApprovedQueue } from "./outreach-sending.js";
import { registerFollowupReplyRoutes } from "./followup-reply-routes.js";
import { registerAutomationRoutes } from "./automation-routes.js";
import { registerAnalyticsRoutes } from "./analytics-routes.js";
import { getAppSettings } from "./settings.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

const MessagePatchSchema = z.object({
  subject: z.string().min(1).max(120).optional(),
  bodyText: z.string().min(1).max(2500).optional(),
  status: z.enum(["draft", "approved", "rejected"]).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "At least one update is required" });
const RegenerateSchema = z.object({ reason: z.string().min(3).max(1000) });
const BulkIdsSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(50) });

function invalid(res: any, error: ZodError) { res.status(400).json({ error: "Invalid request", issues: error.issues }); }

export function registerOutreachRoutes(app: Express, prisma: PrismaClient) {
  registerSettingsRoutes(app, prisma);
  registerFollowupReplyRoutes(app, prisma);
  registerAutomationRoutes(app, prisma);
  registerAnalyticsRoutes(app, prisma);

  app.get("/api/outreach/review", async (_req, res) => {
    try {
      const messages = await prisma.outreachMessage.findMany({
        where: { status: { in: ["draft", "approved"] } },
        orderBy: [{ status: "asc" }, { generatedAt: "desc" }],
        include: {
          lead: {
            include: {
              assetAssessments: { orderBy: { createdAt: "desc" }, take: 1, include: { findings: { orderBy: [{ significance: "desc" }, { confidence: "desc" }] } } },
              problems: { orderBy: { confidence: "desc" }, take: 4 },
              scores: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          },
        },
      });
      res.json({ messages, total: messages.length });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/leads/:id/outreach/prepare", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    try { res.json(await prepareLeadForOutreach(prisma, id, { forceAngle: req.body?.forceAngle === true, forceDraft: req.body?.forceDraft === true, generateDraft: req.body?.generateDraft !== false })); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/leads/:id/prioritize", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    try { res.json(await prioritizeLead(prisma, id)); } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/leads/:id/outreach/angle", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    try { res.json(await selectLeadOutreachAngle(prisma, id, req.body?.force === true)); } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/leads/:id/outreach/generate", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    try { res.json(await ensureInitialOutreachDraft(prisma, id, req.body?.force === true)); } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/outreach/backfill-drafts", async (req, res) => {
    const requested = Number(req.body?.limit ?? SAFETY_LIMITS.bulkResearchMax);
    if (Number.isFinite(requested) && requested > SAFETY_LIMITS.bulkResearchMax) { res.status(400).json({ error: `Draft backfill is capped at ${SAFETY_LIMITS.bulkResearchMax} leads per request` }); return; }
    const limit = capRequestedLimit(requested, SAFETY_LIMITS.bulkResearchMax, SAFETY_LIMITS.bulkResearchMax);
    try {
      const leads = await prisma.lead.findMany({
        where: {
          qualificationDecision: { in: ["rebuild_candidate", "optimization_candidate"] },
          email: { not: null },
          status: { in: ["qualified", "ready_for_outreach"] },
          outreachMessages: { none: { kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved", "sending", "sent"] } } },
        },
        orderBy: [{ priorityScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take: limit,
        select: { id: true },
      });
      const results: Array<{ leadId:number; success:boolean; messageId?:number; priorityScore?:number; error?:string }> = [];
      for (const lead of leads) {
        try {
          const prepared = await prepareLeadForOutreach(prisma, lead.id, { generateDraft: true });
          results.push({ leadId: lead.id, success: true, messageId: prepared.draft?.id, priorityScore: prepared.priority.score });
        } catch (error) { results.push({ leadId: lead.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
      }
      res.json({ processed: results.length, cap: SAFETY_LIMITS.bulkResearchMax, results });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.patch("/api/outreach/:id", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
    let parsed: z.infer<typeof MessagePatchSchema>;
    try { parsed = MessagePatchSchema.parse(req.body); } catch (error) { if (error instanceof ZodError) { invalid(res, error); return; } throw error; }
    const current = await prisma.outreachMessage.findUnique({ where: { id } });
    if (!current) { res.status(404).json({ error: "Message not found" }); return; }
    if (["sending", "sent"].includes(current.status)) { res.status(409).json({ error: "Messages cannot be edited after sending has started" }); return; }
    const data: Record<string, unknown> = {};
    if (parsed.subject) data.subject = parsed.subject.trim();
    if (parsed.bodyText) data.bodyText = parsed.bodyText.trim();
    if (parsed.scheduledAt !== undefined) data.scheduledAt = parsed.scheduledAt ? new Date(parsed.scheduledAt) : null;
    if (parsed.status !== undefined) {
      data.status = parsed.status;
      if (parsed.status === "approved") data.approvedAt = new Date();
      if (parsed.status === "draft") data.approvedAt = null;
    }
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const message = await tx.outreachMessage.update({ where: { id }, data });
        if (parsed.status === "rejected") await tx.lead.update({ where: { id: message.leadId }, data: { status: "held", followUpDate: null } });
        await tx.activity.create({ data: { leadId: message.leadId, type: parsed.status === "approved" ? "message_approved" : parsed.status === "rejected" ? "message_rejected" : "message_updated", summary: parsed.status === "approved" ? "Outreach approved" : parsed.status === "rejected" ? "Outreach draft rejected and lead held" : "Outreach draft edited", metadata: { scheduledAt: parsed.scheduledAt ?? null } } });
        return message;
      });
      res.json(updated);
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/outreach/:id/regenerate", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
    let parsed: z.infer<typeof RegenerateSchema>;
    try { parsed = RegenerateSchema.parse(req.body); } catch (error) { if (error instanceof ZodError) { invalid(res, error); return; } throw error; }
    const current = await prisma.outreachMessage.findUnique({ where: { id } });
    if (!current) { res.status(404).json({ error: "Message not found" }); return; }
    if (current.kind !== "initial" || ["sending", "sent"].includes(current.status)) { res.status(409).json({ error: "Only unsent initial outreach can be regenerated" }); return; }
    try {
      const message = await ensureInitialOutreachDraft(prisma, current.leadId, true);
      if (message) await prisma.outreachMessage.update({ where: { id: message.id }, data: { generationReason: parsed.reason } });
      await prisma.activity.create({ data: { leadId: current.leadId, type: "message_regenerated", summary: `Outreach regenerated: ${parsed.reason}`, metadata: { previousMessageId: id, replacementMessageId: message?.id ?? null } } });
      res.json(message);
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/outreach/bulk-approve", async (req, res) => {
    let parsed: z.infer<typeof BulkIdsSchema>;
    try { parsed = BulkIdsSchema.parse(req.body); } catch (error) { if (error instanceof ZodError) { invalid(res, error); return; } throw error; }
    try {
      const settings = await getAppSettings(prisma);
      const messages = await prisma.outreachMessage.findMany({ where: { id: { in: parsed.ids }, status: "draft" }, include: { lead: true } });
      if (messages.length !== parsed.ids.length) { res.status(409).json({ error: "Every selected message must still be an unsent draft" }); return; }
      const unsafe = messages.filter((message) => message.requiresReview || (message.confidence ?? 0) < settings.minAutoApproveConfidence || (message.lead.priorityScore ?? 0) < settings.minAutoApprovePriority);
      if (unsafe.length) { res.status(409).json({ error: "Bulk approval blocked because one or more drafts do not meet configured quality thresholds", messageIds: unsafe.map((message) => message.id) }); return; }
      await prisma.$transaction(async (tx) => {
        await tx.outreachMessage.updateMany({ where: { id: { in: parsed.ids } }, data: { status: "approved", approvedAt: new Date() } });
        for (const message of messages) await tx.activity.create({ data: { leadId: message.leadId, type: "message_approved", summary: "Outreach bulk-approved" } });
      });
      res.json({ approved: messages.length });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/outreach/:id/send", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
    try { res.json(await sendApprovedMessage(prisma, id)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/outreach/send-approved", async (req, res) => {
    const requested = Number(req.body?.limit ?? SAFETY_LIMITS.automationSendMax);
    if (Number.isFinite(requested) && requested > SAFETY_LIMITS.automationSendMax) { res.status(400).json({ error: `Bulk sending is capped at ${SAFETY_LIMITS.automationSendMax} messages per request` }); return; }
    const limit = capRequestedLimit(requested, SAFETY_LIMITS.automationSendMax, SAFETY_LIMITS.automationSendMax);
    try { const results = await sendApprovedQueue(prisma, limit); res.json({ processed: results.length, cap: SAFETY_LIMITS.automationSendMax, sent: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length, results }); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
