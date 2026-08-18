import test from "node:test";
import assert from "node:assert/strict";
import { OUTREACH_PROMPT_VERSION } from "../src/lib/ai-outreach.js";
import { canReuseExistingInitialOutreach } from "../src/lib/outreach-preparation.js";

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

test("current-version draft that fails current Touch 1 CTA rules is regenerated", () => {
  const invalidBody = safeBody.replace("Want me to send over what I noticed?", "Would you be open to a quick conversation about improving that experience?");
  assert.equal(canReuseExistingInitialOutreach({
    status: "draft",
    promptVersion: OUTREACH_PROMPT_VERSION,
    subject: "Homepage load",
    bodyText: invalidBody,
    cta: "Would you be open to a quick conversation about improving that experience?",
  }), false);
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
