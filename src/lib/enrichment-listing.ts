import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";
import { normalizePhone, searchResultSupportsLead, type EnrichmentIdentityContext } from "./enrichment-identity.js";

function listingQueries(context: EnrichmentIdentityContext): string[] {
  if (!context.businessName) return [];
  return [...new Set([
    context.address ? `"${context.businessName}" "${context.address}"` : "",
    `"${context.businessName}"`,
  ].filter(Boolean))];
}

export async function findIdentityVerifiedListingPhone(context: EnrichmentIdentityContext): Promise<string | undefined> {
  const env = getEnv();
  const verificationContext: EnrichmentIdentityContext = {
    domain: context.domain,
    ...(context.businessName && { businessName: context.businessName }),
    ...(context.address && { address: context.address }),
  };

  for (const q of listingQueries(verificationContext)) {
    try {
      const response = await fetchWithProviderBackoff(
        "https://google.serper.dev/places",
        {
          method: "POST",
          headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ q, gl: "us", hl: "en", num: 10 }),
        },
        "Serper contact revalidation",
      );
      if (!response.ok) continue;
      const data = await response.json() as Record<string, unknown>;
      const places = Array.isArray(data.places) ? data.places as Record<string, unknown>[] : [];
      for (const place of places) {
        const phone = normalizePhone(typeof place.phoneNumber === "string" ? place.phoneNumber : undefined);
        if (!phone) continue;
        const row = {
          title: String(place.title ?? ""),
          snippet: String(place.address ?? ""),
          link: String(place.website ?? ""),
        };
        if (searchResultSupportsLead(row, verificationContext)) return phone;
      }
    } catch { /* best-effort revalidation */ }
  }
  return undefined;
}
