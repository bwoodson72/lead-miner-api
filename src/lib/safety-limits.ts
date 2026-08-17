function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Hard server-side ceilings. Research batch ceilings intentionally match the
 * Settings range so Research Batch Size is authoritative from 1-100. Other
 * environment values may tune behavior within their bounds.
 */
export const SAFETY_LIMITS = {
  aiResearchConcurrency: envInt("AI_RESEARCH_CONCURRENCY", 2, 1, 5),
  emailEnrichmentConcurrency: envInt("EMAIL_ENRICHMENT_CONCURRENCY", 3, 1, 6),
  bulkResearchMax: 100,
  bulkEnrichmentMax: envInt("BULK_ENRICHMENT_MAX", 50, 1, 100),
  automationReplySyncMax: envInt("AUTOMATION_REPLY_SYNC_MAX", 50, 1, 100),
  automationEnrichmentMax: envInt("AUTOMATION_ENRICHMENT_MAX", 10, 1, 25),
  automationResearchMax: 100,
  automationStaleSendMax: envInt("AUTOMATION_STALE_SEND_MAX", 10, 1, 25),
  automationFollowupMax: envInt("AUTOMATION_FOLLOWUP_MAX", 20, 1, 50),
  automationSendMax: envInt("AUTOMATION_SEND_MAX", 20, 1, 50),
  providerMaxRetries: envInt("PROVIDER_MAX_RETRIES", 2, 0, 4),
  providerBackoffBaseMs: envInt("PROVIDER_BACKOFF_BASE_MS", 1_000, 250, 10_000),
} as const;

export function capRequestedLimit(value: unknown, fallback: number, hardMax: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), hardMax);
}
