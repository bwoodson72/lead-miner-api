import { Resend } from "resend";
import { type LeadRecord } from "./schemas.js";

export function formatReport(leads: LeadRecord[], keywords: string[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const keywordCount = keywords.length;
  const leadCount = leads.length;

  const lines: string[] = [
    `Lead Miner Run — ${date}`,
    "",
    `Keywords searched: ${keywordCount}`,
    `Leads found: ${leadCount}`,
    "",
  ];

  if (leadCount === 0) {
    lines.push("No slow sites found for the searched keywords.");
  } else {
    lines.push("Leads pushed to HubSpot. Summary:");
    lines.push("");

    for (const lead of leads) {
      const lcp = (lead.lcp / 1000).toFixed(1);
      const source = lead.adSource === "paid_ad" ? "Ad" : "Organic";
      lines.push(`  ${lead.domain} — Score: ${lead.performanceScore}, LCP: ${lcp}s [${source}]`);
    }

    lines.push("");
    lines.push("Review and start outreach in HubSpot.");
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
      subject: `Lead Miner: ${leads.length} leads found — ${new Date().toISOString().slice(0, 10)}`,
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
