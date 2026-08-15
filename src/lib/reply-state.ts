export function leadStatusForReply(classification: string): string {
  if (classification === "interested" || classification === "booking_intent") return "interested";
  if (classification === "bounce") return "bounced";
  if (classification === "unsubscribe") return "unsubscribed";
  return "replied";
}

export function replyRequiresSuppression(classification: string): boolean {
  return classification === "bounce" || classification === "unsubscribe";
}

/**
 * Stop future outreach after an inbound reply. Draft/approved messages are safe to
 * cancel. Messages already in `sending` are deliberately left alone because the
 * provider call may already be in flight and cannot be reliably unsent.
 */
export async function applyReplyAutomationStop(
  tx: any,
  input: { leadId: number; classification: string; email: string | null },
) {
  const cancelled = await tx.outreachMessage.updateMany({
    where: { leadId: input.leadId, status: { in: ["draft", "approved"] } },
    data: { status: "cancelled", sendError: "Cancelled because lead replied" },
  });

  let suppressed = false;
  if (replyRequiresSuppression(input.classification) && input.email) {
    const value = input.email.toLowerCase();
    await tx.suppression.upsert({
      where: { type_value: { type: "email", value } },
      update: { reason: input.classification },
      create: { leadId: input.leadId, type: "email", value, reason: input.classification },
    });
    suppressed = true;
  }

  return { cancelledCount: cancelled.count, suppressed };
}
