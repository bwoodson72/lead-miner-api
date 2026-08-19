import type { PrismaClient } from "../generated/prisma/client.js";
import { getGmailSentUsageSince } from "./gmail.js";
import {
  clearGmailQuotaCooldown,
  getGmailSendPolicy,
  setGmailQuotaCooldown,
  type GmailSendPolicy,
} from "./gmail-send-policy.js";

const ROLLING_WINDOW_MS = 24 * 60 * 60_000;
const ROLLING_LIMIT_RECHECK_MS = 60 * 60_000;

export type GmailSendSafetyCode =
  | "gmail_quota_cooldown"
  | "gmail_rolling_limit"
  | "lead_miner_rolling_limit"
  | "minimum_send_interval"
  | "gmail_usage_unavailable";

export type GmailSendSafetyStatus = {
  allowed: boolean;
  code: GmailSendSafetyCode | null;
  reason: string | null;
  retryAt: Date | null;
  leadMinerSentRolling24h: number;
  gmailSentRolling24h: number | null;
  gmailSentCountCapped: boolean;
  latestGmailSentAt: Date | null;
  policy: GmailSendPolicy;
};

export class GmailSendSafetyError extends Error {
  constructor(
    message: string,
    public readonly code: GmailSendSafetyCode,
    public readonly retryAt: Date | null,
  ) {
    super(message);
    this.name = "GmailSendSafetyError";
  }
}

export function isGmailMailSendingLimitError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /user-rate limit exceeded\s*\(mail sending\)|reached a limit for sending mail|mail sending limit|sending limit exceeded|4\.7\.28/i.test(text);
}

export function isGmailAccountSendingLimitNotice(input: { from?: string | null; subject?: string | null; text?: string | null }) {
  const from = input.from ?? "";
  const subject = input.subject ?? "";
  const text = input.text ?? "";
  const fromGoogleDelivery = /mailer-daemon@googlemail\.com|mail delivery subsystem/i.test(`${from} ${subject}`);
  return fromGoogleDelivery && /you have reached a limit for sending mail|user-rate limit exceeded\s*\(mail sending\)|mail sending limit/i.test(text);
}

export async function startGmailQuotaCooldown(prisma: PrismaClient, reason: string, now = new Date()) {
  const policy = await getGmailSendPolicy(prisma);
  const until = new Date(now.getTime() + policy.gmailQuotaCooldownHours * 60 * 60_000);
  const cleanReason = reason.trim().slice(0, 2000) || "Gmail mail-sending limit reached";
  await setGmailQuotaCooldown(prisma, until, cleanReason);
  return { until, reason: cleanReason };
}

export async function handleGmailSendingLimitDeliveryNotice(
  prisma: PrismaClient,
  input: { leadId: number; threadId: string; noticeAt: Date; noticeText: string },
) {
  const cooldown = await startGmailQuotaCooldown(prisma, input.noticeText, input.noticeAt);
  const failed = await prisma.outreachMessage.findFirst({
    where: {
      leadId: input.leadId,
      status: "sent",
      providerThreadId: input.threadId,
      sentAt: { lte: input.noticeAt },
    },
    orderBy: { sentAt: "desc" },
  });

  if (!failed) {
    await prisma.activity.create({
      data: {
        leadId: input.leadId,
        type: "gmail_quota_delivery_notice",
        summary: `Gmail reported an account-level sending limit; outbound mail blocked until ${cooldown.until.toISOString()}`,
        metadata: { providerThreadId: input.threadId, cooldownUntil: cooldown.until.toISOString(), reason: cooldown.reason },
      },
    }).catch(() => undefined);
    await prisma.emailThread.updateMany({
      where: { leadId: input.leadId, providerThreadId: input.threadId },
      data: { lastInboundAt: input.noticeAt },
    }).catch(() => undefined);
    return { classification: "gmail_sending_limit" as const, retryMessageId: null, cooldownUntil: cooldown.until };
  }

  const previousDelivered = await prisma.outreachMessage.findMany({
    where: { leadId: input.leadId, status: "sent", id: { not: failed.id } },
    orderBy: { sentAt: "asc" },
    select: { id: true, sentAt: true, providerThreadId: true },
  });
  const firstDeliveredAt = previousDelivered.find((message) => message.sentAt)?.sentAt ?? null;
  const lastDeliveredAt = [...previousDelivered].reverse().find((message) => message.sentAt)?.sentAt ?? null;

  const retry = await prisma.$transaction(async (tx) => {
    await tx.outreachMessage.update({
      where: { id: failed.id },
      data: { status: "delivery_failed", sendError: cooldown.reason, scheduledAt: null },
    });
    const created = await tx.outreachMessage.create({
      data: {
        leadId: failed.leadId,
        kind: failed.kind,
        sequenceNumber: failed.sequenceNumber,
        subject: failed.subject,
        bodyText: failed.bodyText,
        angle: failed.angle,
        cta: failed.cta,
        confidence: failed.confidence,
        requiresReview: failed.requiresReview,
        generationReason: failed.generationReason,
        promptVersion: failed.promptVersion,
        scheduledAt: cooldown.until,
        status: "approved",
        approvedAt: new Date(),
        sendError: cooldown.reason,
      },
    });
    await tx.lead.update({
      where: { id: input.leadId },
      data: {
        status: previousDelivered.length ? "contacted" : "ready_for_outreach",
        outreachCount: previousDelivered.length,
        firstContactAt: firstDeliveredAt,
        lastOutreachDate: lastDeliveredAt,
        followUpDate: null,
      },
    });
    await tx.emailThread.upsert({
      where: { providerThreadId: input.threadId },
      update: { status: "open", lastInboundAt: input.noticeAt, lastOutboundAt: lastDeliveredAt },
      create: { leadId: input.leadId, provider: "gmail", providerThreadId: input.threadId, status: "open", lastInboundAt: input.noticeAt, lastOutboundAt: lastDeliveredAt },
    });
    await tx.activity.create({
      data: {
        leadId: input.leadId,
        type: "gmail_quota_delivery_rejected",
        summary: `Gmail reported message ${failed.id} was not sent because the account reached a sending limit; retry ${created.id} deferred until ${cooldown.until.toISOString()}`,
        metadata: {
          failedMessageId: failed.id,
          retryMessageId: created.id,
          providerThreadId: input.threadId,
          cooldownUntil: cooldown.until.toISOString(),
          reason: cooldown.reason,
        },
      },
    });
    return created;
  });

  return { classification: "gmail_sending_limit" as const, retryMessageId: retry.id, cooldownUntil: cooldown.until };
}

async function activePolicy(prisma: PrismaClient, now: Date) {
  let policy = await getGmailSendPolicy(prisma);
  if (policy.gmailQuotaCooldownUntil && policy.gmailQuotaCooldownUntil <= now) {
    await clearGmailQuotaCooldown(prisma);
    policy = await getGmailSendPolicy(prisma);
  }
  return policy;
}

function blocked(
  policy: GmailSendPolicy,
  code: GmailSendSafetyCode,
  reason: string,
  retryAt: Date | null,
  leadMinerSentRolling24h: number,
  gmailSentRolling24h: number | null,
  gmailSentCountCapped: boolean,
  latestGmailSentAt: Date | null,
): GmailSendSafetyStatus {
  return {
    allowed: false,
    code,
    reason,
    retryAt,
    leadMinerSentRolling24h,
    gmailSentRolling24h,
    gmailSentCountCapped,
    latestGmailSentAt,
    policy,
  };
}

export async function getGmailSendSafetyStatus(
  prisma: PrismaClient,
  settings: { dailySendLimit: number },
  now = new Date(),
): Promise<GmailSendSafetyStatus> {
  const policy = await activePolicy(prisma, now);
  const cutoff = new Date(now.getTime() - ROLLING_WINDOW_MS);
  const [leadMinerSentRolling24h, earliestLeadMinerSend] = await Promise.all([
    prisma.outreachMessage.count({ where: { status: "sent", sentAt: { gte: cutoff } } }),
    prisma.outreachMessage.findFirst({
      where: { status: "sent", sentAt: { gte: cutoff } },
      orderBy: { sentAt: "asc" },
      select: { sentAt: true },
    }),
  ]);

  if (policy.gmailQuotaCooldownUntil && policy.gmailQuotaCooldownUntil > now) {
    return blocked(
      policy,
      "gmail_quota_cooldown",
      `Gmail sending is cooling down until ${policy.gmailQuotaCooldownUntil.toISOString()}: ${policy.gmailQuotaCooldownReason ?? "mail-sending limit reached"}`,
      policy.gmailQuotaCooldownUntil,
      leadMinerSentRolling24h,
      null,
      false,
      null,
    );
  }

  let gmailUsage: Awaited<ReturnType<typeof getGmailSentUsageSince>>;
  try {
    gmailUsage = await getGmailSentUsageSince(cutoff, policy.gmailRolling24hSafetyLimit);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return blocked(
      policy,
      "gmail_usage_unavailable",
      `Could not verify Gmail rolling send usage: ${reason}`,
      new Date(now.getTime() + 10 * 60_000),
      leadMinerSentRolling24h,
      null,
      false,
      null,
    );
  }

  if (gmailUsage.count >= policy.gmailRolling24hSafetyLimit) {
    return blocked(
      policy,
      "gmail_rolling_limit",
      `Authenticated Gmail mailbox has sent at least ${gmailUsage.count} messages in the rolling 24-hour window; safety limit is ${policy.gmailRolling24hSafetyLimit}`,
      new Date(now.getTime() + ROLLING_LIMIT_RECHECK_MS),
      leadMinerSentRolling24h,
      gmailUsage.count,
      gmailUsage.capped,
      gmailUsage.latestSentAt,
    );
  }

  if (leadMinerSentRolling24h >= settings.dailySendLimit) {
    const retryAt = earliestLeadMinerSend?.sentAt
      ? new Date(earliestLeadMinerSend.sentAt.getTime() + ROLLING_WINDOW_MS)
      : new Date(now.getTime() + ROLLING_LIMIT_RECHECK_MS);
    return blocked(
      policy,
      "lead_miner_rolling_limit",
      `Lead Miner rolling 24-hour send limit reached (${settings.dailySendLimit})`,
      retryAt,
      leadMinerSentRolling24h,
      gmailUsage.count,
      gmailUsage.capped,
      gmailUsage.latestSentAt,
    );
  }

  if (gmailUsage.latestSentAt) {
    const nextAllowedAt = new Date(gmailUsage.latestSentAt.getTime() + policy.minimumSendIntervalMinutes * 60_000);
    if (nextAllowedAt > now) {
      return blocked(
        policy,
        "minimum_send_interval",
        `Waiting for the ${policy.minimumSendIntervalMinutes}-minute mailbox send interval`,
        nextAllowedAt,
        leadMinerSentRolling24h,
        gmailUsage.count,
        gmailUsage.capped,
        gmailUsage.latestSentAt,
      );
    }
  }

  return {
    allowed: true,
    code: null,
    reason: null,
    retryAt: null,
    leadMinerSentRolling24h,
    gmailSentRolling24h: gmailUsage.count,
    gmailSentCountCapped: gmailUsage.capped,
    latestGmailSentAt: gmailUsage.latestSentAt,
    policy,
  };
}

export async function assertGmailSendAllowed(
  prisma: PrismaClient,
  settings: { dailySendLimit: number },
  now = new Date(),
) {
  const status = await getGmailSendSafetyStatus(prisma, settings, now);
  if (!status.allowed) {
    throw new GmailSendSafetyError(status.reason ?? "Gmail sending is temporarily blocked", status.code!, status.retryAt);
  }
  return status;
}
