import express from "express";
import cors from "cors";
import { stringify as csvStringify } from "csv-stringify/sync";
import { KeywordInputSchema } from "./lib/schemas.js";
import { runLeadSearchPipeline } from "./lib/pipeline.js";
import { getEnv } from "./lib/env.js";
import { DEFAULT_KEYWORDS } from "./config/keywords.js";
import { DEFAULT_THRESHOLDS } from "./config/thresholds.js";
import { createJob, getJob, updateJob, cleanOldJobs } from "./lib/jobs.js";
import { registerResearchRoutes } from "./lib/research-routes.js";
import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }) });
const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "http://localhost:3000").split(",").map((o) => o.trim());
const app = express();
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/run-lead-search", (req, res) => {
  const parsed = KeywordInputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.issues }); return; }
  const job = createJob();
  updateJob(job.id, { status: "running", progress: { stage: "starting", detail: "Initializing pipeline..." } });
  runLeadSearchPipeline(parsed.data, (stage, detail) => updateJob(job.id, { progress: { stage, detail } }))
    .then(({ leads, keywords, diagnostics }) => updateJob(job.id, { status: "complete", completedAt: Date.now(), leads, keywords, diagnostics: diagnostics as Record<string, unknown>, progress: { stage: "complete", detail: `Done — ${leads.length} leads found` } }))
    .catch((err) => updateJob(job.id, { status: "failed", completedAt: Date.now(), error: err instanceof Error ? err.message : String(err), progress: { stage: "failed", detail: "Pipeline failed" } }));
  res.status(202).json({ success: true, jobId: job.id });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params["id"] ?? "");
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

app.get("/api/cron", async (req, res) => {
  const env = getEnv();
  if (env.CRON_SECRET && req.headers["authorization"] !== `Bearer ${env.CRON_SECRET}`) { res.status(401).json({ success: false, error: "Unauthorized" }); return; }
  try {
    const input = KeywordInputSchema.parse({ keywords: DEFAULT_KEYWORDS.join("\n"), ...DEFAULT_THRESHOLDS, email: env.REPORT_EMAIL });
    const { leads, keywords, diagnostics } = await runLeadSearchPipeline(input);
    res.json({ success: true, leadsFound: leads.length, leads, keywords, diagnostics });
  } catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});

const VALID_STATUSES = ["new", "research_pending", "qualified", "disqualified", "ready_for_outreach", "contacted", "followup_due", "responded", "replied", "interested", "call_scheduled", "proposal_sent", "won", "lost", "rejected", "bounced", "unsubscribed"] as const;
const VALID_REJECT_REASONS = ["agency_managed", "national_chain", "not_a_business", "already_has_vendor", "bad_data", "parked_domain", "other"] as const;

app.get("/api/leads/export", async (req, res) => {
  const { status, hideRejected, hideAgency, hideChains, hasEmail, hasPhone, search } = req.query as Record<string, string | undefined>;
  const where: Record<string, any> = {};
  if (status) where.status = status;
  if (hideRejected === "true" && !status) where.status = { not: "rejected" };
  if (hideAgency === "true") where.isAgencyManaged = false;
  if (hideChains === "true") where.isNationalChain = false;
  if (hasEmail === "true") where.email = { not: null };
  if (hasPhone === "true") where.phone = { not: null };
  if (search) where.OR = [{ businessName: { contains: search, mode: "insensitive" } }, { domain: { contains: search, mode: "insensitive" } }];
  try {
    const leads = await prisma.lead.findMany({ where, orderBy: [{ priorityScore: "desc" }, { lcp: "desc" }] });
    const rows = leads.map((lead) => ({ "Business Name": lead.businessName ?? "", Domain: lead.domain, Website: lead.landingPageUrl, Phone: lead.phone ?? "", Email: lead.email ?? "", Address: lead.address ?? "", Keyword: lead.keyword, "PageSpeed Score": lead.lighthouseScore, "LCP (ms)": lead.lcp, "AI Priority": lead.priorityScore ?? "", "AI Decision": lead.qualificationDecision ?? "", "Outreach Angle": lead.primaryOutreachAngle ?? "", Status: lead.status, "Outreach Count": lead.outreachCount, "Last Outreach": lead.lastOutreachDate?.toISOString() ?? "", "Follow Up Date": lead.followUpDate?.toISOString() ?? "", "Agency Managed": lead.isAgencyManaged ? "Yes" : "No", "National Chain": lead.isNationalChain ? "Yes" : "No" }));
    res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"'); res.send(csvStringify(rows, { header: true }));
  } catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});

app.get("/api/leads", async (req, res) => {
  const { status, minLcp, isAgencyManaged, isNationalChain, hideRejected, followUpDue, qualificationDecision, minPriority, limit, offset } = req.query as Record<string, string | undefined>;
  const where: Record<string, any> = {};
  if (status) where.status = status;
  if (hideRejected === "true" && !status) where.status = { not: "rejected" };
  if (minLcp) where.lcp = { gte: parseInt(minLcp, 10) };
  if (qualificationDecision) where.qualificationDecision = qualificationDecision;
  if (minPriority) where.priorityScore = { gte: parseInt(minPriority, 10) };
  if (isAgencyManaged !== undefined) where.isAgencyManaged = isAgencyManaged === "true";
  if (isNationalChain !== undefined) where.isNationalChain = isNationalChain === "true";
  if (followUpDue === "true") { where.followUpDate = { lte: new Date() }; where.status = "contacted"; }
  try {
    const take = limit ? parseInt(limit, 10) : 50; const skip = offset ? parseInt(offset, 10) : 0;
    const [leads, total] = await Promise.all([prisma.lead.findMany({ where, orderBy: [{ priorityScore: "desc" }, { lcp: "desc" }], take, skip }), prisma.lead.count({ where })]);
    res.json({ leads, total });
  } catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});

app.get("/api/dashboard/summary", async (_req, res) => {
  const now = new Date();
  const [newLeads, qualified, ready, followupsDue, replies, interested, aiFailures] = await Promise.all([
    prisma.lead.count({ where: { status: { in: ["new", "research_pending"] } } }),
    prisma.lead.count({ where: { status: "qualified" } }),
    prisma.lead.count({ where: { status: "ready_for_outreach" } }),
    prisma.lead.count({ where: { status: "contacted", followUpDate: { lte: now } } }),
    prisma.lead.count({ where: { replyStatus: { not: null } } }),
    prisma.lead.count({ where: { status: "interested" } }),
    prisma.aIJob.count({ where: { status: "failed" } }),
  ]);
  res.json({ newLeads, qualified, ready, followupsDue, replies, interested, aiFailures });
});

app.patch("/api/leads/:id/status", async (req, res) => {
  const id = Number(req.params["id"]); const { status, followUpDate } = req.body as { status: unknown; followUpDate?: string };
  if (!Number.isInteger(id) || !VALID_STATUSES.includes(status as any)) { res.status(400).json({ error: "Invalid id or status" }); return; }
  const data: Record<string, any> = { status };
  if (status === "contacted") { data.outreachCount = { increment: 1 }; data.lastOutreachDate = new Date(); data.firstContactAt = (await prisma.lead.findUnique({ where: { id }, select: { firstContactAt: true } }))?.firstContactAt ?? new Date(); data.followUpDate = followUpDate ? new Date(followUpDate) : new Date(Date.now() + 4 * 86400000); }
  if (["responded", "replied", "interested", "call_scheduled", "proposal_sent", "won", "lost", "rejected", "bounced", "unsubscribed"].includes(String(status))) data.followUpDate = null;
  try { const lead = await prisma.lead.update({ where: { id }, data }); await prisma.activity.create({ data: { leadId: id, type: "status_changed", summary: `Status changed to ${String(status)}` } }); res.json(lead); }
  catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
});

app.delete("/api/leads/:id", async (req, res) => { const id = Number(req.params["id"]); if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; } try { await prisma.lead.delete({ where: { id } }); res.json({ success: true, id }); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });
app.patch("/api/leads/:id/follow-up", async (req, res) => { const id = Number(req.params["id"]); const { followUpDate } = req.body as { followUpDate?: string }; if (!Number.isInteger(id) || !followUpDate) { res.status(400).json({ error: "Invalid request" }); return; } try { res.json(await prisma.lead.update({ where: { id }, data: { followUpDate: new Date(followUpDate) } })); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });
app.patch("/api/leads/:id/snooze", async (req, res) => { const id = Number(req.params["id"]); const days = Number(req.body?.days ?? 3); if (!Number.isInteger(id) || !Number.isInteger(days) || days < 1 || days > 30) { res.status(400).json({ error: "Invalid request" }); return; } try { res.json(await prisma.lead.update({ where: { id }, data: { followUpDate: new Date(Date.now() + days * 86400000) } })); } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); } });

app.get("/api/leads/follow-up-summary", async (_req, res) => {
  const now = new Date(); const start = new Date(now); start.setHours(0,0,0,0); const end = new Date(now); end.setHours(23,59,59,999); const tomorrow = new Date(start); tomorrow.setDate(tomorrow.getDate()+1); const week = new Date(start); week.setDate(week.getDate()+7); week.setHours(23,59,59,999);
  const [overdue, dueToday, upcoming] = await Promise.all([prisma.lead.count({ where: { status: "contacted", followUpDate: { lt: start } } }), prisma.lead.count({ where: { status: "contacted", followUpDate: { gte: start, lte: end } } }), prisma.lead.count({ where: { status: "contacted", followUpDate: { gte: tomorrow, lte: week } } })]);
  res.json({ overdue, dueToday, upcoming });
});

app.post("/api/leads/batch-reject", async (req, res) => {
  const { ids, reason } = req.body as { ids: unknown; reason: unknown };
  if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "number") || !VALID_REJECT_REASONS.includes(reason as any)) { res.status(400).json({ error: "Invalid request" }); return; }
  try { await prisma.$transaction(async (tx) => { for (const id of ids as number[]) { const lead = await tx.lead.findUnique({ where: { id }, select: { notes: true } }); const existing = Array.isArray(lead?.notes) ? lead.notes : []; await tx.lead.update({ where: { id }, data: { status: "rejected", followUpDate: null, notes: [...existing, { reason: String(reason), rejectedAt: new Date().toISOString() }] } }); await tx.activity.create({ data: { leadId: id, type: "disqualified", summary: `Rejected: ${String(reason)}` } }); } }); res.json({ success: true, count: ids.length }); }
  catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
});

registerResearchRoutes(app, prisma);
setInterval(cleanOldJobs, 10 * 60 * 1000);
const port = process.env["PORT"] ?? 3001;
app.listen(port, () => console.log(`[Server] Listening on port ${port}`));
