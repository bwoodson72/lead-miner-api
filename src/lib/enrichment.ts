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

// Fetch HTML with timeout
async function fetchHtml(url: string, timeoutMs = 10_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LeadEnrichmentBot/1.0)",
      },
    });

    if (!response.ok) {
      console.log(`[Enrichment] Fetch failed for ${url}: ${response.status}`);
      return null;
    }

    const html = await response.text();
    return html;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.log(`[Enrichment] Timeout fetching ${url}`);
    } else {
      console.log(`[Enrichment] Error fetching ${url}:`, err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Extract business name from HTML
function extractBusinessName(html: string): string | undefined {
  // Try <title>
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleMatch?.[1]) {
    const title = titleMatch[1].trim().replace(/\s+/g, " ");
    if (title.length > 3 && title.length < 100) {
      return title;
    }
  }

  // Try og:site_name
  const ogSiteNameMatch = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
  if (ogSiteNameMatch?.[1]) {
    return ogSiteNameMatch[1].trim();
  }

  // Try first <h1>
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1Match?.[1]) {
    const h1Text = h1Match[1].replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ");
    if (h1Text.length > 3 && h1Text.length < 100) {
      return h1Text;
    }
  }

  return undefined;
}

// Extract emails from HTML
function extractEmails(html: string): string[] {
  const emails = new Set<string>();

  // Extract mailto: links
  const mailtoRegex = /href=["']mailto:([^"']+)["']/gi;
  let match;
  while ((match = mailtoRegex.exec(html)) !== null) {
    const email = match[1]?.split("?")[0]?.trim().toLowerCase();
    if (email && isValidEmail(email)) {
      emails.add(email);
    }
  }

  // Extract visible email addresses
  const visibleEmailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
  const textContent = html.replace(/<script[^>]*>.*?<\/script>/gis, "");
  const matches = textContent.match(visibleEmailRegex);
  if (matches) {
    for (const email of matches) {
      const normalized = email.toLowerCase();
      if (isValidEmail(normalized) && !isCommonPlaceholder(normalized)) {
        emails.add(normalized);
      }
    }
  }

  return Array.from(emails);
}

// Validate email format
function isValidEmail(email: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email);
}

// Filter out common placeholder emails
function isCommonPlaceholder(email: string): boolean {
  const placeholders = [
    "example.com", "test.com", "demo.com", "yoursite.com", "yourdomain.com",
    "business.com", "company.com", "website.com", "email.com", "mail.com",
    "domain.com", "site.com", "mysite.com", "mycompany.com", "mybusiness.com",
  ];
  return placeholders.some((p) => email.endsWith(p));
}

// Pick the best email from a list, preferring ones that match the site's root domain
function pickBestEmail(emails: string[], siteDomain: string): string | undefined {
  if (emails.length === 0) return undefined;

  const filtered = emails.filter((e) => !isCommonPlaceholder(e));
  if (filtered.length === 0) return undefined;

  const domainMatch = filtered.find((e) => {
    const emailDomain = e.split("@")[1] ?? "";
    return emailDomain === siteDomain || emailDomain.endsWith("." + siteDomain);
  });

  return domainMatch ?? filtered[0];
}

// Extract phone numbers from HTML
function extractPhones(html: string): string[] {
  const phones = new Set<string>();

  // Extract tel: links
  const telRegex = /href=["']tel:([^"']+)["']/gi;
  let match;
  while ((match = telRegex.exec(html)) !== null) {
    const phone = match[1]?.trim();
    if (phone) {
      phones.add(normalizePhone(phone));
    }
  }

  // Extract visible phone patterns (US/international formats)
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/g;
  const textContent = html.replace(/<script[^>]*>.*?<\/script>/gis, "");
  while ((match = phoneRegex.exec(textContent)) !== null) {
    const phone = match[0];
    phones.add(normalizePhone(phone));
  }

  return Array.from(phones);
}

// Normalize phone number
function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

// Extract contact page URLs
function extractContactPages(html: string, baseUrl: string): string[] {
  const contactPages: string[] = [];
  const keywords = ["contact", "about", "locations", "reach", "get-in-touch"];

  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const linkText = match[2]?.replace(/<[^>]+>/g, "").trim().toLowerCase();

    if (!href || !linkText) continue;

    const matchesKeyword = keywords.some((kw) => linkText.includes(kw) || href.toLowerCase().includes(kw));

    if (matchesKeyword) {
      try {
        const resolvedUrl = new URL(href, baseUrl);
        const baseOrigin = new URL(baseUrl).origin;

        // Only include same-origin URLs
        if (resolvedUrl.origin === baseOrigin) {
          contactPages.push(resolvedUrl.href);
        }
      } catch {
        // Invalid URL, skip
      }
    }
  }

  return contactPages.slice(0, 5); // Limit to 5 candidates
}

// Main enrichment function
export async function enrichLeadFromSite(input: EnrichmentInput): Promise<EnrichmentResult> {
  const { url, existingBusinessName } = input;

  console.log(`[Enrichment] Starting enrichment for ${url}`);

  const startTime = Date.now();
  const notes: string[] = [];

  let businessName = existingBusinessName;
  let email: string | undefined;
  let phone: string | undefined;
  let contactPageUrl: string | undefined;
  let address: string | undefined;

  // Fetch homepage
  const homepageHtml = await fetchHtml(url);
  if (!homepageHtml) {
    return {
      enrichmentStatus: "failed",
      enrichmentNotes: "Failed to fetch homepage",
    };
  }

  notes.push("Fetched homepage");

  // Detect agency and national chain
  const siteDomainForChain = new URL(url).hostname.replace(/^www\./, "");
  const agencyDetection = detectAgency(homepageHtml);
  const chainDetection = detectNationalChain(homepageHtml, undefined, siteDomainForChain);
  if (agencyDetection.isAgencyManaged) {
    notes.push(`Agency detected: ${agencyDetection.agencyName}`);
  }
  if (chainDetection.isNationalChain) {
    notes.push(`National chain detected: ${chainDetection.reason}`);
  }

  // Extract from homepage
  if (!businessName) {
    businessName = extractBusinessName(homepageHtml);
    if (businessName) notes.push("Extracted business name from homepage");
  }

  const siteDomain = new URL(url).hostname.replace(/^www\./, "");
  const homepageEmails = extractEmails(homepageHtml);
  if (homepageEmails.length > 0) {
    email = pickBestEmail(homepageEmails, siteDomain);
    notes.push(`Found ${homepageEmails.length} email(s) on homepage`);
  }

  const homepagePhones = extractPhones(homepageHtml);
  if (homepagePhones.length > 0) {
    phone = homepagePhones[0];
    notes.push(`Found ${homepagePhones.length} phone(s) on homepage`);
  }

  // Find contact pages
  const contactPages = extractContactPages(homepageHtml, url);
  if (contactPages.length > 0) {
    notes.push(`Found ${contactPages.length} potential contact page(s)`);
  }

  // Follow up to 2 contact pages for additional info
  const pagesToVisit = contactPages.slice(0, 2);
  for (const pageUrl of pagesToVisit) {
    const pageHtml = await fetchHtml(pageUrl);
    if (!pageHtml) continue;

    notes.push(`Visited ${new URL(pageUrl).pathname}`);

    // Extract additional emails
    if (!email) {
      const pageEmails = extractEmails(pageHtml);
      const best = pickBestEmail(pageEmails, siteDomain);
      if (best) {
        email = best;
        contactPageUrl = pageUrl;
        notes.push(`Found email on contact page`);
      }
    }

    // Extract additional phones
    if (!phone) {
      const pagePhones = extractPhones(pageHtml);
      if (pagePhones.length > 0) {
        phone = pagePhones[0];
        if (!contactPageUrl) contactPageUrl = pageUrl;
        notes.push(`Found phone on contact page`);
      }
    }

    // Stop early if we have both email and phone
    if (email && phone) break;
  }

  const elapsed = Date.now() - startTime;
  const enrichmentNotes = `${notes.join("; ")}; elapsed=${elapsed}ms`;

  // Determine status
  const hasAnyData = businessName || email || phone || contactPageUrl;
  const enrichmentStatus = hasAnyData ? "enriched" : "failed";

  console.log(`[Enrichment] Completed ${url} — status=${enrichmentStatus}, elapsed=${elapsed}ms`);

  return {
    ...(businessName && { businessName }),
    ...(contactPageUrl && { contactPageUrl }),
    ...(email && { email }),
    ...(phone && { phone }),
    ...(address && { address }),
    enrichmentStatus,
    enrichmentNotes,
    isAgencyManaged: agencyDetection.isAgencyManaged,
    ...(agencyDetection.agencyName && { agencyName: agencyDetection.agencyName }),
    isNationalChain: chainDetection.isNationalChain,
    ...(chainDetection.reason && { chainReason: chainDetection.reason }),
  };
}
