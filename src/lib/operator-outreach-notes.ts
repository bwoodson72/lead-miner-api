export function normalizeOutreachNotes(value: string | null | undefined) {
  const notes = value?.trim();
  return notes || null;
}

export function withOperatorOutreachNotes(
  instructions: string,
  notes: string | null | undefined,
  mode: "outreach" | "reply" = "outreach",
) {
  const normalized = normalizeOutreachNotes(notes);
  if (!normalized) return instructions;

  const usage = mode === "reply"
    ? "Use these notes only when deciding the recommended human action or composing suggestedResponse. Classify the prospect's inbound reply from the reply and thread itself; do not let these notes change the reply classification."
    : "Use these notes as high-priority human context when choosing wording and emphasis for the sales message. If they conflict with automated research, prefer the operator's context unless doing so would create an unsupported claim. Do not quote the notes mechanically.";

  return `${instructions}\n\nOPERATOR OUTREACH NOTES\nThese notes were supplied manually by the salesperson and are private context, not text to copy verbatim. ${usage}\n<operator_notes>\n${normalized}\n</operator_notes>`;
}
