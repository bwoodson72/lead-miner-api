import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";

export type ProviderScrapeEvidence = {
  attempted: boolean;
  succeeded: boolean;
  requestedUrl: string;
  sourceUrl: string | null;
  title: string | null;
  text: string;
  wordCount: number;
  warning: string;
  error: string | null;
};

export const PROVIDER_SCRAPE_WARNING = "Provider scrape evidence comes from a current third-party webpage extraction of the requested URL. It is stronger than search-index snippets for current page text, but it is not Lead Miner's own rendered-browser inspection and cannot establish forms, click behavior, visual presentation, JavaScript-only interactions, or complete navigation.";

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeHost(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function firstString(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function parseProviderScrapeResponse(requestedUrl: string, data: Record<string, unknown>): ProviderScrapeEvidence {
  const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? data.metadata as Record<string, unknown>
    : {};

  const sourceUrl = firstString(data, ["url", "finalUrl", "sourceUrl"])
    || firstString(metadata, ["url", "canonical", "canonicalUrl"])
    || requestedUrl;
  const requestedHost = normalizeHost(requestedUrl);
  const sourceHost = normalizeHost(sourceUrl);
  if (!requestedHost || !sourceHost || requestedHost !== sourceHost) {
    return {
      attempted: true,
      succeeded: false,
      requestedUrl,
      sourceUrl: sourceUrl || null,
      title: null,
      text: "",
      wordCount: 0,
      warning: PROVIDER_SCRAPE_WARNING,
      error: "Provider scrape returned content for a different domain",
    };
  }

  const title = firstString(data, ["title"])
    || firstString(metadata, ["title", "og:title"])
    || null;
  const rawMarkdown = firstString(data, ["markdown"]);
  const rawText = firstString(data, ["text", "content", "body"]);
  const rawHtml = firstString(data, ["html"]);
  const text = (rawText ? clean(rawText) : rawMarkdown ? stripMarkdown(rawMarkdown) : rawHtml ? stripHtml(rawHtml) : "").slice(0, 18000);
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

  return {
    attempted: true,
    succeeded: wordCount >= 40,
    requestedUrl,
    sourceUrl,
    title,
    text,
    wordCount,
    warning: PROVIDER_SCRAPE_WARNING,
    error: wordCount >= 40 ? null : "Provider scrape returned insufficient page text",
  };
}

export async function fetchProviderScrapeEvidence(url: string): Promise<ProviderScrapeEvidence> {
  try {
    const env = getEnv();
    const response = await fetchWithProviderBackoff(
      "https://scrape.serper.dev",
      {
        method: "POST",
        headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ url, includeMarkdown: true }),
      },
      "Serper live webpage scrape",
    );

    if (!response.ok) {
      return {
        attempted: true,
        succeeded: false,
        requestedUrl: url,
        sourceUrl: null,
        title: null,
        text: "",
        wordCount: 0,
        warning: PROVIDER_SCRAPE_WARNING,
        error: `Provider scrape returned HTTP ${response.status}`,
      };
    }

    const data = await response.json() as Record<string, unknown>;
    return parseProviderScrapeResponse(url, data);
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      requestedUrl: url,
      sourceUrl: null,
      title: null,
      text: "",
      wordCount: 0,
      warning: PROVIDER_SCRAPE_WARNING,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
