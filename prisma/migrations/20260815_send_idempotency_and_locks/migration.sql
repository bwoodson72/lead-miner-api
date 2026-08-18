ALTER TABLE "outreach_messages"
ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT,
ADD COLUMN IF NOT EXISTS "send_attempted_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "send_error" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "outreach_messages_idempotency_key_key"
ON "outreach_messages"("idempotency_key");

CREATE INDEX IF NOT EXISTS "outreach_messages_status_send_attempted_at_idx"
ON "outreach_messages"("status", "send_attempted_at");

CREATE TABLE IF NOT EXISTS "automation_locks" (
  "name" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automation_locks_pkey" PRIMARY KEY ("name")
);

CREATE INDEX IF NOT EXISTS "automation_locks_expires_at_idx"
ON "automation_locks"("expires_at");
