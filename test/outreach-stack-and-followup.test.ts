import test from "node:test";
import assert from "node:assert/strict";
import {
  containsProspectFacingImplementationStack,
  OUTREACH_PROMPT_VERSION,
  outreachDraftNeedsRegeneration,
} from "../src/lib/ai-outreach.js";
import {
  FOLLOWUP_PROMPT_VERSION,
  followUpNeedsRegeneration,
  followUpSequenceGuidance,
} from "../src/lib/ai-followup.js";

test("outreach and follow-up prompt versions reflect stack-free sequence rules", () => {
  assert.equal(OUTREACH_PROMPT_VERSION, "outreach-draft-v18");
  assert.equal(FOLLOWUP_PROMPT_VERSION, "followup-v5");
});

test("implementation details are blocked from prospect-facing copy", () => {
  assert.equal(containsProspectFacingImplementationStack("I build websites with Astro."), true);
  assert.equal(containsProspectFacingImplementationStack("The site would be built with Astro."), true);
  assert.equal(containsProspectFacingImplementationStack("Your WordPress site has several service pages."), true);
  assert.equal(containsProspectFacingImplementationStack("I would rebuild it in Next.js."), true);
  assert.equal(containsProspectFacingImplementationStack("I build custom-coded websites for service businesses."), true);
  assert.equal(containsProspectFacingImplementationStack("I build custom websites for service businesses."), false);
  assert.equal(containsProspectFacingImplementationStack("Someone may try the next company."), false);
  assert.equal(containsProspectFacingImplementationStack("The next step should be clear."), false);
});

test("Touch 1 drafts with stack language require regeneration", () => {
  const body = "Hi,\n\nI noticed the estimate path changes from page to page. Someone comparing roofers may choose the site that makes the next step clearer.\n\nI build websites with Astro for service businesses, so this stood out to me.\n\nWant me to send over what I found?\n\nBrian";
  assert.equal(outreachDraftNeedsRegeneration(body, "Estimate path", "Want me to send over what I found?"), true);
});

test("follow-up safety does not require a new greeting and allows grounded human timing", () => {
  assert.equal(followUpNeedsRegeneration("One reason I mentioned it is that the next step changes from page to page. Happy to send the notes if useful.\n\nBrian"), false);
  assert.equal(followUpNeedsRegeneration("That close-to-a-minute wait is a long time when someone is comparing roofers.\n\nBrian"), false);
  assert.equal(followUpNeedsRegeneration("The LCP measured 58,400 ms.\n\nBrian"), true);
  assert.equal(followUpNeedsRegeneration("I would rebuild the site in Next.js.\n\nBrian"), true);
});

test("each follow-up has a distinct psychological job", () => {
  const first = followUpSequenceGuidance(1);
  const second = followUpSequenceGuidance(2);
  const third = followUpSequenceGuidance(3);
  const breakup = followUpSequenceGuidance(4);

  assert.match(first, /practical reason|ease of action/i);
  assert.match(second, /competitive choice|possible loss/i);
  assert.match(third, /broader business opportunity/i);
  assert.match(breakup, /terminal breakup|last outreach/i);
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.notEqual(third, breakup);
});
