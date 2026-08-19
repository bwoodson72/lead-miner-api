import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("automation researches before qualified contact enrichment", async () => {
  const source = await readFile(new URL("../src/lib/automation-routes.ts", import.meta.url), "utf8");
  const tickOrder = source.match(/\["sync_replies", "revisit_due", "research", "enrich", "recalculate_priorities", "prepare_outreach"\]/);
  assert.ok(tickOrder, "candidate-first tick order must keep research before contact enrichment");
});

test("automation status reuses canonical research and contact selectors", async () => {
  const source = await readFile(new URL("../src/lib/automation-routes.ts", import.meta.url), "utf8");
  assert.match(source, /researchQueueWhere\(\)/);
  assert.match(source, /qualifiedContactEnrichmentDueWhere\(now\)/);

  const pipelineSource = await readFile(new URL("../src/lib/candidate-pipeline-routes.ts", import.meta.url), "utf8");
  const researchSelector = pipelineSource.match(/export function researchQueueWhere\(\)[\s\S]{0,700}?\n\}/);
  assert.ok(researchSelector, "candidate pipeline must own the research queue selector");
  assert.doesNotMatch(researchSelector[0], /email:\s*\{\s*not:\s*null/);
  assert.match(researchSelector[0], /screeningStatus:\s*\{\s*in:\s*\["complete", "partial", "failed"\]/);
});
