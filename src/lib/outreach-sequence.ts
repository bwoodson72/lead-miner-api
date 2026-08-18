export const FOLLOW_UP_COUNT = 4;
export const TOTAL_OUTREACH_TOUCHES = FOLLOW_UP_COUNT + 1;
export const BREAKUP_FOLLOW_UP_NUMBER = 4;
export const BREAKUP_SEQUENCE_NUMBER = BREAKUP_FOLLOW_UP_NUMBER + 1;
export const DEFAULT_FOLLOW_UP_DELAYS_DAYS = [4, 6, 10, 14] as const;

export const LEGACY_FOLLOW_UP_INSTRUCTIONS = "Write a concise natural continuation of the existing cold outreach thread. Use only stored research and prior messages. Never say just following up, checking in, circling back, touching base, or bumping this. Do not invent new problems or metrics. Follow-up 1 reinforces the original problem briefly. Follow-up 2 adds another evidence-supported perspective on the same opportunity. Follow-up 3 is a brief low-pressure final message. Use one CTA and no new subject line.";

export const DEFAULT_FOLLOW_UP_INSTRUCTIONS = "Write concise, natural continuations of the existing cold outreach thread using only stored research and prior messages. Never say just following up, checking in, circling back, touching base, or bumping this. Do not invent new problems, metrics, urgency, familiarity, customer behavior, or business outcomes. Keep implementation details out of prospect-facing copy; position Brian simply as someone who builds custom websites for service businesses. Follow-up 1 deepens the original observation with one practical owner-level reason it matters. Follow-up 2 reframes the same underlying issue through competitive choice or possible loss using a believable conditional buyer moment. Follow-up 3 may shift from the symptom toward the broader business opportunity when the evidence supports it and may connect that opportunity to Brian's custom website work without claiming a rebuild is required. Follow-up 4 is the breakup: close the loop respectfully, do not introduce a new problem or proof point, do not guilt or pressure the prospect, do not manufacture urgency, and leave the door open if timing changes. Use one low-friction CTA on follow-ups 1-3 and no new subject line. The breakup should not ask for a meeting or create another follow-up obligation.";

export function normalizeFollowUpDelays(input: unknown): number[] {
  const valid = Array.isArray(input)
    ? input.filter((value): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 90).slice(0, FOLLOW_UP_COUNT)
    : [];

  return Array.from({ length: FOLLOW_UP_COUNT }, (_, index) => valid[index] ?? DEFAULT_FOLLOW_UP_DELAYS_DAYS[index]);
}

export function isBreakupSequenceNumber(sequenceNumber: number) {
  return sequenceNumber === BREAKUP_SEQUENCE_NUMBER;
}
