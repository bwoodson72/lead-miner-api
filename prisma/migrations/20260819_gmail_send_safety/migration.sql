ALTER TABLE "app_settings"
  ADD COLUMN "gmail_rolling_24h_safety_limit" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "minimum_send_interval_minutes" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "gmail_quota_cooldown_hours" INTEGER NOT NULL DEFAULT 24;

CREATE TABLE "gmail_send_state" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "cooldown_until" TIMESTAMP(3),
  "cooldown_reason" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gmail_send_state_pkey" PRIMARY KEY ("id")
);

INSERT INTO "gmail_send_state" ("id") VALUES (1)
ON CONFLICT ("id") DO NOTHING;
