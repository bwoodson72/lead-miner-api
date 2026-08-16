import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { z, ZodError } from "zod";
import { sendApprovedQueue } from "./outreach-sending.js";
import { SAFETY_LIMITS, capRequestedLimit } from "./safety-limits.js";

const DecisionSchema = z.enum(["rebuild_candidate", "optimization_candidate", "no_material_opportunity", "needs_review"]);
const LifecycleSchema = z.enum(["new","enriching","research_pending","researching","research_failed","qualified","disqualified","ready_for_outreach","held","contacted","followup_due","replied","responded","interested","call_scheduled","proposal_sent","won","lost","rejected","bounced","unsubscribed","closed_no_response"]);
const QualifySchema = z.object({ decision: DecisionSchema, reason: z.string().max(3000).optional() });
const LeadPatchSchema = z.object({
  businessName: z.string().min(1).max(300).nullable().optional(),
  email: z.string().email().max(254).nullable().optional(),
  phone: z.string().max(100).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  category: z.string().max(300).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  region: z.string().max(200).nullable().optional(),
  status: LifecycleSchema.optional(),
  qualificationDecision: DecisionSchema.nullable().optional(),
  qualificationReason: z.string().max(3000).nullable().optional(),
  revisitAt: z.string().datetime().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "At least one lead update is required" });

function validationError(res: any, error: ZodError) { res.status(400).json({ error: "Invalid request", issues: error.issues }); }
function statusForDecision(decision: z.infer<typeof DecisionSchema>) {
  if (decision === "rebuild_candidate" || decision === "optimization_candidate") return "qualified";
  if (decision === "no_material_opportunity") return "disqualified";
  return "research_pending";
}

export function registerSpecCompatibilityRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/followups/due", async (req, res) => {
    const requested = Number(req.query["limit"] ?? SAFETY_LIMITS.automationFollowupMax);
    const limit = capRequestedLimit(requested, SAFETY_LIMITS.automationFollowupMax, SAFETY_LIMITS.automationFollowupMax);
    try {
      const leads = await prisma.lead.findMany({
        where: { status: "contacted", followUpDate: { lte: new Date() }, OR: [{ replyStatus: null }, { replyStatus: "out_of_office" }] },
        orderBy: { followUpDate: "asc" },
        take: limit,
        include: { outreachMessages: { where: { status: "sent" }, orderBy: { sequenceNumber: "asc" } } },
      });
      res.json({ leads, total: leads.length, cap: SAFETY_LIMITS.automationFollowupMax });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/outreach/bulk-send", async (req, res) => {
    const requested = Number(req.body?.limit ?? SAFETY_LIMITS.automationSendMax);
    if (Number.isFinite(requested) && requested > SAFETY_LIMITS.automationSendMax) { res.status(400).json({ error: `Bulk sending is capped at ${SAFETY_LIMITS.automationSendMax} messages per request` }); return; }
    const limit = capRequestedLimit(requested, SAFETY_LIMITS.automationSendMax, SAFETY_LIMITS.automationSendMax);
    try {
      const results = await sendApprovedQueue(prisma, limit);
      res.json({ processed: results.length, sent: results.filter((row) => row.success).length, failed: results.filter((row) => !row.success).length, results });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/leads/:id/qualify", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    let parsed: z.infer<typeof QualifySchema>;
    try { parsed = QualifySchema.parse(req.body); } catch (error) { if (error instanceof ZodError) { validationError(res, error); return; } throw error; }
    try {
      const status = statusForDecision(parsed.decision);
      const lead = await prisma.$transaction(async (tx) => {
        const updated = await tx.lead.update({ where: { id }, data: { status, qualificationDecision: parsed.decision, qualificationReason: parsed.reason ?? undefined, ...(status !== "qualified" ? { priorityScore: null, priorityBreakdown: {} } : {}) } });
        await tx.activity.create({ data: { leadId: id, type: status === "qualified" ? "qualified" : "disqualified", summary: `Operator qualification: ${parsed.decision}`, metadata: { reason: parsed.reason ?? null } } });
        return updated;
      });
      res.json(lead);
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.patch("/api/leads/:id", async (req, res) => {
    const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; }
    let parsed: z.infer<typeof LeadPatchSchema>;
    try { parsed = LeadPatchSchema.parse(req.body); } catch (error) { if (error instanceof ZodError) { validationError(res, error); return; } throw error; }
    try {
      const data: Record<string, unknown> = { ...parsed, revisitAt: parsed.revisitAt === undefined ? undefined : parsed.revisitAt ? new Date(parsed.revisitAt) : null };
      if (parsed.status && ["held","replied","interested","call_scheduled","proposal_sent","won","lost","rejected","bounced","unsubscribed","closed_no_response"].includes(parsed.status)) data.followUpDate = null;
      const lead = await prisma.$transaction(async (tx) => {
        const updated = await tx.lead.update({ where: { id }, data });
        if (parsed.email) await tx.contact.upsert({ where: { leadId_type_value: { leadId: id, type: "email", value: parsed.email.toLowerCase() } }, update: { role: "operator supplied", source: "manual", verificationStatus: "manual", isPrimary: true }, create: { leadId: id, type: "email", value: parsed.email.toLowerCase(), role: "operator supplied", source: "manual", verificationStatus: "manual", isPrimary: true } });
        if (parsed.phone) await tx.contact.upsert({ where: { leadId_type_value: { leadId: id, type: "phone", value: parsed.phone } }, update: { role: "operator supplied", source: "manual", verificationStatus: "manual", isPrimary: true }, create: { leadId: id, type: "phone", value: parsed.phone, role: "operator supplied", source: "manual", verificationStatus: "manual", isPrimary: true } });
        await tx.activity.create({ data: { leadId: id, type: "lead_updated", summary: "Lead updated by operator", metadata: { fields: Object.keys(parsed) } } });
        return updated;
      });
      res.json(lead);
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
