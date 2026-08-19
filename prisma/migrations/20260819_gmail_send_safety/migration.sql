CREATE TABLE "gmail_send_policy" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "rolling_24h_safety_limit" INTEGER NOT NULL DEFAULT 100,
  "minimum_send_interval_minutes" INTEGER NOT NULL DEFAULT 10,
  "quota_cooldown_hours" INTEGER NOT NULL DEFAULT 24,
  "cooldown_until" TIMESTAMP(3),
  "cooldown_reason" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gmail_send_policy_pkey" PRIMARY KEY ("id")
);

INSERT INTO "gmail_send_policy" (
  "id",
  "rolling_24h_safety_limit",
  "minimum_send_interval_minutes",
  "quota_cooldown_hours"
) VALUES (1, 100, 10, 24)
ON CONFLICT ("id") DO NOTHING;
