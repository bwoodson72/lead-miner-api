import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { ensureInitialOutreachDraft } from "./research-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { sendApprovedMessage, sendApprovedQueue } from "./outreach-sending.js";
import { registerFollowupReplyRoutes } from "./followup-reply-routes.js";
import { registerAutomationRoutes } from "./automation-routes.js";
import { registerAnalyticsRoutes } from "./analytics-routes.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

export function registerOutreachRoutes(app: Express, prisma: PrismaClient) {
  registerSettingsRoutes(app, prisma);
  registerFollowupReplyRoutes(app, prisma);
  registerAutomationRoutes(app, prisma);
  registerAnalyticsRoutes(app, prisma);

  app.get("/api/outreach/review", async (_req, res) => {
    try {
      const messages = await prisma.outreachMessage.findMany({ where: { status: { in: ["draft", "approved"] } }, orderBy: [{ status: "asc" }, { generatedAt: "desc" }], include: { lead: { include: { problems: { orderBy: { confidence: "desc" }, take: 4 }, scores: { orderBy: { createdAt: "desc" }, take: 1 } } } } });
      res.json({ messages, total: messages.length });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/outreach/backfill-drafts", async (req, res) => {
    const requested = Number(req.body?.limit ?? SAFETY_LIMITS.bulkResearchMax);
    if (Number.isFinite(requested) && requested > SAFETY_LIMITS.bulkResearchMax) { res.status(400).json({ error: `Draft backfill is capped at ${SAFETY_LIMITS.bulkResearchMax} leads per request` }); return; }
    const limit = capRequestedLimit(requested, SAFETY_LIMITS.bulkResearchMax, SAFETY_LIMITS.bulkResearchMax);
    try {
      const leads = await prisma.lead.findMany({ where: { qualificationDecision: "qualified", email: { not: null }, status: { in: ["qualified", "ready_for_outreach"] }, outreachMessages: { none: { kind: "initial", sequenceNumber: 1, status: { in: ["draft", "approved", "sending", "sent"] } } } }, orderBy: [{ priorityScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], take: limit, select: { id: true } });
      const results: Array<{ leadId:number; success:boolean; messageId?:number; error?:string }> = [];
      for (const lead of leads) { try { const message = await ensureInitialOutreachDraft(prisma, lead.id); results.push({ leadId: lead.id, success: true, messageId: message?.id }); } catch (error) { results.push({ leadId: lead.id, success: false, error: error instanceof Error ? error.message : String(error) }); } }
      res.json({ processed: results.length, cap: SAFETY_LIMITS.bulkResearchMax, results });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.patch("/api/outreach/:id", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
    const current = await prisma.outreachMessage.findUnique({ where: { id } });
    if (!current) { res.status(404).json({ error: "Message not found" }); return; }
    if (["sending", "sent"].includes(current.status)) { res.status(409).json({ error: "Messages cannot be edited after sending has started" }); return; }
    const { subject, bodyText, status } = req.body as { subject?:unknown; bodyText?:unknown; status?:unknown };
    const data: Record<string, unknown> = {};
    if (typeof subject === "string" && subject.trim()) data.subject = subject.trim();
    if (typeof bodyText === "string" && bodyText.trim()) data.bodyText = bodyText.trim();
    if (status !== undefined) { if (!["draft", "approved", "rejected"].includes(String(status))) { res.status(400).json({ error: "Invalid status" }); return; } data.status = String(status); if (status === "approved") data.approvedAt = new Date(); if (status === "draft") data.approvedAt = null; }
    try {
      const updated = await prisma.$transaction(async (tx) => { const message = await tx.outreachMessage.update({ where: { id }, data }); await tx.activity.create({ data: { leadId: message.leadId, type: status === "approved" ? "message_approved" : status === "rejected" ? "message_rejected" : "message_updated", summary: status === "approved" ? "Outreach approved" : status === "rejected" ? "Outreach draft rejected" : "Outreach draft edited" } }); return message; });
      res.json(updated);
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
