import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";

export type SearchIndexPage = {
  url: string;
  title: string;
  snippet: string;
  type: "service" | "location" | "about" | "contact" | "other";
};

export type SearchIndexEvidence = {
  attempted: boolean;
  succeeded: boolean;
  pages: SearchIndexPage[];
  warning: string;
  error: string | null;
};

export const SEARCH_INDEX_WARNING = "Search-index evidence comes from current Google search results, not a direct rendered-page inspection. It can support bounded evidence about first-party page topics and apparent site structure, but indexed titles/snippets may lag the live site. It cannot establish live visitor reachability, rendered interactions, forms, or current page completeness.";

function normalizeHost(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function classifyIndexedUrl(url: string, title: string, snippet: string): SearchIndexPage["type"] {
  let path = url.toLowerCase();
  try { path = new URL(url).pathname.toLowerCase(); } catch { /* retain raw */ }
  const haystack = `${path} ${title} ${snippet}`.toLowerCase();
  if (/contact|quote|estimate|get.?a.?quote|book|schedule|inspection|request/.test(haystack)) return "contact";
  if (/about|our-story|company|team|who-we-are/.test(haystack)) return "about";
  if (/location|service-area|areas-we-serve|locations|city|county/.test(haystack)) return "location";
  if (/service|repair|install|replacement|remodel|roof|plumb|electric|hvac|landscap|foundation|concrete|kitchen|bath|paint|clean|construction|siding|gutter/.test(haystack)) return "service";
  return "other";
}

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export async function fetchSearchIndexEvidence(url: string): Promise<SearchIndexEvidence> {
  const host = normalizeHost(url);
  if (!host) return { attempted: false, succeeded: false, pages: [], warning: SEARCH_INDEX_WARNING, error: "Invalid target URL" };

  try {
    const env = getEnv();
    const response = await fetchWithProviderBackoff(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q: `site:${host}`, gl: "us", hl: "en", num: 10 }),
      },
      "Serper research index fallback",
    );

    if (!response.ok) {
      return { attempted: true, succeeded: false, pages: [], warning: SEARCH_INDEX_WARNING, error: `Serper returned HTTP ${response.status}` };
    }

    const data = await response.json() as Record<string, unknown>;
    const rows = Array.isArray(data.organic) ? data.organic as Record<string, unknown>[] : [];
    const pages = new Map<string, SearchIndexPage>();

    const add = (candidate: Record<string, unknown>, fallbackSnippet = "") => {
      const link = clean(candidate.link);
      if (!link || normalizeHost(link) !== host) return;
      const title = clean(candidate.title);
      const snippet = clean(candidate.snippet) || fallbackSnippet;
      if (!pages.has(link)) pages.set(link, { url: link, title, snippet, type: classifyIndexedUrl(link, title, snippet) });
    };

    for (const row of rows) {
      const snippet = clean(row.snippet);
      add(row);
      if (Array.isArray(row.sitelinks)) {
        for (const sitelink of row.sitelinks as Record<string, unknown>[]) add(sitelink, snippet);
      }
    }

    const selected = [...pages.values()].slice(0, 12);
    return {
      attempted: true,
      succeeded: selected.length > 0,
      pages: selected,
      warning: SEARCH_INDEX_WARNING,
      error: selected.length ? null : "No same-domain indexed pages were returned",
    };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      pages: [],
      warning: SEARCH_INDEX_WARNING,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
