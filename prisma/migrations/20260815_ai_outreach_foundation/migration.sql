ALTER TABLE "leads"
  ADD COLUMN "qualification_decision" TEXT,
  ADD COLUMN "qualification_reason" TEXT,
  ADD COLUMN "priority_score" INTEGER,
  ADD COLUMN "primary_outreach_angle" TEXT,
  ADD COLUMN "research_summary" TEXT,
  ADD COLUMN "research_version" TEXT,
  ADD COLUMN "last_researched_at" TIMESTAMP(3),
  ADD COLUMN "reply_status" TEXT,
  ADD COLUMN "reply_summary" TEXT,
  ADD COLUMN "last_reply_at" TIMESTAMP(3),
  ADD COLUMN "first_contact_at" TIMESTAMP(3);

CREATE TABLE "lead_problems" (
  "id" SERIAL NOT NULL,
  "lead_id" INTEGER NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "business_consequence" TEXT NOT NULL,
  "recommended_improvement" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL,
  "outreach_value" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_problems_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "lead_scores" (
  "id" SERIAL NOT NULL,
  "lead_id" INTEGER NOT NULL,
  "business_fit" INTEGER NOT NULL,
  "website_need" INTEGER NOT NULL,
  "ability_to_pay" INTEGER NOT NULL,
  "contactability" INTEGER NOT NULL,
  "urgency" INTEGER NOT NULL,
  "sales_opportunity" INTEGER NOT NULL,
  "composite_score" INTEGER NOT NULL,
  "model" TEXT NOT NULL,
  "research_version" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_scores_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "activities" (
  "id" SERIAL NOT NULL,
  "lead_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "outreach_messages" (
  "id" SERIAL NOT NULL,
  "lead_id" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "sequence_number" INTEGER NOT NULL DEFAULT 1,
  "subject" TEXT NOT NULL,
  "body_text" TEXT NOT NULL,
  "angle" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "provider_message_id" TEXT,
  "provider_thread_id" TEXT,
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  CONSTRAINT "outreach_messages_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "suppressions" (
  "id" SERIAL NOT NULL,
  "lead_id" INTEGER,
  "value" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ai_jobs" (
  "id" SERIAL NOT NULL,
  "lead_id" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "model" TEXT NOT NULL,
  "prompt_version" TEXT NOT NULL,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "estimated_cost" DOUBLE PRECISION,
  "error" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outreach_messages_provider_message_id_key" ON "outreach_messages"("provider_message_id");
CREATE UNIQUE INDEX "suppressions_type_value_key" ON "suppressions"("type", "value");
CREATE INDEX "leads_qualification_decision_priority_score_idx" ON "leads"("qualification_decision", "priority_score");
CREATE INDEX "leads_follow_up_date_status_idx" ON "leads"("follow_up_date", "status");
CREATE INDEX "leads_reply_status_last_reply_at_idx" ON "leads"("reply_status", "last_reply_at");
CREATE INDEX "lead_problems_lead_id_idx" ON "lead_problems"("lead_id");
CREATE INDEX "lead_scores_lead_id_created_at_idx" ON "lead_scores"("lead_id", "created_at");
CREATE INDEX "activities_lead_id_created_at_idx" ON "activities"("lead_id", "created_at");
CREATE INDEX "outreach_messages_lead_id_sent_at_idx" ON "outreach_messages"("lead_id", "sent_at");
CREATE INDEX "outreach_messages_status_idx" ON "outreach_messages"("status");
CREATE INDEX "suppressions_lead_id_idx" ON "suppressions"("lead_id");
CREATE INDEX "ai_jobs_lead_id_created_at_idx" ON "ai_jobs"("lead_id", "created_at");
CREATE INDEX "ai_jobs_status_idx" ON "ai_jobs"("status");

ALTER TABLE "lead_problems" ADD CONSTRAINT "lead_problems_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
