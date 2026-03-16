export type PageSpeedResult = {
  performanceScore: number;
  lcp: number;
  cls: number;
  tbt: number;
  url: string;
};

export async function analyzeUrl(url: string): Promise<PageSpeedResult | null> {
  const { env } = await import("./env.js");

  const params = new URLSearchParams({
    url,
    key: env.PAGESPEED_API_KEY,
    strategy: "mobile",
    category: "performance",
  });

  const fetchUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`;

  console.log(`[PageSpeed] Analyzing: ${url}`);
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(fetchUrl, { signal: controller.signal });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await response.json()) as any;

    if (!data["lighthouseResult"]) {
      console.log(`[PageSpeed] No lighthouseResult for ${url}`);
      return null;
    }

    const lcp = data.lighthouseResult?.audits?.["largest-contentful-paint"]?.numericValue ?? 0;
    const cls = data.lighthouseResult?.audits?.["cumulative-layout-shift"]?.numericValue ?? 0;
    const tbt = data.lighthouseResult?.audits?.["total-blocking-time"]?.numericValue ?? 0;
    const scoreRaw = data.lighthouseResult?.categories?.performance?.score;
    const performanceScore = typeof scoreRaw === "number" ? Math.round(scoreRaw * 100) : 0;

    if (performanceScore === 0 && lcp === 0) {
      console.warn("[PageSpeed] Lighthouse likely failed for:", url, "— skipping");
      return null;
    }

    const elapsed = Date.now() - start;
    console.log(`[PageSpeed] Completed ${url} — score=${performanceScore}, elapsed=${elapsed}ms`);

    return { performanceScore, lcp, cls, tbt, url };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.log(`[PageSpeed] Timeout (45s) for ${url}`);
    } else {
      console.log(`[PageSpeed] Error analyzing ${url}:`, err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = index++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]!();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

export async function analyzeUrlsWithRateLimit(
  urls: { url: string; domain: string; keyword: string }[],
  maxDomains = 20,
  concurrency = 3
): Promise<Map<string, PageSpeedResult>> {
  const sliced = urls.slice(0, maxDomains);

  console.log(`[PageSpeed] Analyzing ${sliced.length} of ${urls.length} URLs (concurrency=${concurrency})`);

  const tasks = sliced.map(({ url, domain }) => async () => {
    const result = await analyzeUrl(url);
    return result ? { domain, result } : null;
  });

  const rawResults = await runWithConcurrency(tasks, concurrency);

  const map = new Map<string, PageSpeedResult>();
  for (const entry of rawResults) {
    if (entry) map.set(entry.domain, entry.result);
  }

  console.log(`[PageSpeed] Completed ${map.size} successful results`);
  return map;
}
