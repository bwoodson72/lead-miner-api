import { Resend } from "resend";
import { type LeadRecord } from "./schemas.js";

export function formatReport(leads: LeadRecord[], keywords: string[]): string {
  if (leads.length === 0) {
    return "No slow landing pages found for the searched keywords.";
  }

  const date = new Date().toISOString().slice(0, 10);
  const keywordList = keywords.join(", ");

  const lines: string[] = [
    `Lead Report — ${date}`,
    `Keywords: ${keywordList}`,
    "",
  ];

  const byKeyword = new Map<string, LeadRecord[]>();
  for (const lead of leads) {
    const group = byKeyword.get(lead.keyword) ?? [];
    group.push(lead);
    byKeyword.set(lead.keyword, group);
  }

  for (const [keyword, group] of byKeyword) {
    lines.push(`--- ${keyword} ---`);
    for (const lead of group) {
      const lcp = (lead.lcp / 1000).toFixed(1);
      const cls = lead.cls.toFixed(2);
      const tbt = Math.round(lead.tbt);
      lines.push(`  Domain:  ${lead.domain}`);
      lines.push(`  URL:     ${lead.landingPageUrl}`);
      lines.push(`  Score:   ${lead.performanceScore}`);
      lines.push(`  LCP:     ${lcp}s`);
      lines.push(`  CLS:     ${cls}`);
      lines.push(`  TBT:     ${tbt}ms`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export async function sendReport(
  leads: LeadRecord[],
  keywords: string[],
  recipientEmail: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { env } = await import("./env.js");
    const resend = new Resend(env.RESEND_API_KEY);

    console.log("[Email] Sending report to:", recipientEmail, "with", leads.length, "leads");

    const { error } = await resend.emails.send({
      from: "Lead Miner <leads@brianwoodson.dev>",
      to: recipientEmail,
      subject: "Lead Report: Slow Ad Landing Pages",
      text: formatReport(leads, keywords),
    });

    if (error) {
      console.error("[Email] Resend error:", error.message);
      return { success: false, error: error.message };
    }

    console.log("[Email] Report sent successfully to:", recipientEmail);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Email] Send failed:", message);
    return { success: false, error: message };
  }
}
