import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("identity search can recover imported leads by partial domain", async () => {
  const source = await readFile(new URL("../src/lib/crm-operations-routes.ts", import.meta.url), "utf8");
  const start = source.indexOf('app.get("/api/leads/identity-search"');
  assert.ok(start >= 0, "identity-search route should exist");
  const route = source.slice(start, source.indexOf('app.patch("/api/leads/:id/override"', start));
  assert.match(route, /domain:\{contains:search,mode:"insensitive"\}/);
  assert.match(route, /normalizedDomain:\{contains:search,mode:"insensitive"\}/);
  assert.match(route, /suppliedUrl:\{contains:search,mode:"insensitive"\}/);
  assert.match(route, /businessName:\{contains:search,mode:"insensitive"\}/);
});
