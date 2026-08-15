import { detectAgency } from "./agency-filter.js";
import { detectNationalChain } from "./chain-filter.js";
import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";

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

export type EnrichmentInput = { url: string; existingBusinessName?: string };

type FetchResult = { html: string; finalUrl: string } | null;

function browserHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
  };
}

async function fetchHtml(url: string, timeoutMs = 8_000, quiet404 = false): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: browserHeaders(), redirect: "follow" });
    if (!response.ok) {
      if (!(quiet404 && response.status === 404)) console.log(`[Enrichment] Fetch failed for ${url}: ${response.status}`);
      return null;
    }
    return { html: await response.text(), finalUrl: response.url || url };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") console.log(`[Enrichment] Timeout fetching ${url}`);
    else console.log(`[Enrichment] Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally { clearTimeout(timer); }
}

function rootVariants(input: string): string[] {
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\./, "");
    return Array.from(new Set([
      input,
      `https://${host}/`,
      `https://www.${host}/`,
      `http://${host}/`,
      `http://www.${host}/`,
    ]));
  } catch { return [input]; }
}

async function fetchHomepage(input: string): Promise<FetchResult> {
  for (const candidate of rootVariants(input)) {
    const result = await fetchHtml(candidate);
    if (result) return result;
  }
  return null;
}

function extractBusinessName(html: string): string | undefined {
  const og = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
  if (og?.[1]) return og[1].trim();
  const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ");
  if (title && title.length > 3 && title.length < 120) return title;
  const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/is)?.[1]?.replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ");
  return h1 && h1.length > 3 && h1.length < 120 ? h1 : undefined;
}

function isValidEmail(email: string) { return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email); }
function isCommonPlaceholder(email: string) {
  const bad = ["example.com","test.com","demo.com","yoursite.com","yourdomain.com","business.com","company.com","website.com","email.com","mail.com","domain.com","site.com","mysite.com","mycompany.com","mybusiness.com","mailservice.com","sentry.io"];
  return /\.(png|jpg|jpeg|webp|svg|gif)$/i.test(email) || bad.some((d) => email.endsWith(d));
}

function decodeCloudflareEmail(hex: string): string | null {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return isValidEmail(out) ? out.toLowerCase() : null;
  } catch { return null; }
}

function extractEmails(html: string): string[] {
  const emails = new Set<string>();
  const add = (value: string | null | undefined) => {
    const email = value?.trim().toLowerCase();
    if (email && isValidEmail(email) && !isCommonPlaceholder(email)) emails.add(email);
  };
  let match: RegExpExecArray | null;
  const mailto = /href=["']mailto:([^"']+)["']/gi;
  while ((match = mailto.exec(html)) !== null) add(match[1]?.split("?")[0]);
  for (const email of html.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? []) add(email);
  const cf = /data-cfemail=["']([0-9a-f]+)["']/gi;
  while ((match = cf.exec(html)) !== null) add(decodeCloudflareEmail(match[1] ?? ""));
  const plain = html.replace(/<script[^>]*>.*?<\/script>/gis, " ").replace(/<style[^>]*>.*?<\/style>/gis, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ");
  const obfuscated = /\b([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\sat\s)\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*([a-z]{2,})\b/gi;
  while ((match = obfuscated.exec(plain)) !== null) add(`${match[1]}@${match[2]}.${match[3]}`);
  return [...emails];
}

function pickBestEmail(emails: string[], siteDomain: string): string | undefined {
  const filtered = emails.filter((e) => !isCommonPlaceholder(e));
  if (!filtered.length) return undefined;
  const sameDomain = filtered.filter((e) => { const d = e.split("@")[1] ?? ""; return d === siteDomain || d.endsWith(`.${siteDomain}`); });
  const roleOrder = ["info","contact","hello","sales","office","admin","support","service","estimates"];
  return [...(sameDomain.length ? sameDomain : filtered)].sort((a,b) => {
    const ai = roleOrder.indexOf(a.split("@")[0] ?? ""); const bi = roleOrder.indexOf(b.split("@")[0] ?? "");
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  })[0];
}

function extractPhones(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) if (m[1]) out.add(m[1].replace(/[^\d+]/g,""));
  const text = html.replace(/<script[^>]*>.*?<\/script>/gis," ");
  for (const m of text.matchAll(/(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/g)) out.add(m[0].replace(/[^\d+]/g,""));
  return [...out];
}

function pickBestPhone(phones: string[]): string | undefined {
  return phones.map((p) => p.replace(/\D/g,"" )).map((d) => d.length === 11 && d.startsWith("1") ? d.slice(1) : d).find((d) => d.length === 10);
}

function scoreContactUrl(url: string, text = "") {
  const haystack = `${url} ${text}`.toLowerCase();
  let score = 0;
  if (/contact|get-in-touch|reach-us/.test(haystack)) score += 100;
  if (/about|team|staff|our-company/.test(haystack)) score += 60;
  if (/location|office/.test(haystack)) score += 40;
  if (/quote|estimate/.test(haystack)) score += 30;
  return score;
}

function discoverUsefulPages(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const rows: Array<{ url: string; score: number }> = [];
  for (const m of html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const resolved = new URL(m[1] ?? "", baseUrl); resolved.hash = "";
      if (resolved.hostname.replace(/^www\./,"") !== base.hostname.replace(/^www\./,"")) continue;
      const text = (m[2] ?? "").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      const score = scoreContactUrl(resolved.toString(), text);
      if (score) rows.push({ url: resolved.toString(), score });
    } catch { /* skip */ }
  }
  return [...new Map(rows.sort((a,b)=>b.score-a.score).map((r)=>[r.url,r])).values()].slice(0, 8).map((r)=>r.url);
}

function extractSitemapUrls(xml: string, origin: string): string[] {
  const host = new URL(origin).hostname.replace(/^www\./,"");
  const urls: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
    try {
      const u = new URL(m[1]!.trim());
      if (u.hostname.replace(/^www\./,"") !== host) continue;
      if (scoreContactUrl(u.toString())) urls.push(u.toString());
    } catch { /* skip */ }
  }
  return urls.slice(0, 12);
}

async function discoverFromSitemap(baseUrl: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const paths = ["/sitemap.xml","/sitemap_index.xml","/wp-sitemap.xml"];
  const urls: string[] = [];
  for (const path of paths) {
    const result = await fetchHtml(new URL(path, origin).toString(), 5_000, true);
    if (!result) continue;
    urls.push(...extractSitemapUrls(result.html, origin));
    if (urls.length >= 8) break;
  }
  return [...new Set(urls)].slice(0,8);
}

async function serperEmailSearch(domain: string, businessName?: string): Promise<string | undefined> {
  const env = getEnv();
  const queries = [`site:${domain} "@${domain}"`, businessName ? `"${businessName}" email` : `"${domain}" email`];
  for (const q of queries) {
    try {
      const response = await fetchWithProviderBackoff("https://google.serper.dev/search", { method:"POST", headers:{"X-API-KEY":env.SERPER_API_KEY,"Content-Type":"application/json"}, body:JSON.stringify({ q, gl:"us", hl:"en", num:10 }) }, "Serper email search");
      if (!response.ok) continue;
      const data = await response.json() as Record<string, unknown>;
      const chunks: string[] = [];
      for (const row of Array.isArray(data.organic) ? data.organic as Record<string,unknown>[] : []) chunks.push(String(row.title ?? ""), String(row.snippet ?? ""), String(row.link ?? ""));
      chunks.push(JSON.stringify(data));
      const best = pickBestEmail(extractEmails(chunks.join("\n")), domain);
      if (best) return best;
    } catch { /* search fallback is best-effort */ }
  }
  return undefined;
}

export async function enrichLeadFromSite(input: EnrichmentInput): Promise<EnrichmentResult> {
  const startTime = Date.now(); const notes: string[] = [];
  console.log(`[Enrichment] Starting enrichment for ${input.url}`);
  const inputDomain = new URL(input.url).hostname.replace(/^www\./,"");
  const homepage = await fetchHomepage(input.url);
  if (!homepage) {
    notes.push("Homepage unavailable across protocol/host variants");
    const indexedEmail = await serperEmailSearch(inputDomain, input.existingBusinessName);
    const elapsed = Date.now() - startTime;
    if (indexedEmail) {
      notes.push("Found email via search-index fallback despite unreachable site");
      console.log(`[Enrichment] Completed ${input.url} — status=enriched, email=yes, source=search-index, elapsed=${elapsed}ms`);
      return { ...(input.existingBusinessName && { businessName: input.existingBusinessName }), email: indexedEmail, enrichmentStatus: "enriched", enrichmentNotes: `${notes.join("; ")}; elapsed=${elapsed}ms` };
    }
    console.log(`[Enrichment] Completed ${input.url} — status=failed, email=no, source=search-index-exhausted, elapsed=${elapsed}ms`);
    return { enrichmentStatus:"failed", enrichmentNotes:`${notes.join("; ")}; search-index fallback found no email; elapsed=${elapsed}ms` };
  }

  const url = homepage.finalUrl;
  const siteDomain = new URL(url).hostname.replace(/^www\./,"");
  const businessName = input.existingBusinessName || extractBusinessName(homepage.html);
  let email = pickBestEmail(extractEmails(homepage.html), siteDomain);
  let phone = pickBestPhone(extractPhones(homepage.html));
  let contactPageUrl: string | undefined;
  notes.push(`Fetched ${url}`);
  if (email) notes.push("Found email on homepage");

  const agencyDetection = detectAgency(homepage.html);
  const chainDetection = detectNationalChain(homepage.html, undefined, siteDomain);

  if (!email && (agencyDetection.isAgencyManaged || chainDetection.isNationalChain)) {
    const reason = agencyDetection.isAgencyManaged
      ? `agency-managed${agencyDetection.agencyName ? ` (${agencyDetection.agencyName})` : ""}`
      : `national chain${chainDetection.reason ? ` (${chainDetection.reason})` : ""}`;
    notes.push(`Stopped email discovery early: ${reason}`);
    const elapsed = Date.now() - startTime;
    console.log(`[Enrichment] Completed ${input.url} — status=skipped, email=no, reason=${reason}, elapsed=${elapsed}ms`);
    return {
      ...(businessName && { businessName }), ...(phone && { phone }), enrichmentStatus: "skipped", enrichmentNotes: `${notes.join("; ")}; elapsed=${elapsed}ms`,
      isAgencyManaged: agencyDetection.isAgencyManaged, ...(agencyDetection.agencyName && { agencyName:agencyDetection.agencyName }),
      isNationalChain: chainDetection.isNationalChain, ...(chainDetection.reason && { chainReason:chainDetection.reason }),
    };
  }

  if (!email) {
    const realLinks = discoverUsefulPages(homepage.html, url);
    const sitemapLinks = realLinks.length < 3 ? await discoverFromSitemap(url) : [];
    const candidates = [...new Set([...realLinks, ...sitemapLinks])].slice(0,8);
    if (candidates.length) notes.push(`Discovered ${candidates.length} real contact/about page(s)`);
    for (const pageUrl of candidates) {
      const page = await fetchHtml(pageUrl, 6_000, true);
      if (!page) continue;
      email ||= pickBestEmail(extractEmails(page.html), siteDomain);
      phone ||= pickBestPhone(extractPhones(page.html));
      if (email) { contactPageUrl = page.finalUrl; notes.push(`Found email on ${new URL(page.finalUrl).pathname}`); break; }
    }
  }

  if (!email) {
    email = await serperEmailSearch(siteDomain, businessName);
    if (email) notes.push("Found email via search-index fallback");
  }

  if (!email) notes.push("No usable email found; AI research should be skipped");
  const elapsed = Date.now() - startTime;
  const enrichmentNotes = `${notes.join("; ")}; elapsed=${elapsed}ms`;
  console.log(`[Enrichment] Completed ${input.url} — status=enriched, email=${email ? "yes" : "no"}, elapsed=${elapsed}ms`);

  return {
    ...(businessName && { businessName }), ...(contactPageUrl && { contactPageUrl }), ...(email && { email }), ...(phone && { phone }),
    enrichmentStatus:"enriched", enrichmentNotes,
    isAgencyManaged: agencyDetection.isAgencyManaged, ...(agencyDetection.agencyName && { agencyName:agencyDetection.agencyName }),
    isNationalChain: chainDetection.isNationalChain, ...(chainDetection.reason && { chainReason:chainDetection.reason }),
  };
}
