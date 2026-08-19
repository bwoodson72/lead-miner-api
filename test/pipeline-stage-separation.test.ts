import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("discovery pipeline does not run contact enrichment or AI research synchronously", async () => {
  const pipeline = await source("src/lib/pipeline.ts");
  assert.doesNotMatch(pipeline, /enrichLeadFromSite|enrichLeadEmail|processLeadResearch|researchLead\s*\(/);
  assert.match(pipeline, /queued for AI research/);
  assert.match(pipeline, /contact enrichment is deferred until rebuild qualification/);
});

test("automation routes contact work through the qualified-only enrichment worker", async () => {
  const jobs = await source("src/lib/automation-jobs.ts");
  assert.match(jobs, /enrichQualifiedRebuildCandidates/);
  assert.doesNotMatch(jobs, /enrichMissingEmails/);
  assert.match(jobs, /processScoredResearchQueue/);
});
