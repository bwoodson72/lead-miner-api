import { SerpAdSchema, type SerpAd } from "./schemas.js";

export type { SerpAd };

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function buildResult(
  keyword: string,
  adSource: "paid_ad" | "local_organic",
  title?: string,
  link?: string,
  businessName?: string,
  phone?: string,
  address?: string
): SerpAd | null {
  if (!link) return null;

  const fullLink =
    link.startsWith("http://") || link.startsWith("https://")
      ? link
      : `https://${link}`;

  if (
    fullLink.includes("google.com/localservices") ||
    fullLink.includes("google.com/maps")
  ) {
    return null;
  }

  const displayDomain = domainFromUrl(fullLink);
  if (!displayDomain) return null;

  const parsed = SerpAdSchema.safeParse({
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

  if (!parsed.success) {
    console.warn(`[Search] Invalid result for ${fullLink}`);
    return null;
  }

  return parsed.data;
}

function inferLocation(results: SerpAd[]): string | undefined {
  for (const result of results) {
    if (!result.address) continue;

    const normalized = result.address
      .replace(/,\s*(USA|United States)$/i, "")
      .trim();
    const parts = normalized
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length < 2) continue;

    const city = parts.at(-2);
    const stateZip = parts.at(-1) ?? "";
    const match = stateZip.match(
      /^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/i
    );

    if (!city || !match?.[1]) continue;

    const stateCode = match[1].toUpperCase();
    return `${city}, ${STATE_NAMES[stateCode] ?? stateCode}, United States`;
  }

  return undefined;
}

async function querySerperPlaces(
  apiKey: string,
  keyword: string
): Promise<SerpAd[]> {
  const response = await fetch("https://google.serper.dev/places", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: keyword,
      gl: "us",
      hl: "en",
      num: 20,
    }),
  });

  if (!response.ok) {
    console.error(
      `[Serper] Places error ${response.status}: ${await response.text()}`
    );
    return [];
  }

  const data = (await response.json()) as Record<string, unknown>;
  const places = Array.isArray(data.places)
    ? (data.places as Record<string, unknown>[])
    : [];

  const results: SerpAd[] = [];

  for (const place of places) {
    const entry = buildResult(
      keyword,
      "local_organic",
      place["title"] as string | undefined,
      place["website"] as string | undefined,
      place["title"] as string | undefined,
      place["phoneNumber"] as string | undefined,
      place["address"] as string | undefined
    );

    if (entry) results.push(entry);
  }

  console.log(`[Serper] ${keyword}: ${results.length} organic businesses`);
  return results;
}

async function querySerpApiAds(
  apiKey: string,
  keyword: string,
  location: string
): Promise<SerpAd[]> {
  const params = new URLSearchParams({
    engine: "google_ads",
    q: keyword,
    location,
    hl: "en",
    device: "mobile",
    api_key: apiKey,
  });

  const response = await fetch(
    `https://serpapi.com/search.json?${params.toString()}`
  );

  if (!response.ok) {
    console.error(
      `[SerpApi] Ads error ${response.status}: ${await response.text()}`
    );
    return [];
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (typeof data["error"] === "string") {
    console.error(`[SerpApi] ${keyword}: ${data["error"]}`);
    return [];
  }

  const ads = Array.isArray(data.ads)
    ? (data.ads as Record<string, unknown>[])
    : [];

  const results: SerpAd[] = [];

  for (const ad of ads) {
    const entry = buildResult(
      keyword,
      "paid_ad",
      ad["title"] as string | undefined,
      ad["link"] as string | undefined,
      ad["source"] as string | undefined,
      ad["phone"] as string | undefined
    );

    if (entry) results.push(entry);
  }

  const localAds = data["local_ads"] as Record<string, unknown> | undefined;
  const lsaCount =
    localAds && Array.isArray(localAds["ads"])
      ? (localAds["ads"] as unknown[]).length
      : 0;

  console.log(
    `[SerpApi] ${keyword} @ ${location}: ${results.length} paid search ads; ${lsaCount} local service ads skipped`
  );

  return results;
}

export async function searchAds(
  keyword: string,
  location?: string
): Promise<SerpAd[]> {
  try {
    const { env } = await import("./env.js");

    const organic = await querySerperPlaces(
      env.SERPER_API_KEY,
      keyword
    );

    const searchLocation =
      location?.trim() || inferLocation(organic);

    let paid: SerpAd[] = [];

    if (!env.SERPAPI_KEY) {
      console.warn(
        `[SerpApi] SERPAPI_KEY missing; paid ads skipped for ${keyword}`
      );
    } else if (!searchLocation) {
      console.warn(
        `[SerpApi] Could not infer location; paid ads skipped for ${keyword}`
      );
    } else {
      paid = await querySerpApiAds(
        env.SERPAPI_KEY,
        keyword,
        searchLocation
      );
    }

    const byDomain = new Map<string, SerpAd>();

    for (const result of [...paid, ...organic]) {
      const key =
        domainFromUrl(result.landingPageUrl) ??
        result.displayDomain.toLowerCase();

      const existing = byDomain.get(key);

      if (
        !existing ||
        (result.adSource === "paid_ad" &&
          existing.adSource === "local_organic")
      ) {
        byDomain.set(key, result);
      }
    }

    const deduped = Array.from(byDomain.values());
    const paidCount = deduped.filter(
      (result) => result.adSource === "paid_ad"
    ).length;

    console.log(
      `[Search] ${keyword}: ${paidCount} paid, ${
        deduped.length - paidCount
      } organic unique domains`
    );

    return deduped;
  } catch (err) {
    console.error(`[Search] ${keyword}:`, err);
    return [];
  }
}
