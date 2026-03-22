export const AGENCY_DOMAINS = [
  "ferociousmedia.com",
  "scorpion.co",
  "hibu.com",
  "hibuwebsites.com",
  "thryv.com",
  "plumbingwebmasters.com",
  "bluecorona.com",
  "webfx.com",
  "seocontractor.com",
  "iamgurujosh.com",
  "kukui.com",
  "kickserv.com",
  "servicetitan.com",
  "godaddysites.com",
  "websitepro-cdn.com",
  "hiler.co",
  "leadscience.com",
  "txpages.com",
  "toplinepro.com",
  "realtimemarketing.com",
  "hvacwebmasters.com",
  "nwseo.com",
];

export const AGENCY_FOOTER_PATTERNS = [
  /designed?\s+by\s+/i,
  /powered\s+by\s+/i,
  /website\s+by\s+/i,
  /built\s+by\s+/i,
  /developed\s+by\s+/i,
  /marketing\s+by\s+/i,
  /site\s+by\s+/i,
  /design\s+by\s+/i,
];

// Known platform CDN/theme patterns to check against the full HTML
const PLATFORM_CDN_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /le-cdn\.hibuwebsites\.com/i, name: "Hibu" },
  { pattern: /websitepro-cdn\.com/i, name: "WebsitePro" },
  { pattern: /nw-texasmade/i, name: "HVAC Webmasters" },
];

export function detectAgency(html: string): { isAgencyManaged: boolean; agencyName?: string } {
  // Check full HTML for known platform CDN patterns
  for (const { pattern, name } of PLATFORM_CDN_PATTERNS) {
    if (pattern.test(html)) {
      return { isAgencyManaged: true, agencyName: name };
    }
  }

  const footer = html.slice(-3000);

  // Check for known agency domains in anchor hrefs
  const hrefRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  let match;
  while ((match = hrefRegex.exec(footer)) !== null) {
    const href = match[1] ?? "";
    const linkText = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
    for (const domain of AGENCY_DOMAINS) {
      if (href.includes(domain)) {
        const agencyName = linkText || domain;
        return { isAgencyManaged: true, agencyName };
      }
    }
  }

  // Check for footer credit patterns followed by an anchor tag
  const patternWithAnchorRegex = new RegExp(
    `(?:${AGENCY_FOOTER_PATTERNS.map((p) => p.source).join("|")})<a[^>]*>(.*?)<\\/a>`,
    "gis"
  );
  while ((match = patternWithAnchorRegex.exec(footer)) !== null) {
    const agencyName = match[match.length - 1]?.replace(/<[^>]+>/g, "").trim();
    if (agencyName) {
      return { isAgencyManaged: true, agencyName };
    }
  }

  return { isAgencyManaged: false };
}
