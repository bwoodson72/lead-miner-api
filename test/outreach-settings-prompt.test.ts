import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OUTREACH_INSTRUCTIONS } from "../src/lib/settings.js";

test("default outreach settings prompt is rebuild-only and reply-first", () => {
  assert.match(DEFAULT_OUTREACH_INSTRUCTIONS, /Only REBUILD_CANDIDATE leads reach this writing stage/i);
  assert.match(DEFAULT_OUTREACH_INSTRUCTIONS, /reply or ask to see what was found/i);
  assert.match(DEFAULT_OUTREACH_INSTRUCTIONS, /do not ask for a consultation, meeting, calendar slot, or call in Touch 1/i);
  assert.doesNotMatch(DEFAULT_OUTREACH_INSTRUCTIONS, /OPTIMIZATION_CANDIDATE/);
});

test("default outreach settings prompt allows ordinary elapsed time but blocks technical measurement language", () => {
  assert.match(DEFAULT_OUTREACH_INSTRUCTIONS, /close to a minute/);
  assert.match(DEFAULT_OUTREACH_INSTRUCTIONS, /about 20 seconds/);
  assert.match(DEFAULT_OUTREACH_INSTRUCTIONS, /Never mention Lighthouse, PageSpeed, Core Web Vitals/);
  assert.doesNotMatch(DEFAULT_OUTREACH_INSTRUCTIONS, /Do not put numeric or spelled-out seconds/);
});

test("default outreach settings prompt keeps implementation details out of prospect copy", () => {
  assert.match(DEFAULT_OUTREACH_INSTRUCTIONS, /Never mention the framework, CMS, platform, page builder, coding approach, or implementation stack/);
  assert.doesNotMatch(DEFAULT_OUTREACH_INSTRUCTIONS, /Astro/);
});
