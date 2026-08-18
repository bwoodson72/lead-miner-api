import { SerpAdSchema, type SerpAd } from "./schemas.js";
import { fetchSerperPlaces } from "./serper-places-client.js";

export type LocalizedSearchSpec = {
  serviceQuery: string;
  queryLocation: string;
  serpApiLocation: string;
};

const TEXAS_CITIES = [
  "Granbury", "Fort Worth", "Weatherford", "Cleburne", "Burleson", "Mansfield",
  "Arlington", "Dallas", "Aledo", "Azle", "Crowley", "Glen Rose", "Stephenville",
  "Mineral Wells", "Waxahachie", "Midlothian", "Cedar Hill", "Corsicana",
  "Hillsboro", "Ennis", "Denton", "Wichita Falls", "Abilene", "San Angelo",
  "Brownwood", "Tyler", "Longview", "Lufkin", "Nacogdoches", "Temple", "Killeen",
  "Waco", "Austin", "San Antonio", "Houston",
] as const;

const SERVICE_EXPANSIONS: Array<[RegExp, string[]]> = [
  [/\b(roof|roofer|roofing)\b/i, [
    "roofing contractor", "roofer", "roofing company", "roofing services",
    "roof repair", "roof replacement", "residential roofing", "commercial roofing",
    "storm damage roofing", "hail damage roofing", "metal roofing",
    "emergency roof repair", "roof inspection",
  ]],
  [/\b(landscap|lawn care|lawn service)\w*\b/i, [
    "landscaping", "landscaper", "landscaping company", "landscape contractor",
    "lawn care", "lawn service", "lawn maintenance", "landscape design",
    "landscape installation", "irrigation contractor", "sprinkler repair",
    "yard maintenance",
  ]],
  [/\b(plumber|plumbing)\b/i, [
    "plumber", "plumbing company", "plumbing contractor", "plumbing repair",
    "emergency plumber", "drain cleaning", "water heater repair",
    "water heater installation", "sewer repair", "leak detection",
    "residential plumber", "commercial plumber",
  ]],
  [/\b(electrician|electrical)\b/i, [
    "electrician", "electrical contractor", "electrical company", "electrical repair",
    "electrical services", "residential electrician", "commercial electrician",
    "emergency electrician", "panel upgrade", "electrical wiring",
    "generator installation",
  ]],
  [/\b(hvac|heating|air conditioning|air conditioner|ac repair|ac replacement|furnace|heat pump)\b/i, [
    "hvac", "hvac contractor", "hvac company", "air conditioning repair",
    "ac repair", "heating repair", "furnace repair", "hvac installation",
    "air conditioning installation", "heat pump installation", "ac replacement",
    "commercial hvac", "residential hvac",
  ]],
  [/\b(pest control|exterminator)\b/i, [
    "pest control", "exterminator", "pest control company", "termite control",
    "rodent control", "mosquito control", "bed bug exterminator", "wildlife removal",
  ]],
  [/\b(fence|fencing)\b/i, [
    "fence company", "fence contractor", "fencing contractor", "fence installation",
    "fence repair", "wood fence", "metal fence", "privacy fence",
    "commercial fencing",
  ]],
  [/\bconcrete\b/i, [
    "concrete contractor", "concrete company", "concrete repair", "concrete driveway",
    "concrete patio", "concrete slab", "decorative concrete", "commercial concrete",
  ]],
  [/\bgarage door\b/i, [
    "garage door repair", "garage door company", "garage door installation",
    "garage door opener repair", "overhead door repair", "commercial garage door",
  ]],
  [/\b(tree service|tree removal|arborist)\b/i, [
    "tree service", "tree removal", "tree trimming", "arborist", "stump grinding",
    "emergency tree service", "tree care company",
  ]],
  [/\b(painting|painter)\b/i, [
    "painting contractor", "painter", "painting company", "house painter",
    "interior painting", "exterior painting", "commercial painting",
  ]],
  [/\bfoundation\b/i, [
    "foundation repair", "foundation contractor", "foundation company",
    "slab foundation repair", "pier and beam repair", "house leveling",
  ]],
  [/\bseptic\b/i, [
    "septic service", "septic company", "septic pumping", "septic repair",
    "septic installation", "septic inspection",
  ]],
  [/\b(well pump|water well)\b/i, [
    "well pump service", "well pump repair", "water well service",
    "water well drilling", "well pump installation",
  ]],
  [/\b(auto body|collision)\b/i, [
    "auto body shop", "collision repair", "auto body repair", "car body shop",
    "paint and body shop",
  ]],
  [/\b(veterinarian|veterinary|vet clinic)\b/i, [
    "veterinarian", "veterinary clinic", "animal hospital", "vet clinic",
    "emergency vet", "pet clinic",
  ]],
  [/\b(dentist|dental)\b/i, [
    "dentist", "dental office", "dental clinic", "family dentist",
    "cosmetic dentist", "emergency dentist", "general dentist",
  ]],
];

function normalizeLocation(location: string): string {
  const trimmed = location.trim();
  return /united states$/i.test(trimmed) ? trimmed : `${trimmed}, United States`;
}

function queryLocationFromCanonical(location: string): string {
  return location
    .replace(/,?\s*United States$/i, "")
    .replace(/,\s*Texas$/i, " TX")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTexasMarket(keyword: string): { serviceQuery: string; city?: string } {
  for (const city of TEXAS_CITIES) {
    const escapedCity = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\s+(?:in\\s+)?${escapedCity}\\s+tx\\s*$`, "i");
    if (pattern.test(keyword)) {
      return {
        serviceQuery: keyword.replace(pattern, "").trim(),
        city,
      };
    }
  }
  return { serviceQuery: keyword.trim() };
}

export function resolveLocalizedSearchSpec(
  keyword: string,
  location?: string
): LocalizedSearchSpec | null {
  const explicit = location?.trim();
  if (explicit) {
    const canonical = normalizeLocation(explicit);
    return {
      serviceQuery: keyword.trim(),
      queryLocation: queryLocationFromCanonical(canonical),
      serpApiLocation: canonical,
    };
  }

  const commaIndex = keyword.indexOf(",");
  if (commaIndex >= 0) {
    const serviceQuery = keyword.slice(0, commaIndex).trim();
    const rawLocation = keyword.slice(commaIndex + 1).trim();
    if (serviceQuery && rawLocation) {
      const canonical = normalizeLocation(rawLocation);
      return {
        serviceQuery,
        queryLocation: queryLocationFromCanonical(canonical),
        serpApiLocation: canonical,
      };
    }
  }

  const embedded = stripTexasMarket(keyword);
  if (embedded.city && embedded.serviceQuery) {
    return {
      serviceQuery: embedded.serviceQuery,
      queryLocation: `${embedded.city} TX`,
      serpApiLocation: `${embedded.city}, Texas, United States`,
    };
  }

  return null;
}

function buildVariants(serviceQuery: string): string[] {
  const base = serviceQuery.trim().replace(/\s+/g, " ");
  const variants = [base];
  const expansion = SERVICE_EXPANSIONS.find(([test]) => test.test(base));

  if (expansion) {
    variants.push(...expansion[1]);
  } else {
    variants.push(
      `${base} company`,
      `${base} services`,
      `local ${base}`,
      `${base} near me`,
      `best ${base}`,
      `${base} contractor`,
      `${base} repair`
    );
  }

  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = variant.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function buildResult(
  resultKeyword: string,
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
    keyword: resultKeyword,
    adTitle: title ?? "",
    landingPageUrl: fullLink,
    displayDomain,
    adSource,
    ...(businessName && { businessName }),
    ...(phone && { phone }),
    ...(address && { address }),
    ...(title && { sourceTitle: title }),
  });

  return parsed.success ? parsed.data : null;
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
  variant: string,
  spec: LocalizedSearchSpec,
  resultKeyword: string
): Promise<SerpAd[]> {
  const q = `${variant} ${spec.queryLocation}`.trim();
  const data = await fetchSerperPlaces(apiKey, q, 20);
  if (!data) return [];

  const places = Array.isArray(data.places)
    ? (data.places as Record<string, unknown>[])
    : [];

  const results: SerpAd[] = [];
  for (const place of places) {
    const entry = buildResult(
      resultKeyword,
      "local_organic",
      place["title"] as string | undefined,
      place["website"] as string | undefined,
      place["title"] as string | undefined,
      place["phoneNumber"] as string | undefined,
      place["address"] as string | undefined
    );
    if (entry) results.push(entry);
  }

  console.log(`[Fanout] ${q}: ${results.length} businesses with websites`);
  return results;
}

async function queryPaidAds(
  apiKey: string,
  spec: LocalizedSearchSpec,
  resultKeyword: string
): Promise<SerpAd[]> {
  const params = new URLSearchParams({
    engine: "google_ads",
    q: spec.serviceQuery,
    location: spec.serpApiLocation,
    hl: "en",
    device: "mobile",
    api_key: apiKey,
  });

  const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
  if (!response.ok) {
    console.error(
      `[SerpApi] Ads error ${response.status} for ${spec.serpApiLocation}: ${await response.text()}`
    );
    return [];
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data["error"] === "string") {
    console.error(
      `[SerpApi] ${spec.serviceQuery} @ ${spec.serpApiLocation}: ${data["error"]}`
    );
    return [];
  }

  const ads = Array.isArray(data.ads)
    ? (data.ads as Record<string, unknown>[])
    : [];

  const results: SerpAd[] = [];
  for (const ad of ads) {
    const entry = buildResult(
      resultKeyword,
      "paid_ad",
      ad["title"] as string | undefined,
      ad["link"] as string | undefined,
      ad["source"] as string | undefined,
      ad["phone"] as string | undefined
    );
    if (entry) results.push(entry);
  }

  console.log(
    `[Fanout] ${spec.serviceQuery} @ ${spec.serpApiLocation}: ${results.length} paid ads`
  );
  return results;
}

export async function discoverLocalizedCandidates(
  resultKeyword: string,
  spec: LocalizedSearchSpec,
  targetDomains: number
): Promise<SerpAd[]> {
  const { env } = await import("./env.js");
  const byDomain = new Map<string, SerpAd>();
  const discoveryTarget =
    targetDomains + Math.max(20, Math.ceil(targetDomains * 0.25));

  if (env.SERPAPI_KEY) {
    mergeByDomain(
      byDomain,
      await queryPaidAds(env.SERPAPI_KEY, spec, resultKeyword)
    );
  }

  const variants = buildVariants(spec.serviceQuery);
  for (const variant of variants) {
    if (byDomain.size >= discoveryTarget) break;

    mergeByDomain(
      byDomain,
      await querySerperPlaces(
        env.SERPER_API_KEY,
        variant,
        spec,
        resultKeyword
      )
    );

    console.log(
      `[Fanout] ${resultKeyword}: ${byDomain.size}/${discoveryTarget} unique domains after "${variant}"`
    );
  }

  if (byDomain.size < discoveryTarget) {
    console.warn(
      `[Fanout] ${resultKeyword}: exhausted ${variants.length} related searches with ${byDomain.size}/${discoveryTarget} unique domains`
    );
  }

  return Array.from(byDomain.values());
}
