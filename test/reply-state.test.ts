import test from "node:test";
import assert from "node:assert/strict";
import { applyReplyAutomationStop, leadStatusForReply, replyRequiresSuppression } from "../src/lib/reply-state.js";

function makeReplyTx() {
  const messages = [
    { id: 1, leadId: 10, status: "sent", sendError: null },
    { id: 2, leadId: 10, status: "draft", sendError: null },
    { id: 3, leadId: 10, status: "approved", sendError: null },
    { id: 4, leadId: 10, status: "sending", sendError: null },
  ];
  const suppressions: any[] = [];

  const tx = {
    outreachMessage: {
      async updateMany(args: any) {
        let count = 0;
        for (const message of messages) {
          if (message.leadId !== args.where.leadId) continue;
          if (!args.where.status.in.includes(message.status)) continue;
          Object.assign(message, args.data);
          count++;
        }
        return { count };
      },
    },
    suppression: {
      async upsert(args: any) {
        const key = args.where.type_value;
        const existing = suppressions.find((s) => s.type === key.type && s.value === key.value);
        if (existing) Object.assign(existing, args.update);
        else suppressions.push({ ...args.create });
      },
    },
  };

  return { tx, messages, suppressions };
}

test("reply classifications map to terminal CRM states", () => {
  assert.equal(leadStatusForReply("interested"), "interested");
  assert.equal(leadStatusForReply("booking_intent"), "interested");
  assert.equal(leadStatusForReply("bounce"), "bounced");
  assert.equal(leadStatusForReply("unsubscribe"), "unsubscribed");
  assert.equal(leadStatusForReply("question"), "replied");
});

test("any reply cancels draft and approved outreach but does not rewrite sent or in-flight messages", async () => {
  const fake = makeReplyTx();
  const result = await applyReplyAutomationStop(fake.tx, { leadId: 10, classification: "question", email: "Owner@Example.com" });

  assert.equal(result.cancelledCount, 2);
  assert.equal(fake.messages.find((m) => m.id === 1)?.status, "sent");
  assert.equal(fake.messages.find((m) => m.id === 2)?.status, "cancelled");
  assert.equal(fake.messages.find((m) => m.id === 3)?.status, "cancelled");
  assert.equal(fake.messages.find((m) => m.id === 4)?.status, "sending");
  assert.equal(fake.suppressions.length, 0);
});

test("bounce and unsubscribe suppress the address case-insensitively", async () => {
  assert.equal(replyRequiresSuppression("bounce"), true);
  assert.equal(replyRequiresSuppression("unsubscribe"), true);
  assert.equal(replyRequiresSuppression("not_interested"), false);

  const fake = makeReplyTx();
  const result = await applyReplyAutomationStop(fake.tx, { leadId: 10, classification: "unsubscribe", email: "Owner@Example.com" });

  assert.equal(result.suppressed, true);
  assert.deepEqual(fake.suppressions, [{ leadId: 10, type: "email", value: "owner@example.com", reason: "unsubscribe" }]);
});
