ALTER TABLE "app_settings"
ADD COLUMN IF NOT EXISTS "email_provider" TEXT NOT NULL DEFAULT 'resend',
ADD COLUMN IF NOT EXISTS "follow_up_instructions" TEXT NOT NULL DEFAULT 'Write a concise natural continuation of the existing cold outreach thread. Use only stored research and prior messages. Never say just following up, checking in, circling back, touching base, or bumping this. Do not invent new problems or metrics. Follow-up 1 reinforces the original problem briefly. Follow-up 2 adds another evidence-supported perspective on the same opportunity. Follow-up 3 is a brief low-pressure final message. Use one CTA and no new subject line.',
ADD COLUMN IF NOT EXISTS "reply_instructions" TEXT NOT NULL DEFAULT 'Classify the prospect reply by intent using only the message content and thread context. Distinguish interested, question, objection, not_now, not_interested, wrong_person, referral, out_of_office, bounce, unsubscribe, booking_intent, and other. Summarize what the prospect wants and recommend the next human action. Do not draft or send a reply.';

CREATE INDEX IF NOT EXISTS "outreach_messages_provider_thread_id_idx" ON "outreach_messages"("provider_thread_id");
