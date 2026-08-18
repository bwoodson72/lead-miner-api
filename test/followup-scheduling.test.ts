import test from "node:test";
import assert from "node:assert/strict";
import { nextFollowUpDate } from "../src/lib/outreach-sending.js";
import {
  BREAKUP_SEQUENCE_NUMBER,
  DEFAULT_FOLLOW_UP_DELAYS_DAYS,
  FOLLOW_UP_COUNT,
  TOTAL_OUTREACH_TOUCHES,
  isBreakupSequenceNumber,
  normalizeFollowUpDelays,
} from "../src/lib/outreach-sequence.js";

test("outreach sequence is initial plus four follow-ups", () => {
  assert.equal(FOLLOW_UP_COUNT, 4);
  assert.equal(TOTAL_OUTREACH_TOUCHES, 5);
  assert.equal(BREAKUP_SEQUENCE_NUMBER, 5);
  assert.equal(isBreakupSequenceNumber(5), true);
  assert.equal(isBreakupSequenceNumber(4), false);
});

test("follow-up schedule selects four delays and stops after breakup", () => {
  const from = new Date("2026-08-15T12:00:00.000Z");
  const options = { from };
  assert.equal(nextFollowUpDate([4, 6, 10, 14], 1, options)?.toISOString(), "2026-08-19T12:00:00.000Z");
  assert.equal(nextFollowUpDate([4, 6, 10, 14], 2, options)?.toISOString(), "2026-08-21T12:00:00.000Z");
  assert.equal(nextFollowUpDate([4, 6, 10, 14], 3, options)?.toISOString(), "2026-08-25T12:00:00.000Z");
  assert.equal(nextFollowUpDate([4, 6, 10, 14], 4, options)?.toISOString(), "2026-08-29T12:00:00.000Z");
  assert.equal(nextFollowUpDate([4, 6, 10, 14], 5, options), null);
  assert.equal(nextFollowUpDate([4, 6, 10, 14, 30], 5, options), null);
});

test("legacy schedules are normalized to four follow-ups", () => {
  assert.deepEqual(normalizeFollowUpDelays([4, 6, 10]), [4, 6, 10, 14]);
  assert.deepEqual(normalizeFollowUpDelays(null), [...DEFAULT_FOLLOW_UP_DELAYS_DAYS]);
  assert.deepEqual(normalizeFollowUpDelays([3, 7, 12, 20, 30]), [3, 7, 12, 20]);
});
