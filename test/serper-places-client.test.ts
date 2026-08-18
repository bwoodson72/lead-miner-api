import assert from "node:assert/strict";
import test from "node:test";
import { fetchSerperPlaces } from "../src/lib/serper-places-client.js";

test("Serper Places retries a 429 instead of treating it as an empty search", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }

    return new Response(JSON.stringify({ places: [{ title: "Example HVAC", website: "https://example.com" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await fetchSerperPlaces("test-key", "hvac Albuquerque NM");
    assert.equal(calls, 2);
    assert.ok(result);
    assert.equal(Array.isArray(result.places), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
