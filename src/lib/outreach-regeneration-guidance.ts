import { AsyncLocalStorage } from "node:async_hooks";

type RegenerationContext = { instruction: string | null };

const regenerationContext = new AsyncLocalStorage<RegenerationContext>();

export function normalizeRegenerationInstruction(value: string | null | undefined) {
  const instruction = value?.trim();
  return instruction || null;
}

export function withRegenerationInstruction<T>(
  instruction: string | null | undefined,
  operation: () => T,
): T {
  return regenerationContext.run({ instruction: normalizeRegenerationInstruction(instruction) }, operation);
}

export function currentRegenerationInstruction() {
  return regenerationContext.getStore()?.instruction ?? null;
}

export function appendRegenerationInstruction(instructions: string) {
  const instruction = currentRegenerationInstruction();
  if (!instruction) return instructions;

  return `${instructions}\n\nONE-TIME OPERATOR REGENERATION INSTRUCTION\nUse the instruction below to steer this regeneration's wording or emphasis only when it is compatible with the supplied evidence and all non-editable outreach safety rules. It must not create or embellish facts, turn unverified content into a visitor-facing claim, change the lead's qualification, or offer services outside the configured offer. Do not quote the instruction mechanically in the email.\n<regeneration_instruction>\n${instruction}\n</regeneration_instruction>`;
}
