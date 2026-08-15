import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

export function registerOutreachRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/outreach/review", async (_req, res) => {
    try {
      const messages = await prisma.outreachMessage.findMany({
        where: { status: { in: ["draft", "approved"] } },
        orderBy: [{ status: "asc" }, { generatedAt: "desc" }],
        include: {
          lead: {
            include: {
              problems: { orderBy: { confidence: "desc" }, take: 4 },
              scores: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          },
        },
      });
      res.json({ messages, total: messages.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/outreach/:id", async (req, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid message id" }); return; }
    const current = await prisma.outreachMessage.findUnique({ where: { id } });
    if (!current) { res.status(404).json({ error: "Message not found" }); return; }
    if (current.status === "sent") { res.status(409).json({ error: "Sent messages cannot be edited" }); return; }

    const { subject, bodyText, status } = req.body as { subject?: unknown; bodyText?: unknown; status?: unknown };
    const data: Record<string, unknown> = {};
    if (typeof subject === "string" && subject.trim()) data.subject = subject.trim();
    if (typeof bodyText === "string" && bodyText.trim()) data.bodyText = bodyText.trim();
    if (status !== undefined) {
      if (!["draft", "approved", "rejected"].includes(String(status))) { res.status(400).json({ error: "Invalid status" }); return; }
      data.status = String(status);
      if (status === "approved") data.approvedAt = new Date();
      if (status === "draft") data.approvedAt = null;
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const message = await tx.outreachMessage.update({ where: { id }, data });
        await tx.activity.create({
          data: {
            leadId: message.leadId,
            type: status === "approved" ? "message_approved" : status === "rejected" ? "message_rejected" : "message_updated",
            summary: status === "approved" ? "Initial outreach approved" : status === "rejected" ? "Outreach draft rejected" : "Outreach draft edited",
          },
        });
        return message;
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
