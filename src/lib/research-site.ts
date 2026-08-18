export type WebsiteResearchPacket = {
  requestedUrl: string;
  finalUrl: string | null;
  fetchStatus: number | null;
  fetchError: string | null;
  extractionMode: "static_html_visibility_filtered_multi_page";
  visibilityWarning: string;
  title: string | null;
  metaDescription: string | null;
  headings: { h1: string[]; h2: string[]; h3: string[] };
  navigation: Array<{ text: string; url: string }>;
  discoveredPages: Array<{ text: string; url: string; type: "contact" | "service" | "location" | "about" | "other" }>;
  callsToAction: Array<{ text: string; url: string | null; kind: "link" | "button" | "form" | "phone" | "email" }>;
  contactSignals: {
    phones: string[];
    emails: string[];
    contactPageUrls: string[];
    hasForm: boolean;
    formCount: number;
    checkedContactPages: Array<{
      url: string;
      fetchStatus: number | null;
      fetchError: string | null;
      hasForm: boolean;
      formCount: number;
    }>;
  };
  architecture: { servicePages: string[]; locationPages: string[]; aboutPages: string[] };
  technologies: string[];
  contentSignals: { wordCount: number; hasSchemaMarkup: boolean; hasViewportMeta: boolean };
  pageText: string;
};

const VISIBILITY_WARNING = "This packet comes from static HTML, not a rendered browser. Obvious hidden/template elements are removed, but headings and pageText can still contain CSS-hidden, off-canvas, slider-clone, responsive-hidden, or stale builder/template DOM. Contact/request pages discovered from the landing page are also fetched and summarized, but JavaScript-only content can still be missed. Never treat dom_heading or dom_text alone as proof that a visitor can see the content, and never treat a missing static signal as proof of site-wide absence.";

function emptyWebsitePacket(url: string, finalUrl: string | null, fetchStatus: number | null, fetchError: string | null): WebsiteResearchPacket {
  return {
    requestedUrl: url,
    finalUrl,
    fetchStatus,
    fetchError,
    extractionMode: "static_html_visibility_filtered_multi_page",
    visibilityWarning: VISIBILITY_WARNING,
    title: null,
    metaDescription: null,
    headings: { h1: [], h2: [], h3: [] },
    navigation: [],
    discoveredPages: [],
    callsToAction: [],
    contactSignals: { phones: [], emails: [], contactPageUrls: [], hasForm: false, formCount: 0, checkedContactPages: [] },
    architecture: { servicePages: [], locationPages: [], aboutPages: [] },
    technologies: [],
    contentSignals: { wordCount: 0, hasSchemaMarkup: false, hasViewportMeta: false },
    pageText: "",
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
    .replace(/<[^>]+>/g, " "));
}

function stripDefinitelyHiddenMarkup(html: string) {
  let cleaned = html
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  const hiddenBlock = /<(div|section|article|aside|header|footer|nav|main|span|p|h[1-6]|ul|ol|li)\b(?=[^>]*(?:\shidden(?:\s|=|>)|\saria-hidden=["']true["']|\sstyle=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["']|\sclass=["'][^"']*(?:elementor-hidden-(?:desktop|tablet|mobile)|\bd-none\b|\bis-hidden\b|\bvisually-hidden\b)[^"']*["']))[^>]*>[\s\S]*?<\/\1>/gi;

  for (let i = 0; i < 4; i += 1) {
    const next = cleaned.replace(hiddenBlock, " ");
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function attr(tag: string, name: string) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1]?.trim() ?? null;
}

function absoluteUrl(href: string, base: string) {
  try {
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function unique<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function sameHostname(a: string, b: string) {
  try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); }
  catch { return false; }
}

function classifyPage(text: string, url: string): "contact" | "service" | "location" | "about" | "other" {
  const haystack = `${text} ${url}`.toLowerCase();
  if (/contact|quote|estimate|book|schedule|inspection|request|appointment/.test(haystack)) return "contact";
  if (/service|repair|install|replacement|remodel|design|maintenance|solution/.test(haystack)) return "service";
  if (/location|service-area|areas-we-serve|city|county/.test(haystack)) return "location";
  if (/about|company|team|our-story/.test(haystack)) return "about";
  return "other";
}

function detectTechnologies(html: string) {
  const lower = html.toLowerCase();
  const signals: [string, RegExp][] = [
    ["WordPress", /wp-content|wp-includes/],
    ["Wix", /wixstatic|wix-code/],
    ["Squarespace", /static1\.squarespace|squarespace-cdn/],
    ["Shopify", /cdn\.shopify|shopify-section/],
    ["Webflow", /webflow\.js|data-wf-page/],
    ["Next.js", /_next\/static|__next_data__/],
    ["Nuxt", /_nuxt\//],
    ["Astro", /astro-island|data-astro-cid/],
    ["React", /data-reactroot|react-dom/],
    ["Google Tag Manager", /googletagmanager\.com\/gtm\.js/],
    ["Google Analytics", /google-analytics\.com|gtag\(/],
    ["Meta Pixel", /connect\.facebook\.net.*fbevents|fbq\(/],
    ["Elementor", /elementor-/],
    ["Divi", /et_pb_/],
  ];
  return signals.filter(([, pattern]) => pattern.test(lower)).map(([name]) => name);
}

export function extractWebsitePacket(html: string, requestedUrl: string, finalUrl: string, status: number): WebsiteResearchPacket {
  const visibleHtml = stripDefinitelyHiddenMarkup(html);
  const title = textOnly(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || null;
  const metaTag = html.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0]
    ?? html.match(/<meta[^>]+content=["'][^"']*["'][^>]+name=["']description["'][^>]*>/i)?.[0]
    ?? "";
  const metaDescription = attr(metaTag, "content");
  const heading = (level: number) => Array.from(visibleHtml.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi")))
    .map((m) => textOnly(m[1] ?? ""))
    .filter(Boolean)
    .slice(0, 20);
  const anchors = Array.from(visibleHtml.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi))
    .map((m) => ({ text: textOnly(m[2] ?? ""), url: absoluteUrl(m[1] ?? "", finalUrl) }))
    .filter((x): x is { text: string; url: string } => Boolean(x.url));
  const sameHost = anchors.filter((x) => sameHostname(x.url, finalUrl));
  const navBlocks = Array.from(visibleHtml.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)).map((m) => m[1] ?? "").join("\n");
  const navAnchors = Array.from(navBlocks.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi))
    .map((m) => ({ text: textOnly(m[2] ?? ""), url: absoluteUrl(m[1] ?? "", finalUrl) }))
    .filter((x): x is { text: string; url: string } => Boolean(x.url && x.text));
  const discoveredPages = unique(
    sameHost.filter((x) => x.text || x.url).map((x) => ({ ...x, type: classifyPage(x.text, x.url) })),
    (x) => x.url,
  ).slice(0, 80);
  const buttonText = Array.from(visibleHtml.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi))
    .map((m) => textOnly(m[1] ?? ""))
    .filter(Boolean);
  const ctaPattern = /contact|call|book|schedule|quote|estimate|get started|request|consult|shop|buy|learn more|free|inspection/i;
  const formCount = (visibleHtml.match(/<form\b/gi) ?? []).length;
  const callsToAction = [
    ...anchors.filter((x) => ctaPattern.test(x.text)).map((x) => ({ text: x.text, url: x.url, kind: "link" as const })),
    ...buttonText.filter((x) => ctaPattern.test(x)).map((text) => ({ text, url: null, kind: "button" as const })),
    ...(formCount > 0 ? [{ text: "Online form present", url: finalUrl, kind: "form" as const }] : []),
  ];
  const phones = unique(
    Array.from(visibleHtml.matchAll(/(?:tel:|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/gi))
      .map((m) => (m[0] ?? "").replace(/^tel:/i, "").trim())
      .filter(Boolean),
    (x) => x,
  );
  const emails = unique(
    Array.from(visibleHtml.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)).map((m) => m[0]!.toLowerCase()),
    (x) => x,
  );
  const pageText = textOnly(visibleHtml).slice(0, 18000);
  const servicePages = discoveredPages.filter((x) => x.type === "service").map((x) => x.url);
  const locationPages = discoveredPages.filter((x) => x.type === "location").map((x) => x.url);
  const aboutPages = discoveredPages.filter((x) => x.type === "about").map((x) => x.url);
  const contactPageUrls = discoveredPages.filter((x) => x.type === "contact").map((x) => x.url);

  return {
    requestedUrl,
    finalUrl,
    fetchStatus: status,
    fetchError: null,
    extractionMode: "static_html_visibility_filtered_multi_page",
    visibilityWarning: VISIBILITY_WARNING,
    title,
    metaDescription,
    headings: { h1: heading(1), h2: heading(2), h3: heading(3) },
    navigation: unique(navAnchors, (x) => x.url).slice(0, 40),
    discoveredPages,
    callsToAction: unique(callsToAction, (x) => `${x.kind}:${x.text}:${x.url ?? ""}`).slice(0, 40),
    contactSignals: { phones, emails, contactPageUrls, hasForm: formCount > 0, formCount, checkedContactPages: [] },
    architecture: { servicePages, locationPages, aboutPages },
    technologies: detectTechnologies(html),
    contentSignals: {
      wordCount: pageText ? pageText.split(/\s+/).length : 0,
      hasSchemaMarkup: /application\/ld\+json/i.test(html),
      hasViewportMeta: /<meta[^>]+name=["']viewport["']/i.test(html),
    },
    pageText,
  };
}

async function fetchSingleWebsitePacket(url: string): Promise<WebsiteResearchPacket> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "LeadMinerResearch/1.1" },
      redirect: "follow",
    });
    if (!response.ok) return emptyWebsitePacket(url, response.url || null, response.status, `HTTP ${response.status}`);
    return extractWebsitePacket(await response.text(), url, response.url || url, response.status);
  } catch (error) {
    return emptyWebsitePacket(url, null, null, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

export function mergeWebsitePackets(landing: WebsiteResearchPacket, contactPages: WebsiteResearchPacket[]): WebsiteResearchPacket {
  const successfulContactPages = contactPages.filter((page) => page.fetchStatus !== null && page.fetchError === null);
  const checkedContactPages = contactPages.map((page) => ({
    url: page.finalUrl ?? page.requestedUrl,
    fetchStatus: page.fetchStatus,
    fetchError: page.fetchError,
    hasForm: page.contactSignals.hasForm,
    formCount: page.contactSignals.formCount,
  }));

  return {
    ...landing,
    callsToAction: unique(
      [...landing.callsToAction, ...successfulContactPages.flatMap((page) => page.callsToAction)],
      (x) => `${x.kind}:${x.text}:${x.url ?? ""}`,
    ).slice(0, 60),
    contactSignals: {
      phones: unique([...landing.contactSignals.phones, ...successfulContactPages.flatMap((page) => page.contactSignals.phones)], (x) => x),
      emails: unique([...landing.contactSignals.emails, ...successfulContactPages.flatMap((page) => page.contactSignals.emails)], (x) => x),
      contactPageUrls: unique([
        ...landing.contactSignals.contactPageUrls,
        ...contactPages.map((page) => page.finalUrl ?? page.requestedUrl),
      ], (x) => x),
      hasForm: landing.contactSignals.hasForm || successfulContactPages.some((page) => page.contactSignals.hasForm),
      formCount: landing.contactSignals.formCount + successfulContactPages.reduce((sum, page) => sum + page.contactSignals.formCount, 0),
      checkedContactPages,
    },
  };
}

export async function fetchWebsiteResearchPacket(url: string): Promise<WebsiteResearchPacket> {
  const landing = await fetchSingleWebsitePacket(url);
  if (!landing.finalUrl || landing.fetchError) return landing;

  const contactUrls = unique(
    landing.discoveredPages
      .filter((page) => page.type === "contact" && sameHostname(page.url, landing.finalUrl!))
      .map((page) => page.url)
      .filter((candidate) => candidate !== landing.finalUrl),
    (candidate) => candidate,
  ).slice(0, 4);

  if (!contactUrls.length) return landing;
  const contactPages = await Promise.all(contactUrls.map((contactUrl) => fetchSingleWebsitePacket(contactUrl)));
  return mergeWebsitePackets(landing, contactPages);
}
