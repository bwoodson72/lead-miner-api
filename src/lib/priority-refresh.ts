import type { PrismaClient } from "../generated/prisma/client.js";
import { prioritizeLead } from "./outreach-preparation.js";

export async function refreshLeadPriorityForDecision(
  prisma: PrismaClient,
  leadId: number,
  decision: string | null | undefined,
  options: { enabled?: boolean; calculator?: typeof prioritizeLead } = {},
) {
  const enabled = options.enabled ?? true;
  const calculator = options.calculator ?? prioritizeLead;

  if (decision !== "rebuild_candidate") {
    await prisma.lead.update({ where: { id: leadId }, data: { priorityScore: null, priorityBreakdown: {} } });
    return null;
  }

  if (!enabled) return null;

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { email: true } });
  if (!lead?.email) {
    await prisma.lead.update({ where: { id: leadId }, data: { priorityScore: null, priorityBreakdown: {} } });
    return null;
  }

  const priority = await calculator(prisma, leadId);
  return priority.score;
}
