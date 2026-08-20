import {
  extractWebsitePacket,
  fetchWebsiteResearchPacket,
  mergeWebsitePackets,
  type WebsiteResearchPacket,
} from "./research-site.js";
import { fetchSearchIndexEvidence, type SearchIndexEvidence } from "./research-index-fallback.js";
import { fetchWithTlsIssuerRecovery } from "./tls-issuer-recovery.js";
import { stripStaticHiddenMarkup } from "./research-visible-html.js";

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

export type CrawlerAttempt = {
  url: string;
  status: number | null;
  finalUrl: string | null;
  error: string | null;
};

export type BusinessAssetResearchPacket = WebsiteResearchPacket & {
  siteCoverage: {
    mode: "landing_only" | "landing_plus_representative_pages" | "search_index_fallback";
    sitemapUrlsFound: number;
    representativePagesAttempted: number;
    representativePagesFetched: number;
    serviceUrlsObserved: number;
    locationUrlsObserved: number;
    aboutUrlsObserved: number;
    contactUrlsObserved: number;
    architectureEvidenceComplete: boolean;
    crawlerAccess: {
      initialFetchSucceeded: boolean;
      browserFallbackAttempted: boolean;
      browserFallbackSucceeded: boolean;
      visitorReachabilityEstablished: false;
      attempts: CrawlerAttempt[];
    };
    warning: string;
  };
  representativePages: RepresentativePageSummary[];
  searchIndexEvidence: SearchIndexEvidence;
};

const COVERAGE_WARNING = "Representative crawling samples a bounded set of same-site pages and sitemap URLs. It improves evidence about site depth but is not a complete crawl. A crawler fetch failure means only that Lead Miner's automated crawler could not inspect the page; it is not evidence that the website is down, offline, unreachable, or inaccessible to normal visitors. Search-index fallback can support page-topic and bounded architecture evidence when direct crawling fails, but index evidence may lag the live site. Absence from this packet is not proof that a page, service, location, or capability does not exist.";

function normalizeHost(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function sameHost(a: string, b: string) {
  return Boolean(normalizeHost(a) && normalizeHost(a) === normalizeHost(b));
}

function browserHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
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
  if (/service|repair|install|replacement|remodel|roof|plumb|electric|hvac|landscap|foundation|concrete|kitchen|bath|paint|clean|construction|siding|gutter/.test(value)) return "service";
  return "other";
}

type FetchTextResult = {
  response: { status: number; finalUrl: string; text: string } | null;
  attempt: CrawlerAttempt;
};

function fetchErrorDetails(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Timeout";

  const details: string[] = [];
  if (error instanceof Error && error.message) details.push(error.message);
  else if (error != null) details.push(String(error));

  let cause = (error as { cause?: unknown } | null)?.cause;
  let depth = 0;
  while (cause && depth < 3) {
    const row = cause as { code?: unknown; message?: unknown; address?: unknown; port?: unknown; cause?: unknown };
    const parts: string[] = [];
    if (typeof row.code === "string") parts.push(row.code);
    if (typeof row.message === "string" && !details.includes(row.message)) parts.push(row.message);
    if (typeof row.address === "string") {
      parts.push(typeof row.port === "number" ? `${row.address}:${row.port}` : row.address);
    }
    if (parts.length) details.push(`cause: ${parts.join(" · ")}`);
    cause = row.cause;
    depth += 1;
  }

  return details.filter(Boolean).join(" | ") || "Unknown fetch error";
}

async function fetchTextDetailed(url: string, timeoutMs = 8_000): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithTlsIssuerRecovery(url, { signal: controller.signal, redirect: "follow", headers: browserHeaders() });
    const attempt: CrawlerAttempt = {
      url,
      status: response.status,
      finalUrl: response.url || url,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
    if (!response.ok) {
      console.warn(`[Research crawl] ${url} returned HTTP ${response.status}${response.url ? ` -> ${response.url}` : ""}`);
      return { response: null, attempt };
    }
    return { response: { status: response.status, finalUrl: response.url || url, text: await response.text() }, attempt };
  } catch (error) {
    const message = fetchErrorDetails(error);
    console.warn(`[Research crawl] ${url} failed: ${message}`);
    return {
      response: null,
      attempt: { url, status: null, finalUrl: null, error: message },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string, timeoutMs = 8_000) {
  return (await fetchTextDetailed(url, timeoutMs)).response;
}

function rootVariants(input: string): string[] {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    const path = `${url.pathname || "/"}${url.search}`;
    return [...new Set([
      input,
      `https://${host}${path}`,
      `https://www.${host}${path}`,
      `http://${host}${path}`,
      `http://www.${host}${path}`,
    ])];
  } catch {
    return [input];
  }
}

async function fetchLandingWithBrowserFallback(url: string): Promise<{
  landing: WebsiteResearchPacket;
  initialFetchSucceeded: boolean;
  browserFallbackAttempted: boolean;
  browserFallbackSucceeded: boolean;
  attempts: CrawlerAttempt[];
}> {
  const initial = await fetchWebsiteResearchPacket(url);
  if (initial.finalUrl && !initial.fetchError) {
    return {
      landing: initial,
      initialFetchSucceeded: true,
      browserFallbackAttempted: false,
      browserFallbackSucceeded: false,
      attempts: [{ url, status: initial.fetchStatus, finalUrl: initial.finalUrl, error: null }],
    };
  }

  const attempts: CrawlerAttempt[] = [{
    url,
    status: initial.fetchStatus,
    finalUrl: initial.finalUrl,
    error: initial.fetchError ?? "Initial crawler fetch failed",
  }];

  for (const candidate of rootVariants(url)) {
    const detailed = await fetchTextDetailed(candidate, 12_000);
    attempts.push(detailed.attempt);
    const response = detailed.response;
    if (!response) continue;

    const landing = extractWebsitePacket(response.text, url, response.finalUrl, response.status);
    const contactUrls = [...new Set(
      landing.discoveredPages
        .filter((page) => page.type === "contact" && sameHost(page.url, response.finalUrl))
        .map((page) => page.url)
        .filter((pageUrl) => pageUrl !== response.finalUrl),
    )].slice(0, 4);

    const contactPages = (await Promise.all(contactUrls.map(async (contactUrl) => {
      const contactResponse = await fetchText(contactUrl, 8_000);
      if (!contactResponse || !sameHost(contactResponse.finalUrl, response.finalUrl)) return null;
      return extractWebsitePacket(contactResponse.text, contactUrl, contactResponse.finalUrl, contactResponse.status);
    }))).filter((page): page is WebsiteResearchPacket => Boolean(page));

    return {
      landing: mergeWebsitePackets(landing, contactPages),
      initialFetchSucceeded: false,
      browserFallbackAttempted: true,
      browserFallbackSucceeded: true,
      attempts,
    };
  }

  return {
    landing: initial,
    initialFetchSucceeded: false,
    browserFallbackAttempted: true,
    browserFallbackSucceeded: false,
    attempts,
  };
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
  for (const sitemapUrl of sitemapUrls) {
    if (!sameHost(sitemapUrl, finalUrl) || sitemapUrl === finalUrl) continue;
    if (/contact|quote|estimate|book|schedule|inspection|request|appointment/i.test(sitemapUrl)) continue;
    if (!rows.has(sitemapUrl)) rows.set(sitemapUrl, { url: sitemapUrl, type: classifyUrl(sitemapUrl) });
  }

  const all = [...rows.values()];
  const take = (type: RepresentativePageType, max: number) => all.filter((row) => row.type === type).slice(0, max);
  return [...new Map([
    ...take("service", 3),
    ...take("about", 1),
    ...take("location", 1),
    ...take("other", 1),
  ].map((row) => [row.url, row])).values()].slice(0, 6);
}

async function summarizePage(row: { url: string; type: RepresentativePageType }): Promise<RepresentativePageSummary> {
  const response = await fetchText(row.url);
  if (!response || !sameHost(response.finalUrl, row.url)) {
    return { url: row.url, type: row.type, fetchStatus: null, fetchError: "Crawler could not inspect page or it redirected off-site", title: null, h1: [], h2: [], wordCount: 0, hasForm: false, pageText: "" };
  }

  const html = stripStaticHiddenMarkup(response.text);
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

function emptySearchIndexEvidence(): SearchIndexEvidence {
  return {
    attempted: false,
    succeeded: false,
    pages: [],
    warning: "Search-index fallback was not needed because direct website inspection succeeded.",
    error: null,
  };
}

export async function fetchBusinessAssetResearchPacket(url: string): Promise<BusinessAssetResearchPacket> {
  const fetchedLanding = await fetchLandingWithBrowserFallback(url);
  const landing = fetchedLanding.landing;
  const crawlerAccess = {
    initialFetchSucceeded: fetchedLanding.initialFetchSucceeded,
    browserFallbackAttempted: fetchedLanding.browserFallbackAttempted,
    browserFallbackSucceeded: fetchedLanding.browserFallbackSucceeded,
    visitorReachabilityEstablished: false as const,
    attempts: fetchedLanding.attempts,
  };

  if (!landing.finalUrl || landing.fetchError) {
    const searchIndexEvidence = await fetchSearchIndexEvidence(url);
    const indexedPages = searchIndexEvidence.pages;
    return {
      ...landing,
      siteCoverage: {
        mode: indexedPages.length ? "search_index_fallback" : "landing_only",
        sitemapUrlsFound: 0,
        representativePagesAttempted: 0,
        representativePagesFetched: 0,
        serviceUrlsObserved: indexedPages.filter((page) => page.type === "service").length,
        locationUrlsObserved: indexedPages.filter((page) => page.type === "location").length,
        aboutUrlsObserved: indexedPages.filter((page) => page.type === "about").length,
        contactUrlsObserved: indexedPages.filter((page) => page.type === "contact").length,
        architectureEvidenceComplete: false,
        crawlerAccess,
        warning: COVERAGE_WARNING,
      },
      representativePages: [],
      searchIndexEvidence,
    };
  }

  const sitemapUrls = await discoverSitemapUrls(landing.finalUrl);
  const candidates = representativeCandidates(landing, sitemapUrls);
  const representativePages = await Promise.all(candidates.map(summarizePage));
  const fetched = representativePages.filter((page) => page.fetchStatus !== null && !page.fetchError);
  const observed = [...new Set([...landing.discoveredPages.map((page) => page.url), ...sitemapUrls])];

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
      contactUrlsObserved: landing.contactSignals.contactPageUrls.length,
      architectureEvidenceComplete: false,
      crawlerAccess,
      warning: COVERAGE_WARNING,
    },
    representativePages,
    searchIndexEvidence: emptySearchIndexEvidence(),
  };
}
