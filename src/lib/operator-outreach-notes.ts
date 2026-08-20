import { appendRegenerationInstruction } from "./outreach-regeneration-guidance.js";

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
  let combined = instructions;

  if (normalized) {
    const usage = mode === "reply"
      ? "Use these notes only when deciding the recommended human action or composing suggestedResponse. Classify the prospect's inbound reply from the reply and thread itself; do not let these notes change the reply classification. These notes never change research, qualification, priority, or the stored qualification decision."
      : "Use these notes only as persistent human context for wording and emphasis after qualification. They never change research, qualification, priority, or the stored qualification decision, and they do not select the outreach angle. Treat factual observations in the notes as operator-provided context for the message, while still obeying all factual and evidence-safety rules. Do not quote the notes mechanically.";

    combined = `${instructions}\n\nMY NOTES\nThese notes were supplied manually by the operator and are private context, not text to copy verbatim. ${usage}\n<operator_notes>\n${normalized}\n</operator_notes>`;
  }

  return mode === "outreach" ? appendRegenerationInstruction(combined) : combined;
}
