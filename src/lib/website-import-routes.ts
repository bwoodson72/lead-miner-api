import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { z, ZodError } from "zod";
import { DEFAULT_THRESHOLDS } from "../config/thresholds.js";
import { analyzeUrlsWithRateLimit } from "./pagespeed.js";
import { classifyPerformanceOpportunity } from "./site-screening.js";
import { normalizeUrl, extractRootDomain } from "./normalize-url.js";
import { normalizeDomainValue } from "./db.js";
import { isFranchise } from "./franchise-filter.js";
import { createJob, updateJob } from "./jobs.js";

export const IMPORT_ROW_LIMIT = 1000;
export const ImportSourceSchema = z.enum(["manual_url", "csv_import"]);
export type ImportSource = z.infer<typeof ImportSourceSchema>;

export const WebsiteImportRowSchema = z.object({
  website: z.string().min(1).max(2048),
  businessName: z.string().max(300).nullable().optional(),
  keyword: z.string().max(300).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  region: z.string().max(200).nullable().optional(),
  myNotes: z.string().max(5000).nullable().optional(),
});

const ImportRequestSchema = z.object({
  source: ImportSourceSchema,
  fileName: z.string().max(300).nullable().optional(),
  rows: z.array(WebsiteImportRowSchema).min(1).max(IMPORT_ROW_LIMIT),
});

export type WebsiteImportRow = z.infer<typeof WebsiteImportRowSchema>;
export type ImportPreviewStatus = "ready" | "existing" | "duplicate" | "invalid" | "franchise";
export type ImportPreviewRow = {
  rowNumber: number;
  website: string;
  normalizedUrl: string | null;
  domain: string | null;
  status: ImportPreviewStatus;
  reason: string | null;
  existingLeadId: number | null;
  data: WebsiteImportRow;
};

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function normalizeImportWebsite(raw: string) {
  const supplied = raw.trim();
  if (!supplied) throw new Error("Website is required");
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(supplied) ? supplied : `https://${supplied}`;
  const parsed = new URL(candidate);
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) throw new Error("Only http and https website URLs are supported");
  parsed.hash = "";
  const normalizedUrl = normalizeUrl(parsed.toString());
  const domain = normalizeDomainValue(extractRootDomain(normalizedUrl));
  if (!domain || !domain.includes(".")) throw new Error("Website must contain a valid domain");
  return { suppliedUrl: supplied, normalizedUrl, domain };
}

export function prepareImportRows(rows: WebsiteImportRow[]): ImportPreviewRow[] {
  const seen = new Map<string, number>();
  return rows.map((data, index) => {
    const rowNumber = index + 1;
    try {
      const normalized = normalizeImportWebsite(data.website);
      if (isFranchise(normalized.domain)) {
        return { rowNumber, website: data.website, normalizedUrl: normalized.normalizedUrl, domain: normalized.domain, status: "franchise" as const, reason: "Filtered by the existing franchise rule", existingLeadId: null, data };
      }
      const firstRow = seen.get(normalized.domain);
      if (firstRow !== undefined) {
        return { rowNumber, website: data.website, normalizedUrl: normalized.normalizedUrl, domain: normalized.domain, status: "duplicate" as const, reason: `Duplicate of row ${firstRow}`, existingLeadId: null, data };
      }
      seen.set(normalized.domain, rowNumber);
      return { rowNumber, website: data.website, normalizedUrl: normalized.normalizedUrl, domain: normalized.domain, status: "ready" as const, reason: null, existingLeadId: null, data };
    } catch (error) {
      return { rowNumber, website: data.website, normalizedUrl: null, domain: null, status: "invalid" as const, reason: error instanceof Error ? error.message : String(error), existingLeadId: null, data };
    }
  });
}

function previewSummary(rows: ImportPreviewRow[]) {
  return {
    total: rows.length,
    ready: rows.filter((row) => row.status === "ready").length,
    existing: rows.filter((row) => row.status === "existing").length,
    duplicate: rows.filter((row) => row.status === "duplicate").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    franchise: rows.filter((row) => row.status === "franchise").length,
  };
}

export async function previewWebsiteImport(prisma: PrismaClient, rows: WebsiteImportRow[]) {
  const preview = prepareImportRows(rows);
  const domains = preview.filter((row) => row.status === "ready" && row.domain).map((row) => row.domain!);
  if (domains.length) {
    const existing = await prisma.lead.findMany({
      where: { OR: [{ normalizedDomain: { in: domains } }, { domain: { in: domains } }] },
      select: { id: true, domain: true, normalizedDomain: true },
    });
    const byDomain = new Map(existing.map((lead) => [normalizeDomainValue(lead.normalizedDomain || lead.domain), lead.id]));
    for (const row of preview) {
      if (row.status !== "ready" || !row.domain) continue;
      const leadId = byDomain.get(row.domain);
      if (leadId !== undefined) {
        row.status = "existing";
        row.reason = "This domain is already in Lead Miner";
        row.existingLeadId = leadId;
      }
    }
  }
  return { rows: preview, summary: previewSummary(preview) };
}

async function createImportedLead(prisma: PrismaClient, batchId: number, source: ImportSource, row: ImportPreviewRow) {
  if (!row.domain || !row.normalizedUrl) return null;
  const existing = await prisma.lead.findFirst({
    where: { OR: [{ normalizedDomain: row.domain }, { domain: row.domain }] },
    select: { id: true },
  });
  if (existing) return { lead: null, existingLeadId: existing.id };

  const notes = clean(row.data.myNotes);
  const now = new Date();
  try {
    const lead = await prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          domain: row.domain!,
          normalizedDomain: row.domain!,
          businessName: clean(row.data.businessName),
          landingPageUrl: row.normalizedUrl!,
          keyword: clean(row.data.keyword) ?? "",
          city: clean(row.data.city),
          region: clean(row.data.region),
          adSource: "unknown",
          discoverySource: source,
          importBatchId: batchId,
          suppliedUrl: row.website.trim(),
          status: "research_pending",
          screeningStatus: "pending",
          performanceOpportunity: "unknown",
          emailEnrichmentStatus: "pending",
          emailEnrichmentReason: "candidate_discovered",
          outreachNotes: notes,
          outreachNotesUpdatedAt: notes ? now : null,
        },
      });
      await tx.activity.create({
        data: {
          leadId: created.id,
          type: "candidate_imported",
          summary: source === "manual_url" ? "Candidate added by URL" : "Candidate imported from CSV",
          metadata: { importBatchId: batchId, discoverySource: source, suppliedUrl: row.website.trim(), suppliedMetadata: { businessName: Boolean(clean(row.data.businessName)), keyword: Boolean(clean(row.data.keyword)), city: Boolean(clean(row.data.city)), region: Boolean(clean(row.data.region)), myNotes: Boolean(notes) } },
        },
      });
      return created;
    });
    return { lead, existingLeadId: null };
  } catch (error) {
    const raced = await prisma.lead.findFirst({ where: { OR: [{ normalizedDomain: row.domain }, { domain: row.domain }] }, select: { id: true } });
    if (raced) return { lead: null, existingLeadId: raced.id };
    throw error;
  }
}

async function processImportBatch(prisma: PrismaClient, batchId: number, source: ImportSource, preview: Awaited<ReturnType<typeof previewWebsiteImport>>, jobId: string) {
  const ready = preview.rows.filter((row) => row.status === "ready");
  const created: Array<{ id: number; domain: string; url: string; keyword: string }> = [];
  let raceExisting = 0;
  updateJob(jobId, { progress: { stage: "persisting", detail: `Saving ${ready.length} imported candidates...` } });

  try {
    for (const row of ready) {
      const result = await createImportedLead(prisma, batchId, source, row);
      if (result?.lead) created.push({ id: result.lead.id, domain: result.lead.domain, url: result.lead.landingPageUrl, keyword: result.lead.keyword });
      else if (result?.existingLeadId) raceExisting++;
    }

    await prisma.importBatch.update({ where: { id: batchId }, data: { createdLeads: created.length, existingRows: preview.summary.existing + raceExisting } });

    updateJob(jobId, { progress: { stage: "analyzing", detail: created.length ? `0 of ${created.length} imported candidates analyzed` : "No new candidates required screening" } });
    const pageSpeedMap = created.length
      ? await analyzeUrlsWithRateLimit(created, created.length, 3, (completed, total) => updateJob(jobId, { progress: { stage: "analyzing", detail: `${completed} of ${total} imported candidates analyzed` } }))
      : new Map();

    let screeningFailures = 0;
    for (const item of created) {
      const pageSpeed = pageSpeedMap.get(item.domain) ?? null;
      if (!pageSpeed) screeningFailures++;
      await prisma.lead.update({
        where: { id: item.id },
        data: {
          lighthouseScore: pageSpeed?.performanceScore ?? null,
          lcp: pageSpeed ? Math.round(pageSpeed.lcp) : null,
          cls: pageSpeed?.cls ?? null,
          tbt: pageSpeed ? Math.round(pageSpeed.tbt) : null,
          screeningStatus: pageSpeed ? "complete" : "partial",
          performanceOpportunity: classifyPerformanceOpportunity(pageSpeed, DEFAULT_THRESHOLDS),
          lastScreenedAt: new Date(),
        },
      });
    }

    const completed = await prisma.importBatch.update({
      where: { id: batchId },
      data: { status: "complete", screenedLeads: created.length, screeningFailures, completedAt: new Date() },
    });
    updateJob(jobId, {
      status: "complete",
      completedAt: Date.now(),
      diagnostics: { batchId, created: created.length, existing: completed.existingRows, duplicate: completed.duplicateRows, invalid: completed.invalidRows, franchise: completed.franchiseRows, screeningFailures, researchQueued: created.length },
      progress: { stage: "complete", detail: `Done — ${created.length} candidates added; ${created.length} entered the research queue` },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.importBatch.update({ where: { id: batchId }, data: { status: "failed", completedAt: new Date() } }).catch(() => undefined);
    updateJob(jobId, { status: "failed", completedAt: Date.now(), error: message, progress: { stage: "failed", detail: "Website import failed" } });
  }
}

function invalid(res: any, error: ZodError) {
  res.status(400).json({ error: "Invalid import request", issues: error.issues });
}

export function registerWebsiteImportRoutes(app: Express, prisma: PrismaClient) {
  app.post("/api/imports/preview", async (req, res) => {
    let parsed: z.infer<typeof ImportRequestSchema>;
    try { parsed = ImportRequestSchema.parse(req.body); } catch (error) { if (error instanceof ZodError) { invalid(res, error); return; } throw error; }
    try { res.json(await previewWebsiteImport(prisma, parsed.rows)); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/imports", async (req, res) => {
    let parsed: z.infer<typeof ImportRequestSchema>;
    try { parsed = ImportRequestSchema.parse(req.body); } catch (error) { if (error instanceof ZodError) { invalid(res, error); return; } throw error; }
    try {
      const preview = await previewWebsiteImport(prisma, parsed.rows);
      const batch = await prisma.importBatch.create({
        data: {
          source: parsed.source,
          fileName: clean(parsed.fileName),
          status: preview.summary.ready ? "running" : "complete",
          totalRows: preview.summary.total,
          readyRows: preview.summary.ready,
          existingRows: preview.summary.existing,
          duplicateRows: preview.summary.duplicate,
          invalidRows: preview.summary.invalid,
          franchiseRows: preview.summary.franchise,
          completedAt: preview.summary.ready ? null : new Date(),
        },
      });
      if (!preview.summary.ready) {
        res.json({ success: true, jobId: null, batchId: batch.id, preview, message: "No new candidates to import" });
        return;
      }
      const job = createJob();
      updateJob(job.id, { status: "running", progress: { stage: "starting", detail: "Initializing website import..." } });
      void processImportBatch(prisma, batch.id, parsed.source, preview, job.id);
      res.status(202).json({ success: true, jobId: job.id, batchId: batch.id, preview });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/imports", async (req, res) => {
    const requested = Number(req.query["limit"] ?? 10);
    const limit = Math.min(50, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 10));
    try {
      const batches = await prisma.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: limit });
      const ids = batches.map((batch) => batch.id);
      const leads = ids.length ? await prisma.lead.findMany({ where: { importBatchId: { in: ids } }, select: { importBatchId: true, lastResearchedAt: true, qualificationDecision: true, email: true, status: true } }) : [];
      const metrics = new Map<number, { total: number; researched: number; rebuildCandidates: number; hasEmail: number; outreachReady: number }>();
      for (const lead of leads) {
        if (!lead.importBatchId) continue;
        const row = metrics.get(lead.importBatchId) ?? { total: 0, researched: 0, rebuildCandidates: 0, hasEmail: 0, outreachReady: 0 };
        row.total++;
        if (lead.lastResearchedAt) row.researched++;
        if (lead.qualificationDecision === "rebuild_candidate") row.rebuildCandidates++;
        if (lead.email) row.hasEmail++;
        if (["ready_for_outreach", "contacted", "replied", "interested", "call_scheduled", "proposal_sent", "won"].includes(lead.status)) row.outreachReady++;
        metrics.set(lead.importBatchId, row);
      }
      res.json({ batches: batches.map((batch) => ({ ...batch, pipeline: metrics.get(batch.id) ?? { total: 0, researched: 0, rebuildCandidates: 0, hasEmail: 0, outreachReady: 0 } })) });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
