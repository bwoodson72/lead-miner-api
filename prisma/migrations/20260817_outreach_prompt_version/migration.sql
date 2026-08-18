ALTER TABLE "outreach_messages"
ADD COLUMN "prompt_version" TEXT;

CREATE INDEX "outreach_messages_kind_status_prompt_version_idx"
ON "outreach_messages"("kind", "status", "prompt_version");
