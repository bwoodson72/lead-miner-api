import { SerpAdSchema, type SerpAd } from "./schemas.js";

export type { SerpAd };

type SearchMarket = {
  queryLabel: string;
  serpApiLocation: string;
};

// Broad searches such as "roofer" are local-intent queries in Google. Rather
// than letting one arbitrary local result define the whole run, fan broad
// searches across the markets we actually prospect. The order keeps the first
// results close to Granbury/DFW, then expands across Texas as needed.
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
  { queryLabel: "Denton TX", serpApiLocation: "Denton, Texas, United States" },
  { queryLabel: "Wichita Falls TX", serpApiLocation: "Wichita Falls, Texas, United States" },
  { queryLabel: "Abilene TX", serpApiLocation: "Abilene, Texas, United States" },
  { queryLabel: "Tyler TX", serpApiLocation: "Tyler, Texas, United States" },
  { queryLabel: "Longview TX", serpApiLocation: "Longview, Texas, United States" },
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
  market?: SearchMarket
): Promise<SerpAd[]> {
  const q = market ? `${keyword} ${market.queryLabel}` : keyword;
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
    console.error(`[SerpApi] ${keyword} @ ${market.serpApiLocation}: ${data["error"]}`);
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

function explicitMarket(location: string): SearchMarket {
  const queryLabel = location
    .replace(/,?\s*United States$/i, "")
    .replace(/,?\s*Texas$/i, " TX")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { queryLabel, serpApiLocation: location.trim() };
}

async function searchOneMarket(
  keyword: string,
  market: SearchMarket,
  serperKey: string,
  serpApiKey?: string
): Promise<SerpAd[]> {
  const [organic, paid] = await Promise.all([
    querySerperPlaces(serperKey, keyword, market),
    serpApiKey ? querySerpApiAds(serpApiKey, keyword, market) : Promise.resolve([]),
  ]);

  return [...paid, ...organic];
}

export async function searchAds(
  keyword: string,
  location?: string,
  targetDomains = 20
): Promise<SerpAd[]> {
  try {
    const { env } = await import("./env.js");
    const byDomain = new Map<string, SerpAd>();

    if (!env.SERPAPI_KEY) {
      console.warn(`[SerpApi] SERPAPI_KEY missing; paid ads will be skipped`);
    }

    // Explicit override always means one market.
    if (location?.trim()) {
      mergeByDomain(
        byDomain,
        await searchOneMarket(
          keyword,
          explicitMarket(location),
          env.SERPER_API_KEY,
          env.SERPAPI_KEY
        )
      );
    } else {
      // A keyword that already names one of our configured markets should also
      // remain focused rather than fan out statewide.
      const embeddedMarket = marketFromKeyword(keyword);

      if (embeddedMarket) {
        mergeByDomain(
          byDomain,
          await searchOneMarket(
            keyword,
            embeddedMarket,
            env.SERPER_API_KEY,
            env.SERPAPI_KEY
          )
        );
      } else {
        // Broad keyword: fan out until discovery has enough headroom to survive
        // later franchise filtering and cross-keyword dedupe.
        const discoveryTarget = Math.max(
          targetDomains,
          targetDomains + Math.max(20, Math.ceil(targetDomains * 0.25))
        );

        for (const market of BROAD_SEARCH_MARKETS) {
          const marketResults = await searchOneMarket(
            keyword,
            market,
            env.SERPER_API_KEY,
            env.SERPAPI_KEY
          );
          mergeByDomain(byDomain, marketResults);

          console.log(
            `[Search] broad ${keyword}: ${byDomain.size}/${discoveryTarget} unique domains after ${market.queryLabel}`
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
