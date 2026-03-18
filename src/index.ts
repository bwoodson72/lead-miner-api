import express from "express";
import cors from "cors";
import { KeywordInputSchema } from "./lib/schemas.js";
import { runLeadSearchPipeline } from "./lib/pipeline.js";
import { getEnv } from "./lib/env.js";
import { DEFAULT_KEYWORDS } from "./config/keywords.js";
import { DEFAULT_THRESHOLDS } from "./config/thresholds.js";
import { createJob, getJob, updateJob, cleanOldJobs } from "./lib/jobs.js";

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

setInterval(cleanOldJobs, 10 * 60 * 1000); // Clean up every 10 minutes

const port = process.env["PORT"] ?? 3001;
app.listen(port, () => {
  console.log(`[Server] Listening on port ${port}`);
});
