import { fetchWebsiteResearchPacket, type WebsiteResearchPacket } from "./research-site.js";

export type RepresentativePageType = "service" | "location" | "about" | "other";

export type RepresentativePageSummary = {
  url: string;
  type: RepresentativePageType;
  fetchStatus: number | null;
  fetchError: string | null;
  title: string | null;
  h1: string[];
  h2: string[];
  wordCount: number;
  hasForm: boolean;
  pageText: string;
};

export type BusinessAssetResearchPacket = WebsiteResearchPacket & {
  siteCoverage: {
    mode: "landing_only" | "landing_plus_representative_pages";
    sitemapUrlsFound: number;
    representativePagesAttempted: number;
    representativePagesFetched: number;
    serviceUrlsObserved: number;
    locationUrlsObserved: number;
    aboutUrlsObserved: number;
    architectureEvidenceComplete: boolean;
    warning: string;
  };
  representativePages: RepresentativePageSummary[];
};

const COVERAGE_WARNING = "Representative crawling samples a bounded set of same-site pages and sitemap URLs. It improves evidence about site depth but is not a complete crawl. Absence from this packet is not proof that a page, service, location, or capability does not exist.";

function normalizeHost(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function sameHost(a: string, b: string) {
  return Boolean(normalizeHost(a) && normalizeHost(a) === normalizeHost(b));
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function textOnly(value: string) {
  return decodeHtml(value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "));
}

function classifyUrl(url: string): RepresentativePageType {
  let value = url.toLowerCase();
  try { value = new URL(url).pathname.toLowerCase(); } catch { /* keep raw */ }
  if (/about|our-story|company|team/.test(value)) return "about";
  if (/location|service-area|areas-we-serve|locations|city|county/.test(value)) return "location";
  if (/service|repair|install|replacement|remodel|roof|plumb|electric|hvac|landscap|foundation|concrete|kitchen|bath|paint|clean|construction/.test(value)) return "service";
  return "other";
}

async function fetchText(url: string, timeoutMs = 8_000): Promise<{ status: number; finalUrl: string; text: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "LeadMinerResearch/1.2", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    if (!response.ok) return null;
    return { status: response.status, finalUrl: response.url || url, text: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function sitemapLocs(xml: string, baseUrl: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const raw = decodeHtml(match[1] ?? "");
    try {
      const url = new URL(raw, baseUrl).toString();
      if (sameHost(url, baseUrl)) values.push(url);
    } catch { /* ignore malformed loc */ }
  }
  return [...new Set(values)];
}

async function discoverSitemapUrls(baseUrl: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const seeds = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"].map((path) => new URL(path, origin).toString());
  const pageUrls = new Set<string>();
  const childSitemaps = new Set<string>();

  for (const seed of seeds) {
    const response = await fetchText(seed, 5_000);
    if (!response) continue;
    for (const loc of sitemapLocs(response.text, origin)) {
      if (/\.xml(?:$|\?)/i.test(loc)) childSitemaps.add(loc);
      else pageUrls.add(loc);
    }
    if (pageUrls.size >= 100) break;
  }

  for (const sitemap of [...childSitemaps].slice(0, 4)) {
    const response = await fetchText(sitemap, 5_000);
    if (!response) continue;
    for (const loc of sitemapLocs(response.text, origin)) {
      if (!/\.xml(?:$|\?)/i.test(loc)) pageUrls.add(loc);
      if (pageUrls.size >= 150) break;
    }
    if (pageUrls.size >= 150) break;
  }

  return [...pageUrls].slice(0, 150);
}

function representativeCandidates(landing: WebsiteResearchPacket, sitemapUrls: string[]): Array<{ url: string; type: RepresentativePageType }> {
  const finalUrl = landing.finalUrl ?? landing.requestedUrl;
  const rows = new Map<string, { url: string; type: RepresentativePageType }>();

  for (const page of landing.discoveredPages) {
    if (!sameHost(page.url, finalUrl) || page.type === "contact") continue;
    const type: RepresentativePageType = page.type === "service" || page.type === "location" || page.type === "about" ? page.type : "other";
    rows.set(page.url, { url: page.url, type });
  }
  for (const url of sitemapUrls) {
    if (!sameHost(url, finalUrl) || url === finalUrl) continue;
    if (/contact|quote|estimate|book|schedule|inspection|request|appointment/i.test(url)) continue;
    if (!rows.has(url)) rows.set(url, { url, type: classifyUrl(url) });
  }

  const all = [...rows.values()];
  const take = (type: RepresentativePageType, max: number) => all.filter((row) => row.type === type).slice(0, max);
  const selected = [
    ...take("service", 3),
    ...take("about", 1),
    ...take("location", 1),
    ...take("other", 1),
  ];
  return [...new Map(selected.map((row) => [row.url, row])).values()].slice(0, 6);
}

async function summarizePage(row: { url: string; type: RepresentativePageType }): Promise<RepresentativePageSummary> {
  const response = await fetchText(row.url);
  if (!response || !sameHost(response.finalUrl, row.url)) {
    return { url: row.url, type: row.type, fetchStatus: null, fetchError: "Fetch failed or redirected off-site", title: null, h1: [], h2: [], wordCount: 0, hasForm: false, pageText: "" };
  }

  const html = response.text;
  const heading = (level: 1 | 2) => Array.from(html.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi")))
    .map((match) => textOnly(match[1] ?? ""))
    .filter(Boolean)
    .slice(0, 12);
  const title = textOnly(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || null;
  const pageText = textOnly(html).slice(0, 7000);

  return {
    url: response.finalUrl,
    type: row.type,
    fetchStatus: response.status,
    fetchError: null,
    title,
    h1: heading(1),
    h2: heading(2),
    wordCount: pageText ? pageText.split(/\s+/).length : 0,
    hasForm: /<form\b/i.test(html),
    pageText,
  };
}

export async function fetchBusinessAssetResearchPacket(url: string): Promise<BusinessAssetResearchPacket> {
  const landing = await fetchWebsiteResearchPacket(url);
  if (!landing.finalUrl || landing.fetchError) {
    return {
      ...landing,
      siteCoverage: {
        mode: "landing_only",
        sitemapUrlsFound: 0,
        representativePagesAttempted: 0,
        representativePagesFetched: 0,
        serviceUrlsObserved: landing.architecture.servicePages.length,
        locationUrlsObserved: landing.architecture.locationPages.length,
        aboutUrlsObserved: landing.architecture.aboutPages.length,
        architectureEvidenceComplete: false,
        warning: COVERAGE_WARNING,
      },
      representativePages: [],
    };
  }

  const sitemapUrls = await discoverSitemapUrls(landing.finalUrl);
  const candidates = representativeCandidates(landing, sitemapUrls);
  const representativePages = await Promise.all(candidates.map(summarizePage));
  const fetched = representativePages.filter((page) => page.fetchStatus !== null && !page.fetchError);
  const observed = [...new Set([
    ...landing.discoveredPages.map((page) => page.url),
    ...sitemapUrls,
  ])];

  return {
    ...landing,
    siteCoverage: {
      mode: fetched.length ? "landing_plus_representative_pages" : "landing_only",
      sitemapUrlsFound: sitemapUrls.length,
      representativePagesAttempted: candidates.length,
      representativePagesFetched: fetched.length,
      serviceUrlsObserved: observed.filter((value) => classifyUrl(value) === "service").length,
      locationUrlsObserved: observed.filter((value) => classifyUrl(value) === "location").length,
      aboutUrlsObserved: observed.filter((value) => classifyUrl(value) === "about").length,
      architectureEvidenceComplete: false,
      warning: COVERAGE_WARNING,
    },
    representativePages,
  };
}
