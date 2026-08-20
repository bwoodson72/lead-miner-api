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
