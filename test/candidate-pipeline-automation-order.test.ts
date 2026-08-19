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
  assert.match(source, /qualifiedContactWhere\(now\)/);

  const researchSource = await readFile(new URL("../src/lib/research-queue.ts", import.meta.url), "utf8");
  const researchSelector = researchSource.match(/export function researchQueueWhere\(\)[\s\S]{0,700}?\n\}/);
  assert.ok(researchSelector, "research queue module must own the research selector");
  assert.doesNotMatch(researchSelector[0], /email:\s*\{\s*not:\s*null/);
  assert.match(researchSelector[0], /screeningStatus:\s*\{\s*in:\s*\["complete", "partial", "failed"\]/);

  const contactSource = await readFile(new URL("../src/lib/qualified-enrichment.ts", import.meta.url), "utf8");
  assert.match(contactSource, /export function qualifiedContactWhere/);
  assert.match(contactSource, /qualificationDecision:\s*"rebuild_candidate"/);
});
