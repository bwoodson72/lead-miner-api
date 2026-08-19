import test from "node:test";
import assert from "node:assert/strict";
import {
  GMAIL_PIPELINE_HIERARCHY,
  GMAIL_PIPELINE_LABELS,
  GMAIL_PIPELINE_LEGACY_LABELS,
  resolveGmailPipelineLabel,
  syncLeadGmailPipelineLabel,
  syncLeadGmailPipelineLabelSafely,
} from "../src/lib/gmail-pipeline.js";

const state = (overrides: Partial<Parameters<typeof resolveGmailPipelineLabel>[0]> = {}) => ({
  status: "contacted",
  replyStatus: null,
  latestSentSequenceNumber: 1,
  latestSendError: null,
  ...overrides,
});

test("Gmail pipeline state mapping has one canonical label for each outreach stage", () => {
  assert.equal(resolveGmailPipelineLabel(state()), GMAIL_PIPELINE_LABELS.active.initialSent);
  assert.equal(resolveGmailPipelineLabel(state({ latestSentSequenceNumber: 2 })), GMAIL_PIPELINE_LABELS.active.followUp1);
  assert.equal(resolveGmailPipelineLabel(state({ latestSentSequenceNumber: 3 })), GMAIL_PIPELINE_LABELS.active.followUp2);
  assert.equal(resolveGmailPipelineLabel(state({ latestSentSequenceNumber: 4 })), GMAIL_PIPELINE_LABELS.active.followUp3);
  assert.equal(resolveGmailPipelineLabel(state({ latestSentSequenceNumber: 5 })), GMAIL_PIPELINE_LABELS.closed.noResponse);
});

test("reply and terminal states override the outbound sequence label", () => {
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "interested", latestSendError: "old failure" })), GMAIL_PIPELINE_LABELS.replies.interested);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "question" })), GMAIL_PIPELINE_LABELS.replies.question);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "objection" })), GMAIL_PIPELINE_LABELS.replies.objection);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "not_now" })), GMAIL_PIPELINE_LABELS.replies.notNow);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "referral" })), GMAIL_PIPELINE_LABELS.replies.referral);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "wrong_person" })), GMAIL_PIPELINE_LABELS.replies.wrongPerson);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "other" })), GMAIL_PIPELINE_LABELS.replies.needsReview);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "out_of_office" })), GMAIL_PIPELINE_LABELS.active.outOfOffice);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "bounce" })), GMAIL_PIPELINE_LABELS.closed.bounced);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "unsubscribe" })), GMAIL_PIPELINE_LABELS.closed.unsubscribed);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "not_interested" })), GMAIL_PIPELINE_LABELS.closed.notInterested);
  assert.equal(resolveGmailPipelineLabel(state({ replyStatus: "spam_or_scam" })), GMAIL_PIPELINE_LABELS.closed.rejected);
});

test("manual lifecycle states and failures map without inventing a second pipeline state", () => {
  assert.equal(resolveGmailPipelineLabel(state({ status: "won", replyStatus: null })), GMAIL_PIPELINE_LABELS.closed.won);
  assert.equal(resolveGmailPipelineLabel(state({ status: "disqualified", replyStatus: null })), GMAIL_PIPELINE_LABELS.closed.badFit);
  assert.equal(resolveGmailPipelineLabel(state({ status: "rejected", replyStatus: null })), GMAIL_PIPELINE_LABELS.closed.rejected);
  assert.equal(resolveGmailPipelineLabel(state({ status: "replied", replyStatus: null })), GMAIL_PIPELINE_LABELS.needsAttention.replyUnhandled);
  assert.equal(resolveGmailPipelineLabel(state({ latestSendError: "provider timeout" })), GMAIL_PIPELINE_LABELS.needsAttention.sendFailed);
});

function makePrisma() {
  const activities: any[] = [];
  return {
    prisma: {
      lead: {
        async findUnique() {
          return { id: 42, status: "contacted", replyStatus: null, emailThreads: [{ providerThreadId: "thread-42" }] };
        },
      },
      outreachMessage: {
        async findFirst(args: any) {
          if (args.where.status === "sent") return { sequenceNumber: 2, providerThreadId: "thread-42" };
          return null;
        },
      },
      activity: {
        async create(args: any) { activities.push(args.data); return args.data; },
      },
    } as any,
    activities,
  };
}

test("thread synchronization removes every stale Lead Miner state and legacy stage label", async () => {
  const { prisma } = makePrisma();
  const managed = new Map(GMAIL_PIPELINE_HIERARCHY.map((name) => [name, `managed:${name}`]));
  const legacy = new Map(GMAIL_PIPELINE_LEGACY_LABELS.map((name) => [name, `legacy:${name}`]));
  const oldStateId = managed.get(GMAIL_PIPELINE_LABELS.active.initialSent)!;
  const targetId = managed.get(GMAIL_PIPELINE_LABELS.active.followUp1)!;
  let modification: any = null;

  const result = await syncLeadGmailPipelineLabel(prisma, 42, {
    dependencies: {
      ensureLabelIds: async () => managed,
      findLabelIds: async () => legacy,
      getThreadLabelIds: async () => [oldStateId, legacy.get("✔")!, "SENT"],
      modifyThreadLabels: async (_threadId, input) => { modification = input; return null; },
    } as any,
  });

  assert.equal(result.success, true);
  assert.equal(result.label, GMAIL_PIPELINE_LABELS.active.followUp1);
  assert.deepEqual(modification.addLabelIds, [targetId]);
  assert.ok(modification.removeLabelIds.includes(oldStateId));
  assert.ok(modification.removeLabelIds.includes(legacy.get("✔")));
  assert.ok(!modification.removeLabelIds.includes("SENT"));
});

test("Gmail labeling failures are recorded but never thrown into the business workflow", async () => {
  const { prisma, activities } = makePrisma();
  const result = await syncLeadGmailPipelineLabelSafely(prisma, 42, "test transition", {
    dependencies: {
      ensureLabelIds: async () => { throw new Error("gmail unavailable"); },
      findLabelIds: async () => new Map(),
      getThreadLabelIds: async () => [],
      modifyThreadLabels: async () => null,
    } as any,
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /gmail unavailable/i);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].type, "gmail_pipeline_label_sync_failed");
});
