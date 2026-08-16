ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "asset_strength" TEXT,
  ADD COLUMN IF NOT EXISTS "asset_assessment" JSONB;

CREATE TABLE IF NOT EXISTS "lead_asset_assessments" (
  "id" SERIAL PRIMARY KEY,
  "lead_id" INTEGER NOT NULL,
  "decision" TEXT NOT NULL,
  "asset_strength" TEXT NOT NULL,
  "dimensions" JSONB NOT NULL,
  "performance_assessment" JSONB NOT NULL,
  "site_coverage" JSONB NOT NULL,
  "research_summary" TEXT NOT NULL,
  "decision_reason" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "model" TEXT NOT NULL,
  "research_version" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_asset_assessments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "lead_asset_assessments_lead_id_created_at_idx" ON "lead_asset_assessments"("lead_id", "created_at");
CREATE INDEX IF NOT EXISTS "lead_asset_assessments_decision_created_at_idx" ON "lead_asset_assessments"("decision", "created_at");

CREATE TABLE IF NOT EXISTS "lead_findings" (
  "id" SERIAL PRIMARY KEY,
  "assessment_id" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "asset_capability" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "significance" TEXT NOT NULL,
  "evidence_sources" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_findings_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "lead_asset_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "lead_findings_assessment_id_idx" ON "lead_findings"("assessment_id");
CREATE INDEX IF NOT EXISTS "lead_findings_category_significance_idx" ON "lead_findings"("category", "significance");

UPDATE "app_settings"
SET "research_instructions" = 'Evaluate the supplied website as an observable business asset for the business it represents. Assess performance effectiveness, demand alignment, business representation, customer-action capability, acquisition readiness, and site maturity. Determine whether the evidence supports a rebuild candidate, optimization candidate, no material opportunity, or needs review. Do not manufacture deficiencies or choose an outreach angle.'
WHERE "research_instructions" = 'Evaluate this business as a potential client for custom web development. Use only supplied evidence. Identify concrete business-impact problems, qualify conservatively, and choose one strong evidence-backed outreach angle. Technical performance data may support analysis but should not by itself qualify a lead.';
