import { SerpAdSchema, type SerpAd } from "./schemas.js";

export type { SerpAd };

function buildSerpAd(
  keyword: string,
  adSource: "paid_ad" | "local_organic",
  title?: string,
  link?: string,
  displayedLink?: string,
  businessName?: string,
  phone?: string,
  address?: string
): SerpAd | null {
  if (!link) return null;

  const fullLink =
    link.startsWith("http://") || link.startsWith("https://")
      ? link
      : `https://${link}`;

  if (fullLink.includes("google.com/localservices") || fullLink.includes("google.com/maps")) {
    console.log("[Serper] Skipping Google URL:", fullLink.slice(0, 100));
    return null;
  }

  const source = displayedLink ?? fullLink;
  const displayDomain = source
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0] ?? "";

  const result = SerpAdSchema.safeParse({
    keyword,
    adTitle: title ?? "",
    landingPageUrl: fullLink,
    displayDomain,
    adSource,
    ...(businessName && { businessName }),
    ...(phone && { phone }),
    ...(address && { address }),
    ...(title && { sourceTitle: title }),
  });

  if (!result.success) {
    console.log(`[Serper] buildSerpAd validation failed for link=${link}:`, result.error.issues);
    return null;
  }

  return result.data;
}

async function querySerperSearch(
  apiKey: string,
  keyword: string,
  location?: string
): Promise<SerpAd[]> {
  const body: Record<string, unknown> = {
    q: keyword,
    gl: "us",
    hl: "en",
    num: 20,
  };
  if (location) body.location = location;

  console.log(`[Serper] Searching: keyword="${keyword}", location="${location ?? ""}"`);

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Serper] Search API error ${response.status}: ${text}`);
    return [];
  }

  const data = (await response.json()) as Record<string, unknown>;

  const topLevelKeys = Object.keys(data);
  console.log(`[Serper] Response keys: ${topLevelKeys.join(", ")}`);

  const results: SerpAd[] = [];

  // Source A: Paid ads
  const ads = Array.isArray(data.ads) ? (data.ads as Record<string, unknown>[]) : [];
  let countAds = 0;
  for (const ad of ads) {
    const entry = buildSerpAd(
      keyword,
      "paid_ad",
      ad["title"] as string | undefined,
      ad["link"] as string | undefined,
      ad["domain"] as string | undefined,
      undefined,
      undefined,
      undefined
    );
    if (entry) { results.push(entry); countAds++; }
  }
  console.log(`[Serper] Source A (paid ads): ${countAds}`);

  // Source B: Places / local pack from search results
  const places = Array.isArray(data.places) ? (data.places as Record<string, unknown>[]) : [];
  let countPlaces = 0;
  for (const place of places) {
    const website = place["website"] as string | undefined;
    if (!website) continue;
    const entry = buildSerpAd(
      keyword,
      "local_organic",
      place["title"] as string | undefined,
      website,
      undefined,
      place["title"] as string | undefined,
      place["phoneNumber"] as string | undefined,
      place["address"] as string | undefined
    );
    if (entry) { results.push(entry); countPlaces++; }
  }
  console.log(`[Serper] Source B (places): ${countPlaces}`);

  return results;
}

async function querySerperPlaces(
  apiKey: string,
  keyword: string,
  location?: string
): Promise<SerpAd[]> {
  const body: Record<string, unknown> = {
    q: keyword,
    gl: "us",
    hl: "en",
    num: 20,
  };
  if (location) body.location = location;

  console.log(`[Serper] Places search: keyword="${keyword}", location="${location ?? ""}"`);

  const response = await fetch("https://google.serper.dev/places", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Serper] Places API error ${response.status}: ${text}`);
    return [];
  }

  const data = (await response.json()) as Record<string, unknown>;

  const results: SerpAd[] = [];

  const places = Array.isArray(data.places) ? (data.places as Record<string, unknown>[]) : [];
  let count = 0;
  for (const place of places) {
    const website = place["website"] as string | undefined;
    if (!website) continue;
    const entry = buildSerpAd(
      keyword,
      "local_organic",
      place["title"] as string | undefined,
      website,
      undefined,
      place["title"] as string | undefined,
      place["phoneNumber"] as string | undefined,
      place["address"] as string | undefined
    );
    if (entry) { results.push(entry); count++; }
  }
  console.log(`[Serper] Places results with website: ${count}`);

  return results;
}

export async function searchAds(keyword: string, location?: string): Promise<SerpAd[]> {
  try {
    const { env } = await import("./env.js");
    const apiKey = env.SERPER_API_KEY;

    const [searchResults, placesResults] = await Promise.all([
      querySerperSearch(apiKey, keyword, location),
      querySerperPlaces(apiKey, keyword, location),
    ]);

    console.log(`[Serper] searchAds search results: ${searchResults.length}, places results: ${placesResults.length}`);

    // Merge results, preferring paid_ad over local_organic for same domain
    const all = [...searchResults, ...placesResults];
    const byDomain = new Map<string, SerpAd>();

    for (const ad of all) {
      const key = ad.displayDomain.toLowerCase();
      const existing = byDomain.get(key);
      if (!existing) {
        byDomain.set(key, ad);
      } else if (ad.adSource === "paid_ad" && existing.adSource === "local_organic") {
        byDomain.set(key, ad);
      }
    }

    const deduped = Array.from(byDomain.values());
    console.log(`[Serper] searchAds total unique domains: ${deduped.length}`);
    return deduped;
  } catch (err) {
    console.error(`[Serper] searchAds error:`, err);
    return [];
  }
}
