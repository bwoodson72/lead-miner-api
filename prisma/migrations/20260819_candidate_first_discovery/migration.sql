ALTER TABLE "leads"
  ALTER COLUMN "lighthouse_score" DROP NOT NULL,
  ALTER COLUMN "lcp" DROP NOT NULL,
  ADD COLUMN "screening_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "performance_opportunity" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "last_screened_at" TIMESTAMP(3);

UPDATE "leads"
SET
  "screening_status" = CASE
    WHEN "lighthouse_score" IS NULL OR "lcp" IS NULL THEN 'partial'
    ELSE 'complete'
  END,
  "performance_opportunity" = CASE
    WHEN "lighthouse_score" IS NULL OR "lcp" IS NULL THEN 'unknown'
    WHEN "lcp" > 4000
      AND (
        "lighthouse_score" < 60
        OR COALESCE("cls", 0) > 0.25
        OR COALESCE("tbt", 0) > 300
      ) THEN 'strong'
    WHEN "lcp" > 4000
      OR "lighthouse_score" < 60
      OR COALESCE("cls", 0) > 0.25
      OR COALESCE("tbt", 0) > 300 THEN 'moderate'
    ELSE 'none'
  END;

CREATE INDEX "leads_screening_status_idx" ON "leads"("screening_status");
CREATE INDEX "leads_performance_opportunity_idx" ON "leads"("performance_opportunity");
