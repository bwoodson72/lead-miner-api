export const AGENCY_DOMAINS = [
  "ferociousmedia.com",
  "scorpion.co",
  "hibu.com",
  "thryv.com",
  "plumbingwebmasters.com",
  "bluecorona.com",
  "webfx.com",
  "seocontractor.com",
  "iamgurujosh.com",
  "kukui.com",
  "kickserv.com",
  "servicetitan.com",
  "housecallpro.com",
  "godaddysites.com",
  "websitepro-cdn.com",
  "hiler.co",
];

export const AGENCY_FOOTER_PATTERNS = [
  /designed?\s+by\s+/i,
  /powered\s+by\s+/i,
  /website\s+by\s+/i,
  /built\s+by\s+/i,
  /developed\s+by\s+/i,
  /marketing\s+by\s+/i,
  /site\s+by\s+/i,
];

export function detectAgency(html: string): { isAgencyManaged: boolean; agencyName?: string } {
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
