import test from "node:test";
import assert from "node:assert/strict";
import {
  containsDisallowedExistingSiteServiceOffer,
  ctaNeedsRegeneration,
} from "../src/lib/ai-outreach.js";

test("actual existing-site service offers are rejected", () => {
  assert.equal(containsDisallowedExistingSiteServiceOffer("I can optimize the current site."), true);
  assert.equal(containsDisallowedExistingSiteServiceOffer("Want me to fix the existing homepage?"), true);
  assert.equal(containsDisallowedExistingSiteServiceOffer("I can tune the WordPress site."), true);
  assert.equal(containsDisallowedExistingSiteServiceOffer("I offer website optimization."), true);
  assert.equal(containsDisallowedExistingSiteServiceOffer("I provide site maintenance."), true);
  assert.equal(ctaNeedsRegeneration("Want me to optimize the current site?"), true);
});

test("negative or contrast language is not mistaken for an offer", () => {
  assert.equal(containsDisallowedExistingSiteServiceOffer("I don't offer optimization, repair, or maintenance; I build new custom websites."), false);
  assert.equal(containsDisallowedExistingSiteServiceOffer("This isn't an optimization pitch."), false);
  assert.equal(containsDisallowedExistingSiteServiceOffer("Rather than tuning the existing site, I build new custom websites."), false);
  assert.equal(containsDisallowedExistingSiteServiceOffer("I build new custom websites for service businesses."), false);
  assert.equal(containsDisallowedExistingSiteServiceOffer("Want me to send over what I noticed?"), false);
});
