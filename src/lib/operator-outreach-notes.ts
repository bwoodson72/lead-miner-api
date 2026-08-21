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
      : "Use these notes as authoritative operator context for outreach selection, wording, and emphasis. They never change research, qualification, priority, or the stored qualification decision. If the notes contradict research for prospect-facing outreach, follow the notes. If they say not to lead with a topic, do not lead with it. Treat factual observations in the notes as operator-provided context while still obeying factual and evidence-safety rules. Do not quote the notes mechanically.";

    combined = `${instructions}\n\nMY NOTES\nThese notes were supplied manually by the operator and are private context, not text to copy verbatim. ${usage}\n<operator_notes>\n${normalized}\n</operator_notes>`;
  }

  return mode === "outreach" ? appendRegenerationInstruction(combined) : combined;
}
