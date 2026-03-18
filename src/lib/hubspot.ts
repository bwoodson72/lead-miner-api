import { type LeadRecord } from "./schemas.js";

// ── CONFIG ──────────────────────────────────────────────────
// Free tier default pipeline with custom stages.
// Stage IDs from HubSpot:
//   New Lead:      3364020959
//   Contacted:     3364020960
//   Responded:     3364020961
//   Proposal Sent: 3364020962
//   Closed Won:    closedwon
//   Closed Lost:   closedlost
const PIPELINE_ID = "default";
const NEW_LEAD_STAGE_ID = "3364020959";

const BASE_URL = "https://api.hubapi.com";

async function getToken(): Promise<string> {
  const { env } = await import("./env.js");
  return env.HUBSPOT_ACCESS_TOKEN;
}

async function hubspotFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getToken();
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
}

// ── SEARCH FOR EXISTING CONTACT ─────────────────────────────

async function findContactByEmail(
  email: string
): Promise<string | null> {
  const response = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "email",
              operator: "EQ",
              value: email,
            },
          ],
        },
      ],
      properties: ["email"],
      limit: 1,
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`[HubSpot] findContactByEmail FAILED (${response.status}) for ${email}:`, JSON.stringify(data).slice(0, 500));
    return null;
  }
  const results = data as { total: number; results: { id: string }[] };
  if (results.total > 0 && results.results[0]) {
    console.log(`[HubSpot] Found existing contact by email: ${email}`);
    return results.results[0].id;
  }
  return null;
}

async function findContactByPhone(
  phone: string
): Promise<string | null> {
  const response = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "phone",
              operator: "EQ",
              value: phone,
            },
          ],
        },
      ],
      properties: ["phone"],
      limit: 1,
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`[HubSpot] findContactByPhone FAILED (${response.status}) for ${phone}:`, JSON.stringify(data).slice(0, 500));
    return null;
  }
  const results = data as { total: number; results: { id: string }[] };
  if (results.total > 0 && results.results[0]) {
    console.log(`[HubSpot] Found existing contact by phone: ${phone}`);
    return results.results[0].id;
  }
  return null;
}

async function findContactByDomain(
  domain: string
): Promise<string | null> {
  const response = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "website",
              operator: "CONTAINS_TOKEN",
              value: domain,
            },
          ],
        },
      ],
      properties: ["website", "firstname", "lastname", "email"],
      limit: 1,
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`[HubSpot] findContactByDomain FAILED (${response.status}) for ${domain}:`, JSON.stringify(data).slice(0, 500));
    return null;
  }
  const results = data as { total: number; results: { id: string }[] };
  if (results.total > 0 && results.results[0]) {
    console.log(`[HubSpot] Found existing contact by domain: ${domain}`);
    return results.results[0].id;
  }
  return null;
}

async function findContact(lead: LeadRecord): Promise<string | null> {
  // Try email first (most reliable)
  if (lead.email) {
    const contactId = await findContactByEmail(lead.email);
    if (contactId) return contactId;
  }

  // Try phone second
  if (lead.phone) {
    const contactId = await findContactByPhone(lead.phone);
    if (contactId) return contactId;
  }

  // Fall back to domain
  return await findContactByDomain(lead.domain);
}

// ── CREATE OR UPDATE CONTACT ────────────────────────────────

async function createContact(lead: LeadRecord): Promise<string> {
  const properties: Record<string, string> = {
    website: lead.domain,
    company: lead.businessName || lead.domain,
    lighthouse_score: String(lead.performanceScore),
    lcp: String(Math.round(lead.lcp)),
    leadkeyword: lead.keyword,
    landing_page_url: lead.landingPageUrl,
    lifecyclestage: "lead",
  };

  // Use HubSpot built-in fields for enriched contact info
  if (lead.phone) properties.phone = lead.phone;
  if (lead.email) properties.email = lead.email;
  if (lead.address) properties.address = lead.address;

  const response = await hubspotFetch("/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({ properties }),
  });

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`[HubSpot] createContact FAILED (${response.status}) for ${lead.domain}:`, JSON.stringify(data).slice(0, 500));
    throw new Error(`HubSpot createContact failed: ${response.status}`);
  }
  const contactId = data.id as string;
  console.log(`[HubSpot] Created contact ${contactId} for ${lead.domain}`);
  return contactId;
}

async function updateContact(
  contactId: string,
  lead: LeadRecord
): Promise<void> {
  const properties: Record<string, string> = {
    lighthouse_score: String(lead.performanceScore),
    lcp: String(Math.round(lead.lcp)),
    landing_page_url: lead.landingPageUrl,
  };

  // Update built-in fields if enrichment found new data
  if (lead.phone) properties.phone = lead.phone;
  if (lead.email) properties.email = lead.email;
  if (lead.address) properties.address = lead.address;
  if (lead.businessName) properties.company = lead.businessName;

  const response = await hubspotFetch(`/crm/v3/objects/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`[HubSpot] updateContact FAILED (${response.status}) for ${lead.domain}:`, JSON.stringify(data).slice(0, 500));
    return;
  }
  console.log(`[HubSpot] Updated contact ${contactId} for ${lead.domain}`);
}

// ── BUILD LEAD SUMMARY ──────────────────────────────────────

function buildLeadSummary(lead: LeadRecord): string {
  const lines: string[] = [];

  // Header
  lines.push("=== LEAD SUMMARY ===");
  lines.push("");

  // Business info
  lines.push(`Domain: ${lead.domain}`);
  if (lead.businessName) lines.push(`Business: ${lead.businessName}`);
  lines.push("");

  // Search source
  lines.push(`Keyword: "${lead.keyword}"`);
  lines.push(`Ad Source: ${lead.adSource}`);
  if (lead.sourceTitle) lines.push(`Source Title: ${lead.sourceTitle}`);
  lines.push(`Landing Page: ${lead.landingPageUrl}`);
  lines.push("");

  // PageSpeed metrics
  lines.push("--- PageSpeed Insights ---");
  lines.push(`Performance Score: ${lead.performanceScore}/100`);
  lines.push(`LCP (Largest Contentful Paint): ${(lead.lcp / 1000).toFixed(2)}s`);
  lines.push(`CLS (Cumulative Layout Shift): ${lead.cls.toFixed(3)}`);
  lines.push(`TBT (Total Blocking Time): ${Math.round(lead.tbt)}ms`);
  if (lead.pagespeedTestedAt) {
    lines.push(`Tested: ${new Date(lead.pagespeedTestedAt).toLocaleString()}`);
  }
  if (lead.pagespeedReportUrl) {
    lines.push(`Report: ${lead.pagespeedReportUrl}`);
  }
  lines.push("");

  // Contact info
  if (lead.email || lead.phone || lead.contactPageUrl || lead.address) {
    lines.push("--- Contact Information ---");
    if (lead.email) lines.push(`Email: ${lead.email}`);
    if (lead.phone) lines.push(`Phone: ${lead.phone}`);
    if (lead.address) lines.push(`Address: ${lead.address}`);
    if (lead.contactPageUrl) lines.push(`Contact Page: ${lead.contactPageUrl}`);
    lines.push("");
  }

  // Enrichment status
  if (lead.enrichmentStatus) {
    lines.push(`Enrichment: ${lead.enrichmentStatus}`);
    if (lead.enrichmentNotes) {
      lines.push(`Notes: ${lead.enrichmentNotes}`);
    }
  }

  return lines.join("\n");
}

// ── CREATE DEAL ─────────────────────────────────────────────

async function createDeal(
  contactId: string,
  lead: LeadRecord
): Promise<string> {
  const lcpSeconds = (lead.lcp / 1000).toFixed(1);
  const businessLabel = lead.businessName || lead.domain;
  const dealName = `${businessLabel} — Score ${lead.performanceScore}, LCP ${lcpSeconds}s`;

  const response = await hubspotFetch("/crm/v3/objects/deals", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        dealname: dealName,
        pipeline: PIPELINE_ID,
        dealstage: NEW_LEAD_STAGE_ID,
        description: buildLeadSummary(lead),
      },
      associations: [
        {
          to: { id: contactId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 3, // deal-to-contact
            },
          ],
        },
      ],
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`[HubSpot] createDeal FAILED (${response.status}) for ${lead.domain}:`, JSON.stringify(data).slice(0, 500));
    throw new Error(`HubSpot createDeal failed: ${response.status}`);
  }
  const dealId = data.id as string;
  console.log(`[HubSpot] Created deal ${dealId} for ${lead.domain}`);
  return dealId;
}

// ── CREATE NOTE ─────────────────────────────────────────────

async function createNote(
  contactId: string,
  lead: LeadRecord
): Promise<string | null> {
  try {
    const response = await hubspotFetch("/crm/v3/objects/notes", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date().getTime(),
          hs_note_body: buildLeadSummary(lead),
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: 202, // note-to-contact
              },
            ],
          },
        ],
      }),
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`[HubSpot] createNote FAILED (${response.status}) for ${lead.domain}:`, JSON.stringify(data).slice(0, 500));
      return null;
    }
    const noteId = data.id as string;
    console.log(`[HubSpot] Created note ${noteId} for ${lead.domain}`);
    return noteId;
  } catch (err) {
    console.error(`[HubSpot] createNote error for ${lead.domain}:`, err);
    return null;
  }
}

// ── PUBLIC: PUSH LEAD TO HUBSPOT ────────────────────────────

export type HubSpotResult = {
  domain: string;
  action: "created" | "updated" | "failed";
  contactId?: string;
  dealId?: string;
  error?: string;
};

export async function pushLeadToHubSpot(
  lead: LeadRecord
): Promise<HubSpotResult> {
  try {
    // Check if contact already exists (email → phone → domain)
    const existingId = await findContact(lead);

    let contactId: string;
    let action: "created" | "updated";

    if (existingId) {
      await updateContact(existingId, lead);
      contactId = existingId;
      action = "updated";

      // Add note to updated contacts for audit trail
      await createNote(contactId, lead);
    } else {
      contactId = await createContact(lead);
      const dealId = await createDeal(contactId, lead);

      // Add note to new contacts for detailed audit
      await createNote(contactId, lead);

      action = "created";
      return { domain: lead.domain, action, contactId, dealId };
    }

    return { domain: lead.domain, action, contactId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[HubSpot] Failed to push ${lead.domain}:`, message);
    return { domain: lead.domain, action: "failed", error: message };
  }
}

export async function pushLeadsToHubSpot(
  leads: LeadRecord[]
): Promise<HubSpotResult[]> {
  const results: HubSpotResult[] = [];
  for (const lead of leads) {
    const result = await pushLeadToHubSpot(lead);
    results.push(result);
  }
  return results;
}
