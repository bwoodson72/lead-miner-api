import express from "express";
import cors from "cors";
import { KeywordInputSchema } from "./lib/schemas.js";
import { runLeadSearchPipeline } from "./lib/pipeline.js";
import { getEnv } from "./lib/env.js";
import { DEFAULT_KEYWORDS } from "./config/keywords.js";
import { DEFAULT_THRESHOLDS } from "./config/thresholds.js";
import { createJob, getJob, updateJob, cleanOldJobs } from "./lib/jobs.js";
import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"]! }),
});

const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

const app = express();

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/run-lead-search", (req, res) => {
  const parsed = KeywordInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues });
    return;
  }

  const job = createJob();
  updateJob(job.id, { status: "running", progress: { stage: "starting", detail: "Initializing pipeline..." } });
  console.log(`[Server] POST /api/run-lead-search — job ${job.id} started`);

  // Fire and forget — do not await
  runLeadSearchPipeline(parsed.data, (stage, detail) => {
    updateJob(job.id, { progress: { stage, detail } });
  })
    .then(({ leads, keywords, diagnostics }) => {
      updateJob(job.id, {
        status: "complete",
        completedAt: Date.now(),
        leads,
        keywords,
        diagnostics: diagnostics as Record<string, unknown>,
        progress: { stage: "complete", detail: "Done — " + leads.length + " leads found" },
      });
      console.log(`[Server] Job ${job.id} complete — ${leads.length} leads`);
    })
    .catch((err) => {
      updateJob(job.id, {
        status: "failed",
        completedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        progress: { stage: "failed", detail: "Pipeline failed" },
      });
      console.error(`[Server] Job ${job.id} failed:`, err);
    });

  res.status(202).json({ success: true, jobId: job.id });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params["id"] ?? "");
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

app.get("/api/cron", async (req, res) => {
  const env = getEnv();

  if (env.CRON_SECRET) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }
  }

  try {
    const input = KeywordInputSchema.parse({
      keywords: DEFAULT_KEYWORDS.join("\n"),
      ...DEFAULT_THRESHOLDS,
      email: env.REPORT_EMAIL,
    });

    const { leads, keywords, diagnostics } = await runLeadSearchPipeline(input);

    res.json({ success: true, leadsFound: leads.length, leads, keywords, diagnostics });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Server] /api/cron error:", err);
    res.status(500).json({ success: false, error: message });
  }
});

const VALID_STATUSES = [
  "new", "contacted", "responded", "call_scheduled",
  "proposal_sent", "won", "lost", "rejected",
] as const;

const VALID_REJECT_REASONS = [
  "agency_managed",
  "national_chain",
  "not_a_business",
  "already_has_vendor",
  "bad_data",
  "parked_domain",
  "other",
] as const;

app.get("/api/leads", async (req, res) => {
  const { status, minLcp, isAgencyManaged, isNationalChain, hideRejected, followUpDue, limit, offset } = req.query as Record<string, string | undefined>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};

  if (status) where["status"] = status;
  if (hideRejected === "true" && !status) where["status"] = { not: "rejected" };
  if (minLcp) where["lcp"] = { gte: parseInt(minLcp, 10) };
  if (isAgencyManaged !== undefined) where["isAgencyManaged"] = isAgencyManaged === "true";
  if (isNationalChain !== undefined) where["isNationalChain"] = isNationalChain === "true";
  if (followUpDue === "true") {
    where["followUpDate"] = { lte: new Date() };
    where["status"] = "contacted";
  }

  const take = limit ? parseInt(limit, 10) : 50;
  const skip = offset ? parseInt(offset, 10) : 0;

  try {
    const [leads, total] = await Promise.all([
      prisma.lead.findMany({ where, orderBy: { lcp: "desc" }, take, skip }),
      prisma.lead.count({ where }),
    ]);
    res.json({ leads, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Server] GET /api/leads error:", err);
    res.status(500).json({ success: false, error: message });
  }
});

app.patch("/api/leads/:id/status", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: "Invalid id" }); return; }

  const { status, followUpDate } = req.body as { status: unknown; followUpDate?: string };
  if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
    res.status(400).json({ success: false, error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = { status };

  if (status === "contacted") {
    data["outreachCount"] = { increment: 1 };
    data["lastOutreachDate"] = new Date();
    data["followUpDate"] = followUpDate ? new Date(followUpDate) : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  } else if (status === "responded" || status === "call_scheduled" || status === "rejected") {
    data["followUpDate"] = null;
  } else if (followUpDate) {
    data["followUpDate"] = new Date(followUpDate);
  }

  try {
    const lead = await prisma.lead.update({ where: { id }, data });
    res.json(lead);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Record to update not found")) { res.status(404).json({ success: false, error: "Lead not found" }); return; }
    console.error("[Server] PATCH /api/leads/:id/status error:", err);
    res.status(500).json({ success: false, error: message });
  }
});

app.delete("/api/leads/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: "Invalid id" }); return; }

  try {
    await prisma.lead.delete({ where: { id } });
    res.json({ success: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Record to delete does not exist")) { res.status(404).json({ success: false, error: "Lead not found" }); return; }
    console.error("[Server] DELETE /api/leads/:id error:", err);
    res.status(500).json({ success: false, error: message });
  }
});

app.patch("/api/leads/:id/follow-up", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: "Invalid id" }); return; }

  const { followUpDate } = req.body as { followUpDate?: string };
  if (!followUpDate) { res.status(400).json({ success: false, error: "followUpDate is required" }); return; }

  try {
    const lead = await prisma.lead.update({ where: { id }, data: { followUpDate: new Date(followUpDate) } });
    res.json(lead);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Record to update not found")) { res.status(404).json({ success: false, error: "Lead not found" }); return; }
    console.error("[Server] PATCH /api/leads/:id/follow-up error:", err);
    res.status(500).json({ success: false, error: message });
  }
});

app.patch("/api/leads/:id/snooze", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: "Invalid id" }); return; }

  const rawDays = (req.body as { days?: unknown }).days;
  const days = rawDays !== undefined ? Number(rawDays) : 3;
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    res.status(400).json({ success: false, error: "days must be an integer between 1 and 30" });
    return;
  }

  const followUpDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  try {
    const lead = await prisma.lead.update({ where: { id }, data: { followUpDate } });
    res.json(lead);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Record to update not found")) { res.status(404).json({ success: false, error: "Lead not found" }); return; }
    console.error("[Server] PATCH /api/leads/:id/snooze error:", err);
    res.status(500).json({ success: false, error: message });
  }
});

app.get("/api/leads/follow-up-summary", async (_req, res) => {
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  const endOfIn7Days = new Date(startOfToday);
  endOfIn7Days.setDate(endOfIn7Days.getDate() + 7);
  endOfIn7Days.setHours(23, 59, 59, 999);

  try {
    const [overdue, dueToday, upcoming] = await Promise.all([
      prisma.lead.count({ where: { status: "contacted", followUpDate: { lt: startOfToday } } }),
      prisma.lead.count({ where: { status: "contacted", followUpDate: { gte: startOfToday, lte: endOfToday } } }),
      prisma.lead.count({ where: { status: "contacted", followUpDate: { gte: startOfTomorrow, lte: endOfIn7Days } } }),
    ]);
    res.json({ overdue, dueToday, upcoming });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Server] GET /api/leads/follow-up-summary error:", err);
    res.status(500).json({ success: false, error: message });
  }
});

app.post("/api/leads/batch-reject", async (req, res) => {
  const { ids, reason } = req.body as { ids: unknown; reason: unknown };

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "number")) {
    res.status(400).json({ success: false, error: "ids must be a non-empty array of numbers" });
    return;
  }
  if (!VALID_REJECT_REASONS.includes(reason as (typeof VALID_REJECT_REASONS)[number])) {
    res.status(400).json({ success: false, error: `reason must be one of: ${VALID_REJECT_REASONS.join(", ")}` });
    return;
  }

  try {
    const note = { reason: reason as string, rejectedAt: new Date().toISOString() };

    await prisma.$transaction(async (tx) => {
      for (const id of ids as number[]) {
        const lead = await tx.lead.findUnique({ where: { id }, select: { notes: true } });
        const existingNotes = Array.isArray(lead?.notes) ? lead.notes : [];
        await tx.lead.update({
          where: { id },
          data: { status: "rejected", followUpDate: null, notes: [...existingNotes, note] },
        });
      }
    });

    res.json({ success: true, count: ids.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Server] /api/leads/batch-reject error:", err);
    res.status(500).json({ success: false, error: message });
  }
});

setInterval(cleanOldJobs, 10 * 60 * 1000); // Clean up every 10 minutes

const port = process.env["PORT"] ?? 3001;
app.listen(port, () => {
  console.log(`[Server] Listening on port ${port}`);
});
