ALTER TABLE "leads"
ADD COLUMN IF NOT EXISTS "normalized_domain" TEXT,
ADD COLUMN IF NOT EXISTS "category" TEXT,
ADD COLUMN IF NOT EXISTS "city" TEXT,
ADD COLUMN IF NOT EXISTS "region" TEXT;

WITH normalized AS (
  SELECT id,
    lower(regexp_replace(regexp_replace(domain, '^www\.', '', 'i'), '\.$', '')) AS value,
    count(*) OVER (PARTITION BY lower(regexp_replace(regexp_replace(domain, '^www\.', '', 'i'), '\.$', ''))) AS cnt
  FROM "leads"
)
UPDATE "leads" l
SET "normalized_domain" = n.value
FROM normalized n
WHERE l.id = n.id AND n.cnt = 1 AND l."normalized_domain" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "leads_normalized_domain_key" ON "leads"("normalized_domain");
CREATE INDEX IF NOT EXISTS "leads_status_priority_score_idx" ON "leads"("status", "priority_score");

CREATE TABLE IF NOT EXISTS "contacts" (
  "id" SERIAL PRIMARY KEY,
  "lead_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "role" TEXT,
  "source" TEXT,
  "verification_status" TEXT,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contacts_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_lead_id_type_value_key" ON "contacts"("lead_id", "type", "value");
CREATE INDEX IF NOT EXISTS "contacts_type_value_idx" ON "contacts"("type", "value");
CREATE INDEX IF NOT EXISTS "contacts_lead_id_is_primary_idx" ON "contacts"("lead_id", "is_primary");

INSERT INTO "contacts" ("lead_id", "type", "value", "source", "is_primary", "updated_at")
SELECT id, 'email', lower(email), 'legacy_lead_field', true, CURRENT_TIMESTAMP FROM "leads" WHERE email IS NOT NULL AND btrim(email) <> ''
ON CONFLICT ("lead_id", "type", "value") DO NOTHING;
INSERT INTO "contacts" ("lead_id", "type", "value", "source", "is_primary", "updated_at")
SELECT id, 'phone', phone, 'legacy_lead_field', true, CURRENT_TIMESTAMP FROM "leads" WHERE phone IS NOT NULL AND btrim(phone) <> ''
ON CONFLICT ("lead_id", "type", "value") DO NOTHING;

CREATE TABLE IF NOT EXISTS "outreach_sequences" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "delays_days" JSONB NOT NULL,
  "max_touches" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "outreach_sequences_is_active_idx" ON "outreach_sequences"("is_active");
INSERT INTO "outreach_sequences" ("name", "delays_days", "max_touches", "is_active", "updated_at")
SELECT 'Default outreach sequence', "follow_up_delays_days", jsonb_array_length("follow_up_delays_days") + 1, true, CURRENT_TIMESTAMP
FROM "app_settings" WHERE id = 1
ON CONFLICT ("name") DO UPDATE SET "delays_days" = EXCLUDED."delays_days", "max_touches" = EXCLUDED."max_touches", "is_active" = true, "updated_at" = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "email_threads" (
  "id" SERIAL PRIMARY KEY,
  "lead_id" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_thread_id" TEXT NOT NULL UNIQUE,
  "recipient_email" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "last_outbound_at" TIMESTAMP(3),
  "last_inbound_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_threads_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "email_threads_lead_id_provider_idx" ON "email_threads"("lead_id", "provider");
CREATE INDEX IF NOT EXISTS "email_threads_status_last_inbound_at_idx" ON "email_threads"("status", "last_inbound_at");

INSERT INTO "email_threads" ("lead_id", "provider", "provider_thread_id", "recipient_email", "last_outbound_at", "updated_at")
SELECT DISTINCT ON (m."provider_thread_id") m."lead_id", 'gmail', m."provider_thread_id", l.email, m."sent_at", CURRENT_TIMESTAMP
FROM "outreach_messages" m
JOIN "leads" l ON l.id = m."lead_id"
WHERE m."provider_thread_id" IS NOT NULL
ORDER BY m."provider_thread_id", m."sent_at" DESC NULLS LAST
ON CONFLICT ("provider_thread_id") DO NOTHING;
