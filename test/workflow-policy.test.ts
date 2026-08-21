import test from "node:test";
import assert from "node:assert/strict";
import { getSendIneligibilityReason, isWithinSendWindow, makeGmailRfcMessageId, makeOutreachIdempotencyKey, nextEligibleSendTime } from "../src/lib/workflow-policy.js";

function eligibleLead() {
  return { email: "owner@example.com", domain: "example.com", status: "ready_for_outreach", qualificationDecision: "rebuild_candidate", replyStatus: null, lastReplyAt: null, suppressions: [] as Array<{ value: string }> };
}

test("eligible lead is allowed to send", () => {
  assert.equal(getSendIneligibilityReason(eligibleLead()), null);
});

test("explicitly prepared manual outreach can send without rewriting the research decision", () => {
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), qualificationDecision: "no_material_opportunity", status: "ready_for_outreach" }), null);
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), qualificationDecision: "needs_review", status: "contacted" }), null);
});

test("non-rebuild decisions remain blocked before an explicit outreach sequence starts", () => {
  assert.match(getSendIneligibilityReason({ ...eligibleLead(), qualificationDecision: "no_material_opportunity", status: "disqualified" }) ?? "", /decision no_material_opportunity is not send-eligible/);
  assert.match(getSendIneligibilityReason({ ...eligibleLead(), qualificationDecision: "needs_review", status: "research_pending" }) ?? "", /decision needs_review is not send-eligible/);
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), qualificationDecision: null }), null);
});

test("reply state blocks all additional outreach", () => {
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), replyStatus: "question" }), "Lead has already replied");
  assert.equal(getSendIneligibilityReason({ ...eligibleLead(), lastReplyAt: new Date() }), "Lead has already replied");
});

test("terminal CRM statuses block sending", () => {
  for (const status of ["interested", "won", "lost", "rejected", "held", "bounced", "unsubscribed", "closed_no_response"]) {
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

test("send window includes boundaries in configured timezone", () => {
  const atCentral = (hour: number, minute: number) => new Date(Date.UTC(2026, 7, 17, hour + 5, minute, 0, 0));
  assert.equal(isWithinSendWindow("09:00", "16:30", atCentral(9, 0), "America/Chicago", false), true);
  assert.equal(isWithinSendWindow("09:00", "16:30", atCentral(16, 30), "America/Chicago", false), true);
  assert.equal(isWithinSendWindow("09:00", "16:30", atCentral(8, 59), "America/Chicago", false), false);
  assert.equal(isWithinSendWindow("09:00", "16:30", atCentral(16, 31), "America/Chicago", false), false);
});

test("weekends roll to next eligible business window", () => {
  const saturdayNoonCentral = new Date("2026-08-15T17:00:00.000Z");
  assert.equal(isWithinSendWindow("09:00", "16:30", saturdayNoonCentral, "America/Chicago", false), false);
  assert.equal(nextEligibleSendTime(saturdayNoonCentral, "09:00", "16:30", "America/Chicago", false).toISOString(), "2026-08-17T14:00:00.000Z");
});
