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
    console.log("[SerpApi] Skipping Google URL:", fullLink.slice(0, 100));
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
    console.log(`[SerpApi] buildSerpAd validation failed for link=${link}:`, result.error.issues);
    return null;
  }

  return result.data;
}

async function queryGoogleSearch(
  apiKey: string,
  keyword: string,
  location?: string
): Promise<SerpAd[]> {
  const params = new URLSearchParams({
    engine: "google",
    q: keyword,
    api_key: apiKey,
    num: "20",
    ...(location ? { location } : {}),
  });

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  console.log(`[SerpApi] queryGoogleSearch fetching: engine=google, keyword="${keyword}", location="${location ?? ""}"`);

  const response = await fetch(url);
  const data = (await response.json()) as Record<string, unknown>;

  console.log(`[SerpApi] queryGoogleSearch response keys: ${Object.keys(data).join(", ")}`);

  const results: SerpAd[] = [];

  // Source A: text ads
  const ads = Array.isArray(data.ads) ? (data.ads as Record<string, unknown>[]) : [];
  let countA = 0;
  for (const ad of ads) {
    const entry = buildSerpAd(
      keyword,
      "paid_ad",
      ad["title"] as string | undefined,
      ad["link"] as string | undefined,
      ad["displayed_link"] as string | undefined,
      undefined, // businessName - not typically in text ads
      ad["phone"] as string | undefined,
      ad["address"] as string | undefined
    );
    if (entry) { results.push(entry); countA++; }
  }
  console.log(`[SerpApi] queryGoogleSearch Source A (text ads): ${countA} results`);

  // Source B: local service ads
  const localAds = data.local_ads as Record<string, unknown> | undefined;
  const localAdsArr = Array.isArray(localAds?.["ads"])
    ? (localAds!["ads"] as Record<string, unknown>[])
    : [];
  let countB = 0;
  for (const ad of localAdsArr) {
    const link = (ad["link"] ?? ad["website"]) as string | undefined;
    if (!link) continue;
    if (link.startsWith("https://www.google.com/")) {
      console.log("[SerpApi] Skipping local service ad with Google redirect URL for:", ad["title"] || "unknown");
      continue;
    }
    const entry = buildSerpAd(
      keyword,
      "paid_ad",
      ad["title"] as string | undefined,
      link,
      undefined,
      ad["name"] as string | undefined,
      ad["phone"] as string | undefined,
      ad["address"] as string | undefined
    );
    if (entry) { results.push(entry); countB++; }
  }
  console.log(`[SerpApi] queryGoogleSearch Source B (local service ads): ${countB} results`);

  // Source C: local 3-pack — may be array or object with places array
  let localResultsArr: Record<string, unknown>[] = [];
  if (Array.isArray(data.local_results)) {
    localResultsArr = data.local_results as Record<string, unknown>[];
  } else if (data.local_results && typeof data.local_results === "object") {
    const lr = data.local_results as Record<string, unknown>;
    if (Array.isArray(lr["places"])) {
      localResultsArr = lr["places"] as Record<string, unknown>[];
    }
  }
  let countC = 0;
  for (const result of localResultsArr) {
    const links = result["links"] as Record<string, unknown> | undefined;
    const website = links?.["website"] as string | undefined;
    if (!website) continue;
    const entry = buildSerpAd(
      keyword,
      "local_organic",
      result["title"] as string | undefined,
      website,
      undefined,
      result["title"] as string | undefined,
      result["phone"] as string | undefined,
      result["address"] as string | undefined
    );
    if (entry) { results.push(entry); countC++; }
  }
  console.log(`[SerpApi] queryGoogleSearch Source C (local 3-pack): ${countC} results`);

  return results;
}

async function queryGoogleLocal(
  apiKey: string,
  keyword: string,
  location?: string
): Promise<SerpAd[]> {
  const params = new URLSearchParams({
    engine: "google_local",
    q: keyword,
    api_key: apiKey,
    num: "20",
    ...(location ? { location } : {}),
  });

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  console.log(`[SerpApi] queryGoogleLocal fetching: engine=google_local, keyword="${keyword}", location="${location ?? ""}"`);

  const response = await fetch(url);
  const data = (await response.json()) as Record<string, unknown>;

  console.log(`[SerpApi] queryGoogleLocal response keys: ${Object.keys(data).join(", ")}`);

  const results: SerpAd[] = [];

  // Local results — website at result.links.website
  const localResults = Array.isArray(data.local_results)
    ? (data.local_results as Record<string, unknown>[])
    : [];
  let countLocal = 0;
  for (const result of localResults) {
    const links = result["links"] as Record<string, unknown> | undefined;
    const website = links?.["website"] as string | undefined;
    if (!website) continue;
    const entry = buildSerpAd(
      keyword,
      "local_organic",
      result["title"] as string | undefined,
      website,
      undefined,
      result["title"] as string | undefined,
      result["phone"] as string | undefined,
      result["address"] as string | undefined
    );
    if (entry) { results.push(entry); countLocal++; }
  }
  console.log(`[SerpApi] queryGoogleLocal local_results with website: ${countLocal}`);

  // Ads results — website at ad.links.website or ad.displayed_link
  const adsResults = Array.isArray(data.ads_results)
    ? (data.ads_results as Record<string, unknown>[])
    : [];
  let countAds = 0;
  for (const ad of adsResults) {
    const links = ad["links"] as Record<string, unknown> | undefined;
    const website =
      (links?.["website"] as string | undefined) ??
      (ad["displayed_link"] as string | undefined);
    if (!website) continue;
    const entry = buildSerpAd(
      keyword,
      "paid_ad",
      ad["title"] as string | undefined,
      website,
      undefined,
      ad["name"] as string | undefined,
      ad["phone"] as string | undefined,
      ad["address"] as string | undefined
    );
    if (entry) { results.push(entry); countAds++; }
  }
  console.log(`[SerpApi] queryGoogleLocal ads_results with website: ${countAds}`);

  return results;
}

export async function searchAds(keyword: string, location?: string): Promise<SerpAd[]> {
  try {
    const { env } = await import("./env.js");
    const apiKey = env.SERPAPI_KEY;

    const [googleResults, localResults] = await Promise.all([
      queryGoogleSearch(apiKey, keyword, location),
      queryGoogleLocal(apiKey, keyword, location),
    ]);

    console.log(`[SerpApi] searchAds google results: ${googleResults.length}, local results: ${localResults.length}`);

    const all = [...googleResults, ...localResults];
    const seen = new Set<string>();
    const deduped: SerpAd[] = [];

    for (const ad of all) {
      const key = ad.displayDomain.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(ad);
      }
    }

    console.log(`[SerpApi] searchAds total unique domains: ${deduped.length}`);
    return deduped;
  } catch (err) {
    console.log(`[SerpApi] searchAds error:`, err);
    return [];
  }
}
