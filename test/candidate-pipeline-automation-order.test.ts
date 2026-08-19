import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("automation researches before qualified contact enrichment", async () => {
  const source = await readFile(new URL("../src/lib/automation-routes.ts", import.meta.url), "utf8");
  const tickOrder = source.match(/\["sync_replies", "revisit_due", "research", "enrich", "recalculate_priorities", "prepare_outreach"\]/);
  assert.ok(tickOrder, "candidate-first tick order must keep research before contact enrichment");
});

test("automation research queue does not require an email", async () => {
  const source = await readFile(new URL("../src/lib/automation-routes.ts", import.meta.url), "utf8");
  const researchQuery = source.match(
    /prisma\.lead\.count\(\{\s*where:\s*\{\s*status:\s*\{\s*in:\s*\["new", "research_pending"\][\s\S]{0,900}?screeningStatus:\s*\{\s*in:\s*\["complete", "partial", "failed"\][\s\S]{0,900}?aiJobs:/,
  );
  assert.ok(researchQuery, "automation status must count the screening-aware research queue");
  assert.doesNotMatch(researchQuery[0], /email:\s*\{\s*not:\s*null/);
});
