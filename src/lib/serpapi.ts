import { SerpAdSchema, type SerpAd } from "./schemas.js";

export type { SerpAd };

type SearchMarket = {
  queryLabel: string;
  serpApiLocation: string;
};

const BROAD_SEARCH_MARKETS: SearchMarket[] = [
  { queryLabel: "Granbury TX", serpApiLocation: "Granbury, Texas, United States" },
  { queryLabel: "Fort Worth TX", serpApiLocation: "Fort Worth, Texas, United States" },
  { queryLabel: "Weatherford TX", serpApiLocation: "Weatherford, Texas, United States" },
  { queryLabel: "Cleburne TX", serpApiLocation: "Cleburne, Texas, United States" },
  { queryLabel: "Burleson TX", serpApiLocation: "Burleson, Texas, United States" },
  { queryLabel: "Mansfield TX", serpApiLocation: "Mansfield, Texas, United States" },
  { queryLabel: "Arlington TX", serpApiLocation: "Arlington, Texas, United States" },
  { queryLabel: "Dallas TX", serpApiLocation: "Dallas, Texas, United States" },
  { queryLabel: "Aledo TX", serpApiLocation: "Aledo, Texas, United States" },
  { queryLabel: "Azle TX", serpApiLocation: "Azle, Texas, United States" },
  { queryLabel: "Crowley TX", serpApiLocation: "Crowley, Texas, United States" },
  { queryLabel: "Glen Rose TX", serpApiLocation: "Glen Rose, Texas, United States" },
  { queryLabel: "Stephenville TX", serpApiLocation: "Stephenville, Texas, United States" },
  { queryLabel: "Mineral Wells TX", serpApiLocation: "Mineral Wells, Texas, United States" },
  { queryLabel: "Waxahachie TX", serpApiLocation: "Waxahachie, Texas, United States" },
  { queryLabel: "Midlothian TX", serpApiLocation: "Midlothian, Texas, United States" },
  { queryLabel: "Cedar Hill TX", serpApiLocation: "Cedar Hill, Texas, United States" },
  { queryLabel: "Corsicana TX", serpApiLocation: "Corsicana, Texas, United States" },
  { queryLabel: "Hillsboro TX", serpApiLocation: "Hillsboro, Texas, United States" },
  { queryLabel: "Ennis TX", serpApiLocation: "Ennis, Texas, United States" },
  { queryLabel: "Denton TX", serpApiLocation: "Denton, Texas, United States" },
  { queryLabel: "Wichita Falls TX", serpApiLocation: "Wichita Falls, Texas, United States" },
  { queryLabel: "Abilene TX", serpApiLocation: "Abilene, Texas, United States" },
  { queryLabel: "San Angelo TX", serpApiLocation: "San Angelo, Texas, United States" },
  { queryLabel: "Brownwood TX", serpApiLocation: "Brownwood, Texas, United States" },
  { queryLabel: "Tyler TX", serpApiLocation: "Tyler, Texas, United States" },
  { queryLabel: "Longview TX", serpApiLocation: "Longview, Texas, United States" },
  { queryLabel: "Lufkin TX", serpApiLocation: "Lufkin, Texas, United States" },
  { queryLabel: "Nacogdoches TX", serpApiLocation: "Nacogdoches, Texas, United States" },
  { queryLabel: "Temple TX", serpApiLocation: "Temple, Texas, United States" },
  { queryLabel: "Killeen TX", serpApiLocation: "Killeen, Texas, United States" },
  { queryLabel: "Waco TX", serpApiLocation: "Waco, Texas, United States" },
  { queryLabel: "Austin TX", serpApiLocation: "Austin, Texas, United States" },
  { queryLabel: "San Antonio TX", serpApiLocation: "San Antonio, Texas, United States" },
  { queryLabel: "Houston TX", serpApiLocation: "Houston, Texas, United States" },
];

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

function marketFromKeyword(keyword: string): SearchMarket | undefined {
  const normalized = keyword.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  return BROAD_SEARCH_MARKETS.find((market) => {
    const city = market.queryLabel.toLowerCase().replace(/\s+tx$/, "");
    return normalized.includes(city);
  });
}

function normalizeLocation(location: string): string {
  const trimmed = location.trim();
  if (/united states$/i.test(trimmed)) return trimmed;
  return `${trimmed}, United States`;
}

function parseInlineLocation(keyword: string): { query: string; location?: string } {
  const commaIndex = keyword.indexOf(",");
  if (commaIndex < 0) return { query: keyword.trim() };

  const query = keyword.slice(0, commaIndex).trim();
  const location = keyword.slice(commaIndex + 1).trim();

  if (!query || !location) return { query: keyword.trim() };
  return { query, location: normalizeLocation(location) };
}

function mergeByDomain(target: Map<string, SerpAd>, results: SerpAd[]): void {
  for (const result of results) {
    const key =
      domainFromUrl(result.landingPageUrl) ?? result.displayDomain.toLowerCase();
    const existing = target.get(key);

    if (
      !existing ||
      (result.adSource === "paid_ad" && existing.adSource === "local_organic")
    ) {
      target.set(key, result);
    }
  }
}

async function querySerperPlaces(
  apiKey: string,
  keyword: string,
  market?: SearchMarket,
  appendMarket = true
): Promise<SerpAd[]> {
  const q = market && appendMarket ? `${keyword} ${market.queryLabel}` : keyword;
  const response = await fetch("https://google.serper.dev/places", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q,
      gl: "us",
      hl: "en",
      num: 20,
    }),
  });

  if (!response.ok) {
    console.error(
      `[Serper] Places error ${response.status} for ${q}: ${await response.text()}`
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

  console.log(`[Serper] ${q}: ${results.length} organic businesses with websites`);
  return results;
}

async function querySerpApiAds(
  apiKey: string,
  keyword: string,
  market: SearchMarket
): Promise<SerpAd[]> {
  const params = new URLSearchParams({
    engine: "google_ads",
    q: keyword,
    location: market.serpApiLocation,
    hl: "en",
    device: "mobile",
    api_key: apiKey,
  });

  const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`);

  if (!response.ok) {
    console.error(
      `[SerpApi] Ads error ${response.status} for ${market.serpApiLocation}: ${await response.text()}`
    );
    return [];
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data["error"] === "string") {
    console.error( `[SerpApi] ${keyword} @ ${market.serpApiLocation}: ${data["error"]}`);
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
    `[SerpApi] ${keyword} @ ${market.serpApiLocation}: ${results.length} paid search ads; ${lsaCount} local service ads skipped`
  );
  return results;
}

async function resolveSerpApiMapLl(location: string): Promise<string | undefined> {
  const params = new URLSearchParams({ q: location, limit: "10" });
  const response = await fetch(
    `https://serpapi.com/locations.json?${params.toString()}`
  );

  if (!response.ok) {
    console.error(
      `[SerpApi] Locations error ${response.status} for ${location}: ${await response.text()}`
    );
    return undefined;
  }

  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) return undefined;

  const candidates = (data as Record<string, unknown>[]).filter((candidate) => {
    const gps = candidate["gps"];
    return Array.isArray(gps) && gps.length >= 2;
  });

  const selected =
    candidates.find(
      (candidate) =>
        candidate["country_code"] === "US" && candidate["target_type"] === "City"
    ) ??
    candidates.find((candidate) => candidate["country_code"] === "US") ??
    candidates[0];

  if (!selected) {
    console.error(`[SerpApi] No GPS location found for ${location}`);
    return undefined;
  }

  const gps = selected["gps"] as unknown[];
  const longitude = gps[0];
  const latitude = gps[1];

  if (typeof longitude !== "number" || typeof latitude !== "number") {
    console.error(SerpApi] Invalid GPS location for ${location}`);
    return undefined;
  }

  const ll = `@${latitude},${longitude},13z`;
  console.log(`[SerpApi] Resolved ${location} to ${ll}`);
  return ll;
}

async function querySerpApiMapBusinesses(
  apiKey: string,
  keyword: string,
  market: SearchMarket,
  targetDomains: number
): Promise<SerpAd[]> {
  const byDomain = new Map<string, SerpAd>();
  const ll = await resolveSerpApiMapLl(market.serpApiLocation);

  if (!ll) return [];

  for (let start = 0; start <= 100 && byDomain.size < targetDomains; start += 20) {
    const params = new URLSearchParams({
      engine: "google_maps",
      type: "search",
      q: keyword,
      ll,
      hl: "en",
      api_key: apiKey,
      start: String(start),
    });

    const response = await fetch(
      `https://serpapi.com/search.json?${params.toString()}`
    );

    if (!response.ok) {
      console.error(
        `[SerpApi] Maps error ${response.status} for ${keyword} @ ${market.serpApiLocation}: ${await response.text()}`
      );
      break;
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data["error"] === "string") {
      console.error(
        `[SerpApi] Maps ${keyword} @ ${market.serpApiLocation}: ${data["error"]}`
      );
      break;
    }

    const localResults = Array.isArray(data["local_results"])
      ? (data["local_results"] as Record<string, unknown>[])
      : [];

    for (const place of localResults) {
      const links = place["links"] as Record<string, unknown> | undefined;
      const website =
        typeof place["website"] === "string"
          ? (place["website"] as string)
          : typeof links?.["website"] === "string"
            ? (links["website"] as string)
            : undefined;

      const entry = buildResult(
        keyword,
        "local_organic",
        place["title"] as string | undefined,
        website,
        place["title"] as string | undefined,
        place["phone"] as string | undefined,
        place["address"] as string | undefined
      );

      if (!entry) continue;
      const domain = domainFromUrl(entry.landingPageUrl);
      if (domain) byDomain.set(domain, entry);
    }

    console.log(
      `[SerpApi] Maps ${keyword} @ ${market.serpApiLocation}: ${byDomain.size}/${targetDomains} businesses with websites after offset ${start}`
    );

    if (localResults.length === 0) break;
  }

  return Array.from(byDomain.values());
}

function explicitMarket(location: string): SearchMarket {
  const normalizedLocation = normalizeLocation(location);
  const queryLabel = normalizedLocation
    .replace(/,?\s*United States$/i, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { queryLabel, serpApiLocation: normalizedLocation };
}

async function searchOneMarket(
  keyword: string,
  market: SearchMarket,
  serperKey: string,
  serpApiKey?: string,
  appendMarket = true
): Promise<SerpAd[]> {
  const [organic, paid] = await Promise.all([
    querySerperPlaces(serperKey, keyword, market, appendMarket),
    serpApiKey ? querySerpApiAds(serpApiKey, keyword, market) : Promise.resolve([]),
  ]);

  return [...paid, ...organic];
}

async function searchLocalizedMarket(
  keyword: string,
  market: SearchMarket,
  serperKey: string,
  serpApiKey: string | undefined,
  discoveryTarget: number,
  appendMarket = true
): Promise<SerpAd[]> {
  if (!serpApiKey) {
    console.warn(
      `[SerpApi] SERPAPI_KEY missing; localized discovery falls back to Serper Places`
    );
    return searchOneMarket(keyword, market, serperKey, undefined, appendMarket);
  }

  const [serperBusinesses, mapBusinesses, paid] = await Promise.all([
    querySerperPlaces(serperKey, keyword, market, appendMarket),
    querySerpApiMapBusinesses(serpApiKey, keyword, market, discoveryTarget),
    querySerpApiAds(serpApiKey, keyword, market),
  ]);

  return [...paid, ...mapBusinesses, ...serperBusinesses];
}

export async function searchAds(
  keyword: string,
  location?: string,
  targetDomains = 20
): Promise<SerpAd[]> {
  try {
    const { env } = await import("./env.js");
    const byDomain = new Map<string, SerpAd>();
    const discoveryTarget =
      targetDomains + Math.max(20, Math.ceil(targetDomains * 0.25));

    const inline = parseInlineLocation(keyword);
    const searchKeyword = inline.query;
    const requestedLocation = location?.trim() || inline.location;

    if (!env.SERPAPI_KEY) {
      console.warn(`[SerpApi] SERPAPI_KEY missing; paid ads will be skipped`);
    }

    if (requestedLocation) {
      const market = explicitMarket(requestedLocation);
      mergeByDomain(
        byDomain,
        await searchLocalizedMarket(
          searchKeyword,
          market,
          env.SERPER_API_KEY,
          env.SERPAPI_KEY,
          discoveryTarget,
          true
        )
      );
    } else {
      const embeddedMarket = marketFromKeyword(searchKeyword);

      if (embeddedMarket) {
        mergeByDomain(
          byDomain,
          await searchLocalizedMarket(
            searchKeyword,
            embeddedMarket,
            env.SERPER_API_KEY,
            env.SERPAPI_KEY,
            discoveryTarget,
            false
          )
        );
      } else {
        for (const market of BROAD_SEARCH_MARKETS) {
          const marketResults = await searchOneMarket(
            searchKeyword,
            market,
            env.SERPER_API_KEY,
            env.SERPAPI_KEY,
            true
          );
          mergeByDomain(byDomain, marketResults);

          console.log(
            `[Search] broad ${searchKeyword}: ${byDomain.size}/${discoveryTarget} unique domains after ${market.queryLabel}`
          );

          if (byDomain.size >= discoveryTarget) break;
        }
      }
    }

    const deduped = Array.from(byDomain.values());
    const paidCount = deduped.filter((result) => result.adSource === "paid_ad").length;

    console.log(
      `[Search] ${keyword}: ${paidCount} paid, ${deduped.length - paidCount} organic unique domains`
    );
    return deduped;
  } catch (err) {
    console.error(`[Search] ${keyword}:`, err);
    return [];
  }
}
