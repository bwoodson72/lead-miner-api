export type SendEligibilityLead = {
  email: string | null;
  domain: string;
  status: string;
  replyStatus: string | null;
  lastReplyAt: Date | null;
  suppressions: Array<{ value: string }>;
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
  "bounced",
  "unsubscribed",
  "closed_no_response",
]);

export function getSendIneligibilityReason(lead: SendEligibilityLead): string | null {
  if (!lead.email) return "Lead has no email address";
  if (lead.replyStatus || lead.lastReplyAt) return "Lead has already replied";
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

export function isWithinSendWindow(start: string, end: string, now = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return minutes >= sh * 60 + sm && minutes <= eh * 60 + em;
}
