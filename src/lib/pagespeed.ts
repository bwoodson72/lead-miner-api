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
    const data = (await response.json()) as Record<string, unknown>;

    if (!data["lighthouseResult"]) {
      console.log(`[PageSpeed] No lighthouseResult for ${url}`);
      return null;
    }

    const lr = data["lighthouseResult"] as Record<string, unknown>;
    const categories = lr["categories"] as Record<string, unknown>;
    const audits = lr["audits"] as Record<string, unknown>;

    const perf = categories["performance"] as Record<string, unknown>;
    const lcpAudit = audits["largest-contentful-paint"] as Record<string, unknown>;
    const clsAudit = audits["cumulative-layout-shift"] as Record<string, unknown>;
    const tbtAudit = audits["total-blocking-time"] as Record<string, unknown>;

    const performanceScore = Math.round((perf["score"] as number) * 100);
    const lcp = lcpAudit["numericValue"] as number;
    const cls = clsAudit["numericValue"] as number;
    const tbt = tbtAudit["numericValue"] as number;

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
