import test from "node:test";
import assert from "node:assert/strict";
import {
  draftTooSimilarToPrevious,
  outreachDraftNeedsRegeneration,
  OUTREACH_PROMPT_VERSION,
} from "../src/lib/ai-outreach.js";
import { buildHardOutreachRules } from "../src/lib/outreach-policy.js";

test("new outreach prompt version invalidates old initial drafts", () => {
  assert.equal(OUTREACH_PROMPT_VERSION, "outreach-draft-v19");
});

test("Touch 1 does not require a sender-service sentence", () => {
  const body = "Hi,\n\nI noticed the pool site is essentially one fairly thin page, and the main content is also slow to appear on mobile. Someone comparing pool contractors may not get much to evaluate before deciding whether to keep looking.\n\nWant me to send over what I found?\n\nBrian";
  assert.equal(outreachDraftNeedsRegeneration(body, "Pool website", "Want me to send over what I found?"), false);
  assert.match(buildHardOutreachRules(), /Do not force a sender bio/i);
});

test("identical and near-identical regenerations are rejected", () => {
  const previous = {
    subject: "Pool homepage",
    bodyText: "Hi,\n\nOn mobile, the main content on the homepage takes a while to appear. Someone comparing pool contractors on a phone could move on before seeing enough to keep the business in consideration.\n\nMay I pass along the details?\n\nBrian",
    cta: "May I pass along the details?",
  };

  assert.equal(draftTooSimilarToPrevious({ bodyText: previous.bodyText, cta: previous.cta }, previous), true);
  assert.equal(draftTooSimilarToPrevious({
    bodyText: "Hi,\n\nOn mobile, the main content on the homepage takes a while to appear. Someone comparing pool contractors on a phone might move on before seeing enough to keep the company in consideration.\n\nMay I pass along what I found?\n\nBrian",
    cta: "May I pass along what I found?",
  }, previous), true);
});

test("materially different regeneration is accepted by diversity check", () => {
  const previous = {
    subject: "Pool homepage",
    bodyText: "Hi,\n\nOn mobile, the main content on the homepage takes a while to appear. Someone comparing pool contractors on a phone could move on before seeing enough to keep the business in consideration.\n\nMay I pass along the details?\n\nBrian",
    cta: "May I pass along the details?",
  };
  const replacement = {
    bodyText: "Hi,\n\nI noticed the pool business is relying on one fairly thin page to explain its work online. Combined with the delayed mobile content, a person comparing contractors may have very little to judge before deciding whether to keep looking.\n\nWant me to send the two things I noticed?\n\nBrian",
    cta: "Want me to send the two things I noticed?",
  };

  assert.equal(draftTooSimilarToPrevious(replacement, previous), false);
});
