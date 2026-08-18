import { OUTREACH_PROMPT_VERSION, outreachDraftNeedsRegeneration } from "./ai-outreach.js";
import { FOLLOWUP_PROMPT_VERSION, followUpNeedsRegeneration } from "./ai-followup.js";

export const MANUAL_OUTREACH_VERSION = "manual";

export function requiredOutreachPromptVersion(kind: string) {
  return kind === "followup" ? FOLLOWUP_PROMPT_VERSION : OUTREACH_PROMPT_VERSION;
}

export function isCurrentOutreachPromptVersion(kind: string, promptVersion: string | null | undefined) {
  return promptVersion === MANUAL_OUTREACH_VERSION || promptVersion === requiredOutreachPromptVersion(kind);
}

export function outreachMessageNeedsRegeneration(kind: string, bodyText: string, subject = "", cta = "") {
  return kind === "followup"
    ? followUpNeedsRegeneration(bodyText)
    : outreachDraftNeedsRegeneration(bodyText, subject, cta);
}

export function staleOutreachReason(kind: string, promptVersion: string | null | undefined) {
  if (isCurrentOutreachPromptVersion(kind, promptVersion)) return null;
  return `Draft prompt version ${promptVersion ?? "legacy/unversioned"} is stale; current ${kind === "followup" ? "follow-up" : "initial outreach"} version is ${requiredOutreachPromptVersion(kind)}`;
}
