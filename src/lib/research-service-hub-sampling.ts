import { analyzeContentDepth } from "./research-content-depth.js";
import { stripStaticHiddenMarkup } from "./research-visible-html.js";
import { fetchWithTlsIssuerRecovery } from "./tls-issuer-recovery.js";
import type { BusinessAssetResearchPacket, RepresentativePageSummary } from "./research-site-v8.js";

function normalizeHost(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function sameHost(a: string, b: string) {
  return Boolean(normalizeHost(a) && normalizeHost(a) === normalizeHost(b));
}

function pathname(value: string) {
  try { return new URL(value).pathname.toLowerCase().replace(/\/+$/, "") || "/"; }
  catch { return value.toLowerCase().split(/[?#]/, 1)[0]?.replace(/\/+$/, "") || "/"; }
}

function serviceHubPriority(value: string) {
  const path = pathname(value);
  if (/^\/(?:services?|our-services|what-we-do)$/.test(path)) return 0;
  if (/^\/(?:services?|our-services|what-we-do)\/[a-z0-9-]+$/.test(path)) return 3;
  if (/\/(?:store|shop|products?)\//.test(path) || /^\/(?:store|shop|products?)(?:\/|$)/.test(path)) return 9;
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 1 && /service/.test(segments[0] ?? "")) return 1;
  return 6;
}

export function chooseCanonicalServiceHub(packet: BusinessAssetResearchPacket) {
  const finalUrl = packet.finalUrl ?? packet.requestedUrl;
  const candidates = [...new Set([
    ...packet.architecture.servicePages,
    ...packet.discoveredPages.filter((page) => page.type === "service").map((page) => page.url),
    ...packet.navigation.filter((item) => /\bservices?\b|what we do/i.test(item.text)).map((item) => item.url),
  ])]
    .filter((url) => sameHost(url, finalUrl) && url !== finalUrl)
    .map((url) => ({ url, priority: serviceHubPriority(url), path: pathname(url) }))
    .filter((row) => row.priority <= 1)
    .sort((a, b) => a.priority - b.priority || a.path.length - b.path.length || a.url.localeCompare(b.url));

  return candidates[0]?.url ?? null;
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

function browserHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
  };
}

async function fetchCanonicalServiceHub(url: string): Promise<RepresentativePageSummary | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchWithTlsIssuerRecovery(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: browserHeaders(),
    });
    if (!response.ok || !sameHost(response.url || url, url)) return null;
    const html = stripStaticHiddenMarkup(await response.text());
    const heading = (level: 1 | 2) => Array.from(html.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi")))
      .map((match) => textOnly(match[1] ?? ""))
      .filter(Boolean)
      .slice(0, 12);
    const title = textOnly(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || null;
    const pageText = textOnly(html).slice(0, 7000);
    const pageWordCount = pageText ? pageText.split(/\s+/).length : 0;
    return {
      url: response.url || url,
      type: "service",
      fetchStatus: response.status,
      fetchError: null,
      title,
      h1: heading(1),
      h2: heading(2),
      wordCount: pageWordCount,
      hasForm: /<form\b/i.test(html),
      pageText,
      contentDepth: analyzeContentDepth(html, "service", pageWordCount),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function contentDepthSummary(pages: RepresentativePageSummary[], warning: string) {
  const servicePages = pages.filter((page) => page.type === "service" && page.fetchStatus !== null && !page.fetchError);
  return {
    sampledServicePages: servicePages.length,
    thinServicePages: servicePages.filter((page) => page.contentDepth.rating === "thin").length,
    strongThinServicePages: servicePages.filter((page) => page.contentDepth.materialityHint === "strong").length,
    limitedServicePages: servicePages.filter((page) => page.contentDepth.rating === "limited").length,
    warning,
  };
}

export function mergeCanonicalServiceHubSummary(
  packet: BusinessAssetResearchPacket,
  serviceHub: RepresentativePageSummary,
): BusinessAssetResearchPacket {
  const hubPath = pathname(serviceHub.url);
  const alreadySampled = packet.representativePages.some((page) => pathname(page.url) === hubPath);
  if (alreadySampled) return packet;

  const servicePages = packet.representativePages.filter((page) => page.type === "service");
  const nonServicePages = packet.representativePages.filter((page) => page.type !== "service");
  const retainedServices = servicePages
    .filter((page) => pathname(page.url) !== hubPath)
    .sort((a, b) => serviceHubPriority(a.url) - serviceHubPriority(b.url));
  const representativePages = [serviceHub, ...retainedServices].slice(0, 3)
    .concat(nonServicePages)
    .slice(0, 6);

  return {
    ...packet,
    representativePages,
    contentDepthSummary: contentDepthSummary(representativePages, packet.contentDepthSummary.warning),
    siteCoverage: {
      ...packet.siteCoverage,
      representativePagesAttempted: Math.max(packet.siteCoverage.representativePagesAttempted, representativePages.length),
      representativePagesFetched: representativePages.filter((page) => page.fetchStatus !== null && !page.fetchError).length,
    },
  };
}

export async function ensureCanonicalServiceHubSampled(
  packet: BusinessAssetResearchPacket,
): Promise<BusinessAssetResearchPacket> {
  if (!packet.finalUrl || packet.fetchError) return packet;
  const serviceHubUrl = chooseCanonicalServiceHub(packet);
  if (!serviceHubUrl) return packet;
  if (packet.representativePages.some((page) => pathname(page.url) === pathname(serviceHubUrl))) return packet;
  const summary = await fetchCanonicalServiceHub(serviceHubUrl);
  return summary ? mergeCanonicalServiceHubSummary(packet, summary) : packet;
}
