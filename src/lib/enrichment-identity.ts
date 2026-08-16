export type SiteIdentityAssessment = "match" | "conflict" | "unknown";

export type EnrichmentIdentityContext = {
  domain: string;
  businessName?: string;
  phone?: string;
  address?: string;
};

export type SearchIdentityRow = {
  title?: string;
  snippet?: string;
  link?: string;
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string): string[] {
  const legalSuffixes = new Set(["llc", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "pllc"]);
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !legalSuffixes.has(token));
}

function normalizedDomain(value: string): string {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function normalizePhone(value?: string): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return normalized.length === 10 ? normalized : undefined;
}

export function domainsMatch(left: string, right: string): boolean {
  const a = normalizedDomain(left);
  const b = normalizedDomain(right);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function emailMatchesDomain(email: string, domain: string): boolean {
  const emailDomain = email.split("@")[1];
  return Boolean(emailDomain && domainsMatch(emailDomain, domain));
}

export function assessSiteBusinessIdentity(expected?: string, observed?: string): SiteIdentityAssessment {
  if (!expected || !observed) return "unknown";
  const expectedNormalized = normalizeText(expected);
  const observedNormalized = normalizeText(observed);
  if (!expectedNormalized || !observedNormalized) return "unknown";

  const genericObserved = new Set(["home", "homepage", "welcome", "official site", "website"]);
  if (genericObserved.has(observedNormalized)) return "unknown";

  if (observedNormalized.includes(expectedNormalized) || expectedNormalized.includes(observedNormalized)) return "match";

  const expectedTokens = meaningfulTokens(expected);
  const observedTokens = new Set(meaningfulTokens(observed));
  if (!expectedTokens.length || !observedTokens.size) return "unknown";
  const overlap = expectedTokens.filter((token) => observedTokens.has(token)).length;
  if (overlap / expectedTokens.length >= 0.75) return "match";
  if (overlap === 0) return "conflict";
  return "unknown";
}

function locationHints(address?: string): { city?: string; state?: string } {
  if (!address) return {};
  const parts = address.split(",").map((part) => normalizeText(part)).filter(Boolean);
  if (parts.length < 2) return {};
  const statePart = parts.at(-1) ?? "";
  const state = statePart.match(/\b([a-z]{2})\b/)?.[1];
  const city = parts.length >= 3 ? parts.at(-2) : undefined;
  return { ...(city && { city }), ...(state && { state }) };
}

function rowDomain(link?: string): string | undefined {
  if (!link) return undefined;
  try { return normalizedDomain(new URL(link).hostname); }
  catch { return undefined; }
}

function exactBusinessNamePresent(text: string, businessName?: string): boolean {
  if (!businessName) return false;
  const expected = normalizeText(businessName);
  return expected.length >= 4 && normalizeText(text).includes(expected);
}

export function searchResultSupportsLead(row: SearchIdentityRow, context: EnrichmentIdentityContext): boolean {
  const combined = `${row.title ?? ""} ${row.snippet ?? ""} ${row.link ?? ""}`;
  const combinedNormalized = normalizeText(combined);
  const resultDomain = rowDomain(row.link);

  if (resultDomain && domainsMatch(resultDomain, context.domain)) return true;
  if (combinedNormalized.includes(normalizeText(context.domain))) return true;

  const phone = normalizePhone(context.phone);
  if (phone && combined.replace(/\D/g, "").includes(phone)) return true;

  if (!exactBusinessNamePresent(combined, context.businessName)) return false;
  const { city, state } = locationHints(context.address);
  if (!city) return false;
  const cityMatches = combinedNormalized.includes(city);
  const stateMatches = !state || new RegExp(`\\b${state}\\b`, "i").test(combinedNormalized);
  return cityMatches && stateMatches;
}
