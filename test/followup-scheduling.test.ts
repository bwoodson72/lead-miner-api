import test from "node:test";
import assert from "node:assert/strict";
import { nextFollowUpDate } from "../src/lib/outreach-sending.js";

test("follow-up schedule selects delay by touch sequence", () => {
  const originalNow = Date.now;
  Date.now = () => Date.UTC(2026, 7, 15, 12, 0, 0);
  try {
    assert.equal(nextFollowUpDate([4, 6, 10], 1)?.toISOString(), "2026-08-19T12:00:00.000Z");
    assert.equal(nextFollowUpDate([4, 6, 10], 2)?.toISOString(), "2026-08-21T12:00:00.000Z");
    assert.equal(nextFollowUpDate([4, 6, 10], 3)?.toISOString(), "2026-08-25T12:00:00.000Z");
    assert.equal(nextFollowUpDate([4, 6, 10], 4), null);
  } finally {
    Date.now = originalNow;
  }
});

test("invalid delay values are ignored", () => {
  const originalNow = Date.now;
  Date.now = () => Date.UTC(2026, 7, 15, 12, 0, 0);
  try {
    assert.equal(nextFollowUpDate([0, -1, "4", 3], 1)?.toISOString(), "2026-08-18T12:00:00.000Z");
    assert.equal(nextFollowUpDate(null, 1), null);
  } finally {
    Date.now = originalNow;
  }
});
