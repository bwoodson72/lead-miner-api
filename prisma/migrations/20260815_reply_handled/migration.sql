ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "reply_handled_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "leads_reply_handled_at_idx" ON "leads"("reply_handled_at");
