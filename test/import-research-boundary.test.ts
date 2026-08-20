import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("research projection includes discovery context but excludes My Notes", async () => {
  const source = await readFile(new URL("../src/lib/research-preparation.ts", import.meta.url), "utf8");
  const projection = source.slice(source.indexOf("const lead = await prisma.lead.findUnique", source.indexOf("getPreparedLeadForResearch")), source.indexOf("if (!lead)", source.indexOf("getPreparedLeadForResearch")));
  assert.match(projection, /discoverySource: true/);
  assert.match(projection, /suppliedUrl: true/);
  assert.doesNotMatch(projection, /outreachNotes/);
  assert.doesNotMatch(projection, /priorityBreakdown/);
});

test("single URL imports research immediately while CSV imports remain queued", async () => {
  const source = await readFile(new URL("../src/lib/website-import-routes.ts", import.meta.url), "utf8");
  assert.match(source, /return source === "manual_url"/);
  assert.match(source, /await processLeadResearch\(prisma, item\.id\)/);
  assert.match(source, /researchQueued: created\.length/);
  assert.match(source, /createdLeadIds: created\.map/);
});
