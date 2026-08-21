import { getContactIdentityRiskReason, type ContactSafetyEvidence } from "./contact-safety.js";

export type SendEligibilityLead = {
  email: string | null;
  domain: string;
  status: string;
  qualificationDecision?: string | null;
  replyStatus: string | null;
  lastReplyAt: Date | null;
  suppressions: Array<{ value: string }>;
  contacts?: ContactSafetyEvidence[];
};

const BLOCKED_SEND_STATUSES = new Set([
  "replied",
  "responded",
  "interested",
  "call_scheduled",
  "proposal_sent",
  "won",
  "lost",
  "rejected",
  "held",
  "bounced",
  "unsubscribed",
  "closed_no_response",
]);

const EXPLICIT_OUTREACH_SEQUENCE_STATUSES = new Set([
  "ready_for_outreach",
  "contacted",
  "followup_due",
]);

export function getSendIneligibilityReason(lead: SendEligibilityLead): string | null {
  if (!lead.email) return "Lead has no email address";
  const contactRisk = getContactIdentityRiskReason(lead);
  if (contactRisk) return contactRisk;
  if (lead.replyStatus || lead.lastReplyAt) return "Lead has already replied";
  if (lead.qualificationDecision && lead.qualificationDecision !== "rebuild_candidate" && !EXPLICIT_OUTREACH_SEQUENCE_STATUSES.has(lead.status)) {
    return `Lead decision ${lead.qualificationDecision} is not send-eligible`;
  }
  if (BLOCKED_SEND_STATUSES.has(lead.status)) return `Lead status ${lead.status} is not send-eligible`;
  const email = lead.email.toLowerCase();
  const domain = lead.domain.toLowerCase();
  const suppressed = lead.suppressions.some((suppression) => {
    const value = suppression.value.toLowerCase();
    return value === email || value === domain;
  });
  if (suppressed) return "Lead or email is suppressed";
  return null;
}

export function makeOutreachIdempotencyKey(messageId: number) {
  return `lead-miner/outreach/${messageId}`;
}

export function makeGmailRfcMessageId(messageId: number, senderEmail: string) {
  const domain = senderEmail.split("@")[1] || "lead-miner.local";
  return `<lead-miner-outreach-${messageId}@${domain}>`;
}

function timeParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { weekday: value("weekday"), hour: Number(value("hour")), minute: Number(value("minute")) };
}

export function isWithinSendWindow(
  start: string,
  end: string,
  now = new Date(),
  timeZone = "America/Chicago",
  weekendSendingEnabled = false,
): boolean {
  const parts = timeParts(now, timeZone);
  if (!weekendSendingEnabled && (parts.weekday === "Sat" || parts.weekday === "Sun")) return false;
  const minutes = parts.hour * 60 + parts.minute;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  return startMinutes <= endMinutes
    ? minutes >= startMinutes && minutes <= endMinutes
    : minutes >= startMinutes || minutes <= endMinutes;
}

export function nextEligibleSendTime(
  target: Date,
  start: string,
  end: string,
  timeZone = "America/Chicago",
  weekendSendingEnabled = false,
): Date {
  let candidate = new Date(target);
  if (candidate.getSeconds() || candidate.getMilliseconds()) {
    candidate = new Date(candidate.getTime() + 60_000);
    candidate.setSeconds(0, 0);
  }
  const maxMinutes = 14 * 24 * 60;
  for (let i = 0; i <= maxMinutes; i++) {
    if (isWithinSendWindow(start, end, candidate, timeZone, weekendSendingEnabled)) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error("Could not find an eligible send window within 14 days");
}
