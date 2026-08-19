import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("legacy research-ready helper reuses the contact-neutral canonical queue", async () => {
  const source = await readFile(new URL("../src/lib/research-routes.ts", import.meta.url), "utf8");
  const helper = source.match(/export async function processResearchReadyLeads[\s\S]*?\n\}/);
  assert.ok(helper, "processResearchReadyLeads must remain available for compatibility");
  assert.match(helper[0], /researchQueueWhere\(\)/);
  assert.doesNotMatch(helper[0], /email:\s*\{\s*not:\s*null/);
});

test("implicit bulk research selection uses the same canonical queue", async () => {
  const source = await readFile(new URL("../src/lib/research-routes.ts", import.meta.url), "utf8");
  const bulkRoute = source.match(/app\.post\("\/api\/leads\/bulk-research"[\s\S]*?\n  \}\);/);
  assert.ok(bulkRoute, "bulk research route must exist");
  assert.match(bulkRoute[0], /researchQueueWhere\(\)/);
  assert.doesNotMatch(bulkRoute[0], /skippedNoEmail/);
});

test("research error mapping has no contact-enrichment failure vocabulary", async () => {
  const source = await readFile(new URL("../src/lib/research-routes.ts", import.meta.url), "utf8");
  const mapper = source.match(/function statusForResearchError[\s\S]*?\n\}/);
  assert.ok(mapper);
  assert.doesNotMatch(mapper[0], /no email|enrichment.*exhausted|no email was persisted/i);
});
