import express from "express";
import cors from "cors";
import { z } from "zod";
import { stringify as csvStringify } from "csv-stringify/sync";
import { KeywordInputSchema } from "./lib/schemas.js";
import { runLeadSearchPipeline } from "./lib/pipeline.js";
import { DEFAULT_KEYWORDS } from "./config/keywords.js";
import { DEFAULT_THRESHOLDS } from "./config/thresholds.js";
import { createJob, getJob, updateJob, cleanOldJobs } from "./lib/jobs.js";
import { registerResearchRoutes } from "./lib/research-routes.js";
import { registerOutreachRoutes } from "./lib/outreach-routes.js";
import { authorizeCronRequest } from "./lib/automation-policy.js";
import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }) });
const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "http://localhost:3000").split(",").map((o) => o.trim());
const app = express();
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

function rateLimit(windowMs: number, max: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now(); const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count++; buckets.set(key, bucket);
    if (bucket.count > max) { res.status(429).json({ error: "Too many expensive requests; try again after the current rate-limit window" }); return; }
    next();
  };
}
const expensiveRequestLimit = rateLimit(60_000, 30);

app.post("/api/run-lead-search", expensiveRequestLimit, (req, res) => {
  const parsed = KeywordInputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.issues }); return; }
  const job = createJob();
  updateJob(job.id, { status: "running", progress: { stage: "starting", detail: "Initializing pipeline..." } });
  runLeadSearchPipeline(parsed.data, (stage, detail) => updateJob(job.id, { progress: { stage, detail } }))
    .then(({ leads, keywords, diagnostics }) => updateJob(job.id, { status: "complete", completedAt: Date.now(), leads, keywords, diagnostics: diagnostics as Record<string, unknown>, progress: { stage: "complete", detail: `Done — ${leads.length} leads found` } }))
    .catch((err) => updateJob(job.id, { status: "failed", completedAt: Date.now(), error: err instanceof Error ? err.message : String(err), progress: { stage: "failed", detail: "Pipeline failed" } }));
  res.status(202).json({ success: true, jobId: job.id });
});

app.get("/api/jobs/:id", (req, res) => { const job = getJob(req.params["id"] ?? ""); if (!job) { res.status(404).json({ error: "Job not found" }); return; } res.json(job); });
app.get("/api/cron", async (req, res) => { const auth = authorizeCronRequest(req.headers.authorization); if (!auth.ok) { res.status(auth.status).json({ success: false, error: auth.error }); return; } try { const input = KeywordInputSchema.parse({ keywords: DEFAULT_KEYWORDS.join("\n"), ...DEFAULT_THRESHOLDS }); const { leads, keywords, diagnostics } = await runLeadSearchPipeline(input); res.json({ success: true, leadsFound: leads.length, leads, keywords, diagnostics }); } catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); } });

const LifecycleSchema = z.enum(["new","enriching","research_pending","researching","research_failed","qualified","disqualified","ready_for_outreach","held","contacted","followup_due","responded","replied","interested","call_scheduled","proposal_sent","won","lost","rejected","bounced","unsubscribed","closed_no_response"]);
const RejectReasonSchema = z.enum(["agency_managed","national_chain","not_a_business","already_has_vendor","bad_data","parked_domain","other"]);
const StatusUpdateSchema = z.object({ status: LifecycleSchema, followUpDate: z.string().datetime().optional() });
const FollowUpSchema = z.object({ followUpDate: z.string().datetime() });
const SnoozeSchema = z.object({ days: z.number().int().min(1).max(30).default(3) });
const BatchRejectSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100), reason: RejectReasonSchema });

app.get("/api/leads/export", async (req, res) => {
  const { status, hideRejected, hideAgency, hideChains, hasEmail, hasPhone, search } = req.query as Record<string, string | undefined>; const where: Record<string, any> = {};
  if (status) where.status = status; if (hideRejected === "true" && !status) where.status = { not: "rejected" }; if (hideAgency === "true") where.isAgencyManaged = false; if (hideChains === "true") where.isNationalChain = false; if (hasEmail === "true") where.email = { not: null }; if (hasPhone === "true") where.phone = { not: null }; if (search) where.OR = [{ businessName: { contains: search, mode: "insensitive" } }, { domain: { contains: search, mode: "insensitive" } }];
  try { const leads = await prisma.lead.findMany({ where, orderBy: [{ priorityScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }] }); const rows = leads.map((lead) => ({ "Business Name": lead.businessName ?? "", Domain: lead.domain, Website: lead.landingPageUrl, Phone: lead.phone ?? "", Email: lead.email ?? "", Address: lead.address ?? "", Keyword: lead.keyword, "Performance Score": lead.lighthouseScore, "LCP (ms)": lead.lcp, Priority: lead.priorityScore ?? "", Decision: lead.qualificationDecision ?? "", "Outreach Angle": lead.primaryOutreachAngle ?? "", Status: lead.status, "Outreach Count": lead.outreachCount, "Last Outreach": lead.lastOutreachDate?.toISOString() ?? "", "Follow Up Date": lead.followUpDate?.toISOString() ?? "", "Agency Managed": lead.isAgencyManaged ? "Yes" : "No", "National Chain": lead.isNationalChain ? "Yes" : "No" })); res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"'); res.send(csvStringify(rows, { header: true })); } catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});

app.get("/api/leads", async (req, res) => {
  const { status, minLcp, isAgencyManaged, isNationalChain, hideRejected, followUpDue, qualificationDecision, minPriority, limit, offset, adSource, hasEmail, hasPhone, search } = req.query as Record<string, string | undefined>; const where: Record<string, any> = {};
  if (status) where.status = status; if (hideRejected === "true" && !status) where.status = { not: "rejected" }; if (minLcp) where.lcp = { gte: parseInt(minLcp, 10) }; if (qualificationDecision) where.qualificationDecision = qualificationDecision; if (minPriority) where.priorityScore = { gte: parseInt(minPriority, 10) }; if (isAgencyManaged !== undefined) where.isAgencyManaged = isAgencyManaged === "true"; if (isNationalChain !== undefined) where.isNationalChain = isNationalChain === "true"; if (adSource === "paid_ad" || adSource === "local_organic") where.adSource = adSource; if (hasEmail === "true") where.email = { not: null }; if (hasPhone === "true") where.phone = { not: null }; if (search) where.OR = [{ businessName: { contains: search, mode: "insensitive" } }, { domain: { contains: search, mode: "insensitive" } }]; if (followUpDue === "true") { where.followUpDate = { lte: new Date() }; where.status = "contacted"; }
  try { const take = Math.min(100, Math.max(1, limit ? parseInt(limit, 10) : 50)); const skip = Math.max(0, offset ? parseInt(offset, 10) : 0); const [leads,total] = await Promise.all([prisma.lead.findMany({ where, orderBy: [{ priorityScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], take, skip }), prisma.lead.count({ where })]); res.json({ leads, total, limit: take, offset: skip }); } catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});

app.get("/api/leads/:id/detail", async (req, res) => { const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid lead id" }); return; } try { const lead = await prisma.lead.findUnique({ where: { id }, include: { problems: { orderBy: [{ outreachValue: "desc" }, { confidence: "desc" }] }, scores: { orderBy: { createdAt: "desc" } }, outreachMessages: { orderBy: [{ sequenceNumber: "asc" }, { generatedAt: "asc" }] }, activities: { orderBy: { createdAt: "desc" } }, aiJobs: { orderBy: { createdAt: "desc" } }, suppressions: { orderBy: { createdAt: "desc" } }, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }, emailThreads: { orderBy: { updatedAt: "desc" } } } }); if (!lead) { res.status(404).json({ error: "Lead not found" }); return; } res.json({ lead }); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });

app.get("/api/dashboard/summary", async (_req, res) => { const now = new Date(); const [newLeads,qualified,ready,followupsDue,replies,interested,aiFailures] = await Promise.all([prisma.lead.count({ where: { status: { in: ["new", "research_pending"] } } }), prisma.lead.count({ where: { status: "qualified" } }), prisma.lead.count({ where: { status: "ready_for_outreach" } }), prisma.lead.count({ where: { status: "contacted", followUpDate: { lte: now } } }), prisma.lead.count({ where: { replyStatus: { not: null } } }), prisma.lead.count({ where: { status: "interested" } }), prisma.aIJob.count({ where: { status: "failed" } })]); res.json({ newLeads, qualified, ready, followupsDue, replies, interested, aiFailures }); });

app.patch("/api/leads/:id/status", async (req, res) => { const id = Number(req.params["id"]); const parsed = StatusUpdateSchema.safeParse(req.body); if (!Number.isInteger(id) || !parsed.success) { res.status(400).json({ error: "Invalid id or status update", issues: parsed.success ? [] : parsed.error.issues }); return; } const data: Record<string, any> = { status: parsed.data.status }; if (parsed.data.followUpDate) data.followUpDate = new Date(parsed.data.followUpDate); if (["held","responded","replied","interested","call_scheduled","proposal_sent","won","lost","rejected","bounced","unsubscribed","closed_no_response"].includes(parsed.data.status)) data.followUpDate = null; try { const lead = await prisma.lead.update({ where: { id }, data }); await prisma.activity.create({ data: { leadId: id, type: "status_changed", summary: `Status changed to ${parsed.data.status}` } }); res.json(lead); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });
app.delete("/api/leads/:id", async (req, res) => { const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; } try { await prisma.lead.delete({ where: { id } }); res.json({ success: true, id }); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });
app.patch("/api/leads/:id/follow-up", async (req, res) => { const id = Number(req.params["id"]); const parsed = FollowUpSchema.safeParse(req.body); if (!Number.isInteger(id) || !parsed.success) { res.status(400).json({ error: "Invalid request", issues: parsed.success ? [] : parsed.error.issues }); return; } try { res.json(await prisma.lead.update({ where: { id }, data: { followUpDate: new Date(parsed.data.followUpDate) } })); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });
app.patch("/api/leads/:id/snooze", async (req, res) => { const id = Number(req.params["id"]); const parsed = SnoozeSchema.safeParse(req.body); if (!Number.isInteger(id) || !parsed.success) { res.status(400).json({ error: "Invalid request", issues: parsed.success ? [] : parsed.error.issues }); return; } try { res.json(await prisma.lead.update({ where: { id }, data: { followUpDate: new Date(Date.now() + parsed.data.days * 86400000) } })); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });
app.get("/api/leads/follow-up-summary", async (_req, res) => { const now = new Date(); const start = new Date(now); start.setHours(0,0,0,0); const end = new Date(now); end.setHours(23,59,59,999); const tomorrow = new Date(start); tomorrow.setDate(tomorrow.getDate()+1); const week = new Date(start); week.setDate(week.getDate()+7); week.setHours(23,59,59,999); const [overdue,dueToday,upcoming] = await Promise.all([prisma.lead.count({ where: { status: "contacted", followUpDate: { lt: start } } }), prisma.lead.count({ where: { status: "contacted", followUpDate: { gte: start, lte: end } } }), prisma.lead.count({ where: { status: "contacted", followUpDate: { gte: tomorrow, lte: week } } })]); res.json({ overdue, dueToday, upcoming }); });
app.post("/api/leads/batch-reject", async (req, res) => { const parsed = BatchRejectSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: "Invalid request", issues: parsed.error.issues }); return; } try { await prisma.$transaction(async (tx) => { for (const id of parsed.data.ids) { const lead = await tx.lead.findUnique({ where: { id }, select: { notes: true } }); const existing = Array.isArray(lead?.notes) ? lead.notes : []; await tx.lead.update({ where: { id }, data: { status: "rejected", followUpDate: null, notes: [...existing, { reason: parsed.data.reason, rejectedAt: new Date().toISOString() }] } }); await tx.activity.create({ data: { leadId: id, type: "disqualified", summary: `Rejected: ${parsed.data.reason}` } }); } }); res.json({ success: true, count: parsed.data.ids.length }); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });

registerResearchRoutes(app, prisma);
registerOutreachRoutes(app, prisma);
setInterval(cleanOldJobs, 10 * 60 * 1000);
const port = process.env["PORT"] ?? 3001;
const server = app.listen(port, () => console.log(`[Server] Listening on port ${port}`));
for (const signal of ["SIGINT","SIGTERM"] as const) process.on(signal, () => { server.close(() => prisma.$disconnect().finally(() => process.exit(0))); });
