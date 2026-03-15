import express from "express";
import cors from "cors";
import { KeywordInputSchema } from "./lib/schemas.js";
import { runLeadSearchPipeline } from "./lib/pipeline.js";
import { getEnv } from "./lib/env.js";
import { DEFAULT_KEYWORDS } from "./config/keywords.js";
import { DEFAULT_THRESHOLDS } from "./config/thresholds.js";

const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

const app = express();

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/run-lead-search", async (req, res) => {
  const parsed = KeywordInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues });
    return;
  }

  const start = Date.now();
  console.log("[Server] POST /api/run-lead-search started");

  try {
    const { leads, keywords, diagnostics } = await runLeadSearchPipeline(parsed.data);
    const elapsedSeconds = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[Server] Pipeline complete — ${leads.length} leads, ${elapsedSeconds}s`);

    res.json({
      success: true,
      leadsFound: leads.length,
      leads,
      keywords,
      diagnostics,
      elapsedSeconds: Number(elapsedSeconds),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Server] /api/run-lead-search error:", err);
    res.status(500).json({ success: false, error: message });
  }
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
      maxDomains: 20,
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

const port = process.env["PORT"] ?? 3001;
app.listen(port, () => {
  console.log(`[Server] Listening on port ${port}`);
});
