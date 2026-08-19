import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("lead query exposes candidate pipeline filters without contact gating research", async () => {
  const source = await readFile(new URL("../src/lib/crm-operations-routes.ts", import.meta.url), "utf8");

  assert.match(source, /q\.performanceOpportunity/);
  assert.match(source, /where\.performanceOpportunity=q\.performanceOpportunity/);
  assert.match(source, /q\.screeningStatus/);
  assert.match(source, /where\.screeningStatus=q\.screeningStatus/);

  assert.match(source, /q\.researchState==="researched"/);
  assert.match(source, /where\.lastResearchedAt=\{not:null\}/);
  assert.match(source, /q\.researchState==="pending"/);
  assert.match(source, /aiJobs=\{none:\{type:"lead_research",status:"failed"\}\}/);
  assert.match(source, /q\.researchState==="failed"/);
  assert.match(source, /aiJobs=\{some:\{type:"lead_research",status:"failed"\}\}/);

  const researchSection = source.slice(source.indexOf('q.researchState==="researched"'), source.indexOf('if(q.keyword)'));
  assert.doesNotMatch(researchSection, /email/);
});

test("dashboard research queue count reuses the canonical research selector", async () => {
  const source = await readFile(new URL("../src/lib/crm-operations-routes.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ researchQueueWhere \} from "\.\/research-queue\.js"/);
  assert.match(source, /prisma\.lead\.count\(\{where:researchQueueWhere\(\) as any\}\)/);
});
