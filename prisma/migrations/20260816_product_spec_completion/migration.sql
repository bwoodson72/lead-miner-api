ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "priority_breakdown" JSONB,
  ADD COLUMN IF NOT EXISTS "primary_outreach_angle_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "primary_outreach_angle_confidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "primary_outreach_finding_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "outreach_prepared_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revisit_at" TIMESTAMP(3);

ALTER TABLE "outreach_messages"
  ADD COLUMN IF NOT EXISTS "cta" TEXT,
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "requires_review" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "generation_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "scheduled_at" TIMESTAMP(3);

ALTER TABLE "ai_jobs"
  ADD COLUMN IF NOT EXISTS "packet_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "cached_tokens" INTEGER;

ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "auto_enrich" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "auto_prioritize" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "auto_select_outreach_angle" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "auto_sync_replies" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "auto_process_followups" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "auto_send_approved" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "auto_generate_suggested_replies" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "min_priority_score" INTEGER NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS "priority_weights" JSONB NOT NULL DEFAULT '{"opportunityType":30,"findingStrength":25,"contactability":15,"businessMaturity":10,"acquisitionIntent":10,"evidenceQuality":10}'::jsonb,
  ADD COLUMN IF NOT EXISTS "daily_ai_spend_limit" DOUBLE PRECISION NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "monthly_ai_spend_limit" DOUBLE PRECISION NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "send_timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
  ADD COLUMN IF NOT EXISTS "weekend_sending_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reanalysis_age_days" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS "automation_runs" (
  "id" SERIAL NOT NULL,
  "job_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "processed" INTEGER NOT NULL DEFAULT 0,
  "succeeded" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "error_summary" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "leads_revisit_at_idx" ON "leads"("revisit_at");
CREATE INDEX IF NOT EXISTS "outreach_messages_status_scheduled_at_idx" ON "outreach_messages"("status", "scheduled_at");
CREATE INDEX IF NOT EXISTS "ai_jobs_lead_id_type_packet_hash_idx" ON "ai_jobs"("lead_id", "type", "packet_hash");
CREATE INDEX IF NOT EXISTS "automation_runs_job_name_started_at_idx" ON "automation_runs"("job_name", "started_at");
CREATE INDEX IF NOT EXISTS "automation_runs_status_started_at_idx" ON "automation_runs"("status", "started_at");
