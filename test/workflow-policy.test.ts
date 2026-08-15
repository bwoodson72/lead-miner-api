import test from "node:test";
import assert from "node:assert/strict";
import { getSendIneligibilityReason, isWithinSendWindow, makeGmailRfcMessageId, makeOutreachIdempotencyKey } from "../src/lib/workflow-policy.js";

function eligibleLead() {
  return { email: "owner@example.com", domain: "example.com", status: "ready_for_outreach", replyStatus: null, lastReplyAt: null, suppressions: [] as Array<{ value: string }> };
}

test("eligible lead is allowed to send", () => {
  assert.equal(getSendIneligibilityReason(eligibleLead()), null);
});

test("reply state blocks all additional outreach", () => {
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), replyStatus: "question" }), "Lead has already replied");
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), lastReplyAt: new Date() }), "Lead has already replied");
});

test("terminal CRM statuses block sending", () => {
  for (const status of ["interested", "won", "lost", "rejected", "bounced", "unsubscribed", "closed_no_response"]) {
    assert.match(getSendIneligibilityReason({ ...eligibleLead(), status }) ?? "", /not send-eligible/);
  }
});

test("email and domain suppressions block sending case-insensitively", () => {
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), suppressions: [{ value: "OWNER@EXAMPLE.COM" }] }), "Lead or email is suppressed");
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), suppressions: [{ value: "EXAMPLE.COM" }] }), "Lead or email is suppressed");
});

test("idempotency identities are deterministic", () => {
  assert.equal(makeOutreachIdempotencyKey(42), "lead-miner/outreach/42");
  assert.equal(makeOutreachIdempotencyKey(42), makeOutreachIdempotencyKey(42));
  assert.equal(makeGmailRfcMessageId(42, "brian@brianwoodson.dev"), "<lead-miner-outreach-42@brianwoodson.dev>");
});

test("send window includes boundaries and excludes outside times", () => {
  const at = (hour: number, minute: number) => new Date(2026, 7, 15, hour, minute, 0, 0);
  assert.equal(isWithinSendWindow("09:00", "16:30", at(9, 0)), true);
  assert.equal(isWithinSendWindow("09:00", "16:30", at(16, 30)), true);
  assert.equal(isWithinSendWindow("09:00", "16:30", at(8, 59)), false);
  assert.equal(isWithinSendWindow("09:00", "16:30", at(16, 31)), false);
});
