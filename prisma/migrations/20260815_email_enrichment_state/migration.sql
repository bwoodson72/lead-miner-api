ALTER TABLE "leads"
  ADD COLUMN "email_enrichment_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "email_enrichment_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_email_enrichment_at" TIMESTAMP(3),
  ADD COLUMN "next_email_enrichment_at" TIMESTAMP(3),
  ADD COLUMN "email_enrichment_reason" TEXT;

UPDATE "leads"
SET "email_enrichment_status" = 'found',
    "email_enrichment_reason" = 'email_present'
WHERE "email" IS NOT NULL;

CREATE INDEX "leads_email_enrichment_status_next_email_enrichment_at_idx"
  ON "leads"("email_enrichment_status", "next_email_enrichment_at");
