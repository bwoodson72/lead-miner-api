ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "outreach_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "outreach_notes_updated_at" TIMESTAMP(3);
