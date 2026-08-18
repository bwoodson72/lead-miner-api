const MIN_REQUEST_INTERVAL_MS = 250;
const MAX_RETRIES = 3;

let queue: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(250, seconds * 1000);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(250, date - Date.now());
  }

  return 1000 * Math.pow(2, attempt);
}

async function runQueued<T>(work: () => Promise<T>): Promise<T> {
  const scheduled = queue.then(async () => {
    const elapsed = Date.now() - lastRequestStartedAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    lastRequestStartedAt = Date.now();
    return work();
  });

  queue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

export async function fetchSerperPlaces(
  apiKey: string,
  q: string,
  num = 20,
): Promise<Record<string, unknown> | null> {
  return runQueued(async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch("https://google.serper.dev/places", {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q, gl: "us", hl: "en", num }),
      });

      if (response.ok) return (await response.json()) as Record<string, unknown>;

      const body = await response.text();
      if (response.status !== 429 || attempt >= MAX_RETRIES) {
        console.error(`[Serper] Places error ${response.status} for ${q}: ${body}`);
        return null;
      }

      const delay = retryDelayMs(response, attempt);
      console.warn(`[Serper] Places rate limited for ${q}; retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      lastRequestStartedAt = Date.now();
    }

    return null;
  });
}
