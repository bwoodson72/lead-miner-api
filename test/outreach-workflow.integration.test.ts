import test from "node:test";
import assert from "node:assert/strict";
import { claimApprovedMessage } from "../src/lib/outreach-sending.js";
import { applyReplyAutomationStop } from "../src/lib/reply-state.js";
import { getSendIneligibilityReason } from "../src/lib/workflow-policy.js";

test("approved outreach stops cleanly after a prospect reply", async () => {
  const lead = {
    id: 100,
    email: "owner@example.com",
    domain: "example.com",
    status: "ready_for_outreach",
    replyStatus: null as string | null,
    lastReplyAt: null as Date | null,
    suppressions: [] as Array<{ value: string }>,
  };
  const messages: any[] = [
    { id: 501, leadId: lead.id, kind: "initial", status: "approved", idempotencyKey: null, sendAttemptedAt: null, sendError: null },
  ];
  const suppressions: any[] = [];

  const prisma = {
    outreachMessage: {
      async updateMany(args: any) {
        let count = 0;
        for (const message of messages) {
          if (args.where.id !== undefined && message.id !== args.where.id) continue;
          if (args.where.leadId !== undefined && message.leadId !== args.where.leadId) continue;
          if (typeof args.where.status === "string" && message.status !== args.where.status) continue;
          if (args.where.status?.in && !args.where.status.in.includes(message.status)) continue;
          Object.assign(message, args.data);
          count++;
        }
        return { count };
      },
      async findUnique(args: any) {
        return messages.find((message) => message.id === args.where.id) ?? null;
      },
    },
    suppression: {
      async upsert(args: any) {
        suppressions.push({ ...args.create });
      },
    },
  } as any;

  assert.equal(getSendIneligibilityReason(lead), null);

  const claim = await claimApprovedMessage(prisma, 501, new Date("2026-08-15T20:00:00.000Z"));
  assert.equal(claim.state, "claimed");
  assert.equal(messages[0].status, "sending");
  assert.equal(messages[0].idempotencyKey, "lead-miner/outreach/501");

  // Provider completion is represented without making a network call.
  messages[0].status = "sent";
  messages.push({ id: 502, leadId: lead.id, kind: "followup", status: "approved", sendError: null });

  lead.replyStatus = "question";
  lead.lastReplyAt = new Date("2026-08-16T14:00:00.000Z");
  lead.status = "replied";

  const stopped = await applyReplyAutomationStop(prisma, { leadId: lead.id, classification: "question", email: lead.email });
  assert.equal(stopped.cancelledCount, 1);
  assert.equal(messages.find((message) => message.id === 502)?.status, "cancelled");
  assert.equal(suppressions.length, 0);
  assert.equal(getSendIneligibilityReason(lead), "Lead has already replied");
});
