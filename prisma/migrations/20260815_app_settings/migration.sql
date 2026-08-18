CREATE TABLE "app_settings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "auto_research" BOOLEAN NOT NULL DEFAULT true,
  "auto_draft_outreach" BOOLEAN NOT NULL DEFAULT true,
  "approval_mode" TEXT NOT NULL DEFAULT 'manual',
  "research_model" TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
  "outreach_model" TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
  "research_batch_size" INTEGER NOT NULL DEFAULT 10,
  "min_auto_approve_priority" INTEGER NOT NULL DEFAULT 75,
  "min_auto_approve_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
  "min_problem_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.70,
  "daily_send_limit" INTEGER NOT NULL DEFAULT 40,
  "send_window_start" TEXT NOT NULL DEFAULT '09:00',
  "send_window_end" TEXT NOT NULL DEFAULT '16:30',
  "follow_up_delays_days" JSONB NOT NULL DEFAULT '[4,6,10]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "app_settings" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
