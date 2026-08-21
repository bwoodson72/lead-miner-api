import test from "node:test";
import assert from "node:assert/strict";
import { OUTREACH_PROMPT_VERSION } from "../src/lib/ai-outreach.js";
import { FOLLOWUP_PROMPT_VERSION } from "../src/lib/ai-followup.js";
import { canReuseExistingInitialOutreach } from "../src/lib/outreach-preparation.js";
import { outreachMessageNeedsRegeneration } from "../src/lib/outreach-version.js";

const safeBody = "Hi,\n\nI noticed the homepage takes roughly 11 seconds before the main content becomes usable. For someone comparing roofers, that is a long time to wait while deciding whom to contact.\n\nI build custom websites for service businesses, so this stood out to me.\n\nWant me to send over what I noticed?\n\nBrian";

test("current safe initial draft can be reused", () => {
  assert.equal(canReuseExistingInitialOutreach({
    status: "draft",
    promptVersion: OUTREACH_PROMPT_VERSION,
    subject: "Homepage load",
    bodyText: safeBody,
    cta: "Want me to send over what I noticed?",
  }), true);
});

test("stale initial draft is regenerated even when not explicitly forced", () => {
  assert.equal(canReuseExistingInitialOutreach({
    status: "draft",
    promptVersion: "outreach-draft-v17",
    subject: "Homepage load",
    bodyText: safeBody,
    cta: "Want me to send over what I noticed?",
  }), false);
});

test("current-version initial draft is not invalidated by CTA style choices", () => {
  const alternateBody = safeBody.replace("Want me to send over what I noticed?", "Would you be open to a quick conversation about improving that experience?");
  assert.equal(canReuseExistingInitialOutreach({
    status: "draft",
    promptVersion: OUTREACH_PROMPT_VERSION,
    subject: "Homepage load",
    bodyText: alternateBody,
    cta: "Would you be open to a quick conversation about improving that experience?",
  }), true);
});

test("sent or sending initial outreach is never replaced", () => {
  for (const status of ["sending", "sent"]) {
    assert.equal(canReuseExistingInitialOutreach({
      status,
      promptVersion: "outreach-draft-v1",
      subject: "Old subject",
      bodyText: "Old body",
      cta: null,
    }, true), true);
  }
});

test("kind-specific validator preserves a valid no-greeting follow-up", () => {
  const body = "One reason I mentioned it is that an 11-second wait is a long time when someone is deciding which roofer to call. Happy to send the notes if useful.\n\nBrian";
  assert.equal(FOLLOWUP_PROMPT_VERSION, "followup-v5");
  assert.equal(outreachMessageNeedsRegeneration("followup", body, "Homepage load", ""), false);
});

test("kind-specific validator rejects follow-ups that restart the thread or use generic follow-up filler", () => {
  assert.equal(outreachMessageNeedsRegeneration("followup", "Hi,\n\nThe 11-second wait is still worth a look.\n\nBrian"), true);
  assert.equal(outreachMessageNeedsRegeneration("followup", "Just following up on the note I sent.\n\nBrian"), true);
});

test("initial draft validation leaves CTA strategy to the editable prompt", () => {
  const body = safeBody.replace("Want me to send over what I noticed?", "Would you be open to a quick conversation about improving that experience?");
  assert.equal(outreachMessageNeedsRegeneration("initial", body, "Homepage load", "Would you be open to a quick conversation about improving that experience?"), false);
});
