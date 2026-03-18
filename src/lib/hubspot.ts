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

// ── SEARCH FOR EXISTING CONTACT BY DOMAIN ───────────────────

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
    return results.results[0].id;
  }
  return null;
}

// ── CREATE OR UPDATE CONTACT ────────────────────────────────

async function createContact(lead: LeadRecord): Promise<string> {
  const response = await hubspotFetch("/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        website: lead.domain,
        company: lead.domain,
        lighthouse_score: String(lead.performanceScore),
        lcp: String(Math.round(lead.lcp)),
        lead_keyword: lead.keyword,
        landing_page_url: lead.landingPageUrl,
        lifecyclestage: "lead",
      },
    }),
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
  const response = await hubspotFetch(`/crm/v3/objects/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        lighthouse_score: String(lead.performanceScore),
        lcp: String(Math.round(lead.lcp)),
        landing_page_url: lead.landingPageUrl,
      },
    }),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`[HubSpot] updateContact FAILED (${response.status}) for ${lead.domain}:`, JSON.stringify(data).slice(0, 500));
  }
  console.log(`[HubSpot] Updated contact ${contactId} for ${lead.domain}`);
}

// ── CREATE DEAL ─────────────────────────────────────────────

async function createDeal(
  contactId: string,
  lead: LeadRecord
): Promise<string> {
  const lcpSeconds = (lead.lcp / 1000).toFixed(1);
  const dealName = `${lead.domain} — Score ${lead.performanceScore}, LCP ${lcpSeconds}s`;

  const response = await hubspotFetch("/crm/v3/objects/deals", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        dealname: dealName,
        pipeline: PIPELINE_ID,
        dealstage: NEW_LEAD_STAGE_ID,
        description: `Found via "${lead.keyword}" search. Source: ${lead.adSource}. Landing page: ${lead.landingPageUrl}`,
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
    // Check if contact already exists
    const existingId = await findContactByDomain(lead.domain);

    let contactId: string;
    let action: "created" | "updated";

    if (existingId) {
      await updateContact(existingId, lead);
      contactId = existingId;
      action = "updated";
    } else {
      contactId = await createContact(lead);
      const dealId = await createDeal(contactId, lead);
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
