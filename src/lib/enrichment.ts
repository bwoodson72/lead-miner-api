import { detectAgency } from "./agency-filter.js";
import { detectNationalChain } from "./chain-filter.js";

export type EnrichmentResult = {
  businessName?: string;
  contactPageUrl?: string;
  email?: string;
  phone?: string;
  address?: string;
  enrichmentStatus: "enriched" | "failed" | "skipped";
  enrichmentNotes: string;
  isAgencyManaged?: boolean;
  agencyName?: string;
  isNationalChain?: boolean;
  chainReason?: string;
};

export type EnrichmentInput = {
  url: string;
  existingBusinessName?: string;
};

async function fetchHtml(url: string, timeoutMs = 10_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; LeadEnrichmentBot/1.0)" }, redirect: "follow" });
    if (!response.ok) { console.log(`[Enrichment] Fetch failed for ${url}: ${response.status}`); return null; }
    return await response.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") console.log(`[Enrichment] Timeout fetching ${url}`);
    else console.log(`[Enrichment] Error fetching ${url}:`, err);
    return null;
  } finally { clearTimeout(timer); }
}

function extractBusinessName(html: string): string | undefined {
  const ogSiteNameMatch = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
  if (ogSiteNameMatch?.[1]) return ogSiteNameMatch[1].trim();
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleMatch?.[1]) { const title = titleMatch[1].trim().replace(/\s+/g, " "); if (title.length > 3 && title.length < 100) return title; }
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1Match?.[1]) { const h1Text = h1Match[1].replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " "); if (h1Text.length > 3 && h1Text.length < 100) return h1Text; }
  return undefined;
}

function isValidEmail(email: string): boolean { return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email); }
function isCommonPlaceholder(email: string): boolean {
  const placeholders = ["example.com", "test.com", "demo.com", "yoursite.com", "yourdomain.com", "business.com", "company.com", "website.com", "email.com", "mail.com", "domain.com", "site.com", "mysite.com", "mycompany.com", "mybusiness.com", "mailservice.com"];
  if (/\.(png|jpg|webp|svg|gif)$/i.test(email)) return true;
  return placeholders.some((p) => email.endsWith(p));
}

function extractEmails(html: string): string[] {
  const emails = new Set<string>();
  const mailtoRegex = /href=["']mailto:([^"']+)["']/gi;
  let match;
  while ((match = mailtoRegex.exec(html)) !== null) {
    const email = match[1]?.split("?")[0]?.trim().toLowerCase();
    if (email && isValidEmail(email) && !isCommonPlaceholder(email)) emails.add(email);
  }
  const textContent = html.replace(/<script[^>]*>.*?<\/script>/gis, " ");
  for (const email of textContent.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? []) {
    const normalized = email.toLowerCase();
    if (isValidEmail(normalized) && !isCommonPlaceholder(normalized)) emails.add(normalized);
  }
  // Recover common human-readable obfuscation: name [at] domain [dot] com.
  const plain = textContent.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ");
  const obfuscated = /\b([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\sat\s)\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*([a-z]{2,})\b/gi;
  while ((match = obfuscated.exec(plain)) !== null) {
    const email = `${match[1]}@${match[2]}.${match[3]}`.toLowerCase();
    if (isValidEmail(email) && !isCommonPlaceholder(email)) emails.add(email);
  }
  return Array.from(emails);
}

function pickBestEmail(emails: string[], siteDomain: string): string | undefined {
  const filtered = emails.filter((e) => !isCommonPlaceholder(e));
  if (!filtered.length) return undefined;
  const domainMatches = filtered.filter((e) => { const d = e.split("@")[1] ?? ""; return d === siteDomain || d.endsWith("." + siteDomain); });
  const roleOrder = ["info", "contact", "hello", "sales", "office", "admin", "support"];
  const ranked = (domainMatches.length ? domainMatches : filtered).sort((a, b) => {
    const al = a.split("@")[0] ?? ""; const bl = b.split("@")[0] ?? "";
    const ai = roleOrder.indexOf(al); const bi = roleOrder.indexOf(bl);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return ranked[0];
}

function extractPhones(html: string): string[] {
  const phones = new Set<string>(); let match;
  const telRegex = /href=["']tel:([^"']+)["']/gi;
  while ((match = telRegex.exec(html)) !== null) { const phone = match[1]?.trim(); if (phone) phones.add(phone.replace(/[^\d+]/g, "")); }
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/g;
  const textContent = html.replace(/<script[^>]*>.*?<\/script>/gis, "");
  while ((match = phoneRegex.exec(textContent)) !== null) phones.add(match[0].replace(/[^\d+]/g, ""));
  return Array.from(phones);
}

function pickBestPhone(phones: string[], html: string): string | undefined {
  const valid = phones.map((p) => { const digits = p.replace(/\D/g, ""); return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits; }).filter((d) => d.length === 10);
  if (!valid.length) return undefined; if (valid.length === 1) return valid[0];
  const counts = new Map<string, number>();
  for (const digits of valid) { const pattern = digits.replace(/(\d{3})(\d{3})(\d{4})/, "$1.{0,2}$2.{0,2}$3"); counts.set(digits, (html.match(new RegExp(pattern, "g")) ?? []).length); }
  return valid.reduce((best, cur) => (counts.get(cur)! > counts.get(best)! ? cur : best));
}

function extractContactPages(html: string, baseUrl: string): string[] {
  const pages: string[] = []; const keywords = ["contact", "about", "team", "staff", "locations", "reach", "get-in-touch", "quote", "estimate"];
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis; let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]; const text = match[2]?.replace(/<[^>]+>/g, "").trim().toLowerCase(); if (!href) continue;
    if (!keywords.some((kw) => (text ?? "").includes(kw) || href.toLowerCase().includes(kw))) continue;
    try { const resolved = new URL(href, baseUrl); if (resolved.origin === new URL(baseUrl).origin) pages.push(resolved.href); } catch { /* skip */ }
  }
  return Array.from(new Set(pages)).slice(0, 8);
}

function commonContactCandidates(baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  return ["/contact", "/contact-us", "/about", "/about-us", "/team", "/staff", "/locations", "/get-a-quote"].map((p) => new URL(p, origin).href);
}

export async function enrichLeadFromSite(input: EnrichmentInput): Promise<EnrichmentResult> {
  const { url, existingBusinessName } = input;
  console.log(`[Enrichment] Starting enrichment for ${url}`);
  const startTime = Date.now(); const notes: string[] = [];
  let businessName = existingBusinessName; let email: string | undefined; let phone: string | undefined; let contactPageUrl: string | undefined; let address: string | undefined;

  const homepageHtml = await fetchHtml(url);
  if (!homepageHtml) return { enrichmentStatus: "failed", enrichmentNotes: "Failed to fetch homepage" };
  notes.push("Fetched homepage");

  const siteDomain = new URL(url).hostname.replace(/^www\./, "");
  const agencyDetection = detectAgency(homepageHtml);
  const chainDetection = detectNationalChain(homepageHtml, undefined, siteDomain);
  if (agencyDetection.isAgencyManaged) notes.push(`Agency detected: ${agencyDetection.agencyName}`);
  if (chainDetection.isNationalChain) notes.push(`National chain detected: ${chainDetection.reason}`);
  if (!businessName) { businessName = extractBusinessName(homepageHtml); if (businessName) notes.push("Extracted business name from homepage"); }

  const homepageEmails = extractEmails(homepageHtml);
  if (homepageEmails.length) { email = pickBestEmail(homepageEmails, siteDomain); notes.push(`Found ${homepageEmails.length} email(s) on homepage`); }
  const homepagePhones = extractPhones(homepageHtml);
  if (homepagePhones.length) { phone = pickBestPhone(homepagePhones, homepageHtml); notes.push(`Found ${homepagePhones.length} phone(s) on homepage`); }

  const discovered = extractContactPages(homepageHtml, url);
  const candidates = Array.from(new Set([...discovered, ...(!email ? commonContactCandidates(url) : [])])).slice(0, email ? 3 : 8);
  if (candidates.length) notes.push(`Queued ${candidates.length} contact/about candidate page(s)`);

  for (const pageUrl of candidates) {
    const pageHtml = await fetchHtml(pageUrl, 7_500); if (!pageHtml) continue;
    notes.push(`Visited ${new URL(pageUrl).pathname}`);
    if (!email) { const best = pickBestEmail(extractEmails(pageHtml), siteDomain); if (best) { email = best; contactPageUrl = pageUrl; notes.push("Found email on secondary page"); } }
    if (!phone) { const best = pickBestPhone(extractPhones(pageHtml), pageHtml); if (best) { phone = best; if (!contactPageUrl) contactPageUrl = pageUrl; notes.push("Found phone on secondary page"); } }
    if (email && phone) break;
  }

  const elapsed = Date.now() - startTime;
  if (!email) notes.push("No usable email found; AI research should be skipped");
  const enrichmentNotes = `${notes.join("; ")}; elapsed=${elapsed}ms`;
  const hasAnyData = businessName || email || phone || contactPageUrl;
  const enrichmentStatus = hasAnyData ? "enriched" : "failed";
  console.log(`[Enrichment] Completed ${url} — status=${enrichmentStatus}, email=${email ? "yes" : "no"}, elapsed=${elapsed}ms`);

  return { ...(businessName && { businessName }), ...(contactPageUrl && { contactPageUrl }), ...(email && { email }), ...(phone && { phone }), ...(address && { address }), enrichmentStatus, enrichmentNotes, isAgencyManaged: agencyDetection.isAgencyManaged, ...(agencyDetection.agencyName && { agencyName: agencyDetection.agencyName }), isNationalChain: chainDetection.isNationalChain, ...(chainDetection.reason && { chainReason: chainDetection.reason }) };
}
