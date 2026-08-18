export function leadStatusForReply(classification: string): string {
  if (classification === "interested" || classification === "booking_intent") return "interested";
  if (classification === "bounce") return "bounced";
  if (classification === "unsubscribe") return "unsubscribed";
  if (classification === "spam_or_scam") return "rejected";
  if (classification === "not_interested") return "lost";
  if (classification === "out_of_office") return "contacted";
  return "replied";
}

export function replyRequiresSuppression(classification: string): boolean {
  return classification === "bounce" || classification === "unsubscribe" || classification === "spam_or_scam";
}

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
