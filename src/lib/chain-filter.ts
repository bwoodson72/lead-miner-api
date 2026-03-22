const TOLL_FREE_PREFIXES = ["800", "855", "877", "888", "866", "844"];

const PARKED_DOMAIN_PATTERNS = [
  /this domain is for sale/i,
  /buy this domain/i,
  /hugedomains\.com/i,
  /sedo\.com/i,
  /afternic\.com/i,
  /godaddy auctions/i,
];

const MULTI_LOCATION_PATTERNS = [
  /find your local/i,
  /find a location/i,
  /all locations/i,
  /find your branch/i,
  /locations near you/i,
  /store locator/i,
  /branch locator/i,
];

export function detectNationalChain(
  html: string,
  phone?: string,
  domain?: string
): { isNationalChain: boolean; reason?: string } {
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    const prefix = digits.startsWith("1") ? digits.slice(1, 4) : digits.slice(0, 3);
    if (TOLL_FREE_PREFIXES.includes(prefix)) {
      return { isNationalChain: true, reason: "toll_free_number" };
    }
  }

  if (domain?.endsWith(".org")) {
    return { isNationalChain: true, reason: "org_domain" };
  }

  for (const pattern of PARKED_DOMAIN_PATTERNS) {
    if (pattern.test(html)) {
      return { isNationalChain: true, reason: "parked_domain" };
    }
  }

  for (const pattern of MULTI_LOCATION_PATTERNS) {
    if (pattern.test(html)) {
      return { isNationalChain: true, reason: "multi_location" };
    }
  }

  return { isNationalChain: false };
}
