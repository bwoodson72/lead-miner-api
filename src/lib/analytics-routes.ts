import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

function pct(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function bucketPriority(score: number | null) {
  if (score == null) return "unscored";
  if (score >= 80) return "80-100";
  if (score >= 60) return "60-79";
  if (score >= 40) return "40-59";
  return "0-39";
}

export function registerAnalyticsRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/analytics/summary", async (_req, res) => {
    try {
      const [leads, sentMessages, jobs] = await Promise.all([
        prisma.lead.findMany({
          where: { outreachMessages: { some: { status: "sent" } } },
          select: {
            id: true,
            keyword: true,
            category: true,
            priorityScore: true,
            primaryOutreachAngle: true,
            replyStatus: true,
            lastReplyAt: true,
            status: true,
            outreachMessages: { where: { status: "sent" }, select: { kind: true, sequenceNumber: true, angle: true, sentAt: true } },
            problems: { select: { category: true, outreachValue: true } },
          },
        }),
        prisma.outreachMessage.findMany({ where: { status: "sent" }, select: { kind: true, sequenceNumber: true, sentAt: true } }),
        prisma.aIJob.findMany({ select: { type: true, model: true, status: true, inputTokens: true, outputTokens: true, estimatedCost: true, createdAt: true } }),
      ]);

      const replied = leads.filter((lead) => Boolean(lead.replyStatus || lead.lastReplyAt));
      const interested = leads.filter((lead) => ["interested", "booking_intent"].includes(lead.replyStatus ?? "") || ["interested", "call_scheduled", "proposal_sent", "won"].includes(lead.status));
      const meetings = leads.filter((lead) => ["call_scheduled", "proposal_sent", "won"].includes(lead.status));
      const wins = leads.filter((lead) => lead.status === "won");
      const positiveReplyStatuses = new Set(["interested", "booking_intent", "question", "referral"]);

      const makeBreakdown = (keyFn: (lead: typeof leads[number]) => string) => {
        const map = new Map<string, { contacted: number; replied: number; positive: number; meetings: number; won: number }>();
        for (const lead of leads) {
          const key = keyFn(lead) || "unknown";
          const row = map.get(key) ?? { contacted: 0, replied: 0, positive: 0, meetings: 0, won: 0 };
          row.contacted++;
          if (lead.replyStatus || lead.lastReplyAt) row.replied++;
          if (positiveReplyStatuses.has(lead.replyStatus ?? "") || ["interested", "call_scheduled", "proposal_sent", "won"].includes(lead.status)) row.positive++;
          if (["call_scheduled", "proposal_sent", "won"].includes(lead.status)) row.meetings++;
          if (lead.status === "won") row.won++;
          map.set(key, row);
        }
        return Array.from(map.entries()).map(([key, row]) => ({ key, ...row, replyRate: pct(row.replied, row.contacted), positiveRate: pct(row.positive, row.contacted), meetingRate: pct(row.meetings, row.contacted), winRate: pct(row.won, row.contacted) })).sort((a, b) => b.contacted - a.contacted || b.replyRate - a.replyRate);
      };

      const problemMap = new Map<string, { contacted: number; replied: number; positive: number }>();
      for (const lead of leads) {
        const categories = new Set(lead.problems.filter((p) => p.outreachValue === "high" || p.outreachValue === "medium").map((p) => p.category));
        for (const category of categories) {
          const row = problemMap.get(category) ?? { contacted: 0, replied: 0, positive: 0 };
          row.contacted++;
          if (lead.replyStatus || lead.lastReplyAt) row.replied++;
          if (positiveReplyStatuses.has(lead.replyStatus ?? "") || ["interested", "call_scheduled", "proposal_sent", "won"].includes(lead.status)) row.positive++;
          problemMap.set(category, row);
        }
      }
      const byProblem = Array.from(problemMap.entries()).map(([key, row]) => ({ key, ...row, replyRate: pct(row.replied, row.contacted), positiveRate: pct(row.positive, row.contacted) })).sort((a, b) => b.contacted - a.contacted || b.replyRate - a.replyRate);

      const followupMap = new Map<number, { sent: number; leadsRepliedAfterTouch: number }>();
      for (const message of sentMessages) {
        const row = followupMap.get(message.sequenceNumber) ?? { sent: 0, leadsRepliedAfterTouch: 0 };
        row.sent++;
        followupMap.set(message.sequenceNumber, row);
      }
      for (const lead of leads) {
        const lastReplyAt = lead.lastReplyAt;
        if (!lastReplyAt) continue;
        const beforeReply = lead.outreachMessages
          .filter((m) => m.sentAt && m.sentAt <= lastReplyAt)
          .sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
        const lastTouch = beforeReply[0];
        if (lastTouch) {
          const row = followupMap.get(lastTouch.sequenceNumber) ?? { sent: 0, leadsRepliedAfterTouch: 0 };
          row.leadsRepliedAfterTouch++;
          followupMap.set(lastTouch.sequenceNumber, row);
        }
      }
      const followupPerformance = Array.from(followupMap.entries()).sort((a, b) => a[0] - b[0]).map(([sequenceNumber, row]) => ({ sequenceNumber, label: sequenceNumber === 1 ? "Initial" : `Follow-up ${sequenceNumber - 1}`, sent: row.sent, repliesAttributed: row.leadsRepliedAfterTouch, attributedReplyRate: pct(row.leadsRepliedAfterTouch, row.sent) }));

      const ai = jobs.reduce((acc, job) => {
        acc.calls++;
        if (job.status === "failed") acc.failed++;
        acc.inputTokens += job.inputTokens ?? 0;
        acc.outputTokens += job.outputTokens ?? 0;
        acc.estimatedCost += job.estimatedCost ?? 0;
        return acc;
      }, { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 });

      const byModelMap = new Map<string, { calls: number; inputTokens: number; outputTokens: number; estimatedCost: number }>();
      for (const job of jobs) {
        const row = byModelMap.get(job.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
        row.calls++; row.inputTokens += job.inputTokens ?? 0; row.outputTokens += job.outputTokens ?? 0; row.estimatedCost += job.estimatedCost ?? 0;
        byModelMap.set(job.model, row);
      }

      res.json({
        totals: {
          contactedLeads: leads.length,
          messagesSent: sentMessages.length,
          replies: replied.length,
          interested: interested.length,
          meetings: meetings.length,
          wins: wins.length,
          replyRate: pct(replied.length, leads.length),
          interestedRate: pct(interested.length, leads.length),
          meetingRate: pct(meetings.length, leads.length),
          winRate: pct(wins.length, leads.length),
        },
        ai: { ...ai, estimatedCost: Math.round(ai.estimatedCost * 100000) / 100000, costPerContactedLead: leads.length ? Math.round((ai.estimatedCost / leads.length) * 100000) / 100000 : 0, costPerReply: replied.length ? Math.round((ai.estimatedCost / replied.length) * 100000) / 100000 : 0, byModel: Array.from(byModelMap.entries()).map(([model, row]) => ({ model, ...row, estimatedCost: Math.round(row.estimatedCost * 100000) / 100000 })) },
        byNiche: makeBreakdown((lead) => lead.category || lead.keyword),
        byKeyword: makeBreakdown((lead) => lead.keyword),
        byAngle: makeBreakdown((lead) => lead.primaryOutreachAngle || lead.outreachMessages.find((m) => m.angle)?.angle || "unknown"),
        byPriority: makeBreakdown((lead) => bucketPriority(lead.priorityScore)),
        byProblem,
        followupPerformance,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
