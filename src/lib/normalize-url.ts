const STRIP_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
  "msclkid",
]);

export function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);

  for (const key of [...parsed.searchParams.keys()]) {
    if (STRIP_PARAMS.has(key) || key.startsWith("utm_")) {
      parsed.searchParams.delete(key);
    }
  }

  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  return parsed.toString();
}

export function extractRootDomain(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname.replace(/^www\./, "");
}
