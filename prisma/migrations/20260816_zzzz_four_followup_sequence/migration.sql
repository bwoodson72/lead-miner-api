ALTER TABLE "app_settings"
ALTER COLUMN "follow_up_delays_days" SET DEFAULT '[4,6,10,14]',
ALTER COLUMN "follow_up_instructions" SET DEFAULT 'Write concise natural continuations of the existing cold outreach thread using only stored research and prior messages. Never say just following up, checking in, circling back, touching base, or bumping this. Do not invent new problems, metrics, urgency, or familiarity. Follow-up 1 briefly reinforces the original problem. Follow-up 2 adds another evidence-supported perspective on the same opportunity. Follow-up 3 is a short low-pressure continuation. Follow-up 4 is the breakup: close the loop respectfully, do not introduce a new problem or pitch, do not guilt or pressure the prospect, do not manufacture urgency, and leave the door open if timing changes. Use one CTA on follow-ups 1-3 and no new subject line. The breakup should not ask for a meeting or create another follow-up obligation.';

UPDATE "app_settings"
SET "follow_up_delays_days" = '[4,6,10,14]'
WHERE "follow_up_delays_days" = '[4,6,10]'::jsonb;

UPDATE "app_settings"
SET "follow_up_instructions" = 'Write concise natural continuations of the existing cold outreach thread using only stored research and prior messages. Never say just following up, checking in, circling back, touching base, or bumping this. Do not invent new problems, metrics, urgency, or familiarity. Follow-up 1 briefly reinforces the original problem. Follow-up 2 adds another evidence-supported perspective on the same opportunity. Follow-up 3 is a short low-pressure continuation. Follow-up 4 is the breakup: close the loop respectfully, do not introduce a new problem or pitch, do not guilt or pressure the prospect, do not manufacture urgency, and leave the door open if timing changes. Use one CTA on follow-ups 1-3 and no new subject line. The breakup should not ask for a meeting or create another follow-up obligation.'
WHERE "follow_up_instructions" = 'Write a concise natural continuation of the existing cold outreach thread. Use only stored research and prior messages. Never say just following up, checking in, circling back, touching base, or bumping this. Do not invent new problems or metrics. Follow-up 1 reinforces the original problem briefly. Follow-up 2 adds another evidence-supported perspective on the same opportunity. Follow-up 3 is a brief low-pressure final message. Use one CTA and no new subject line.';

UPDATE "outreach_sequences"
SET "delays_days" = '[4,6,10,14]', "max_touches" = 5
WHERE "name" = 'Default outreach sequence';
