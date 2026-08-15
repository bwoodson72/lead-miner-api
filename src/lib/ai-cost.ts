const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
};

export function estimateAiCost(model: string, inputTokens?: number | null, outputTokens?: number | null): number | null {
  const pricing = PRICING_PER_MILLION[model.toLowerCase()];
  if (!pricing || (inputTokens == null && outputTokens == null)) return null;
  const cost = ((inputTokens ?? 0) / 1_000_000) * pricing.input + ((outputTokens ?? 0) / 1_000_000) * pricing.output;
  return Math.round(cost * 100_000_000) / 100_000_000;
}
