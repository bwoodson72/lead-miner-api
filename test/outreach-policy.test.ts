import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHardOutreachRules,
  containsDisallowedExistingSiteServiceOffer,
  containsProhibitedSubjectLanguage,
  containsProhibitedTouch1Ask,
  containsProspectFacingImplementationStack,
  getOutreachOfferContext,
  OUTREACH_POLICY,
  OUTREACH_VALIDATION_MESSAGES,
} from "../src/lib/outreach-policy.js";

test("outreach offer context is derived from the canonical policy", () => {
  const context = getOutreachOfferContext();
  assert.equal(context.service, OUTREACH_POLICY.offer.service);
  assert.match(context.existingSiteWork, /not offered/i);
  for (const service of OUTREACH_POLICY.offer.prohibitedExistingSiteServices) {
    assert.match(context.existingSiteWork, new RegExp(service.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("hard prompt rules are generated from the canonical offer and Touch 1 objective", () => {
  const rules = buildHardOutreachRules();
  assert.match(rules, new RegExp(OUTREACH_POLICY.offer.service, "i"));
  assert.match(rules, new RegExp(OUTREACH_POLICY.touch1.objective, "i"));
  assert.match(rules, new RegExp(String(OUTREACH_POLICY.touch1.subjectMaxWords)));
  assert.match(rules, new RegExp(OUTREACH_POLICY.touch1.targetWordRange.replace(/ /g, "\\s+"), "i"));
});

test("validation feedback is generated from the same policy positioning", () => {
  assert.match(OUTREACH_VALIDATION_MESSAGES.existingSiteWork, new RegExp(OUTREACH_POLICY.offer.prospectFacingPositioning, "i"));
  assert.match(OUTREACH_VALIDATION_MESSAGES.implementationStack, new RegExp(OUTREACH_POLICY.offer.prospectFacingPositioning, "i"));
  assert.match(OUTREACH_VALIDATION_MESSAGES.cta, new RegExp(OUTREACH_POLICY.touch1.objective, "i"));
});

test("existing-site service validation blocks real offers but not negative wording", () => {
  assert.equal(containsDisallowedExistingSiteServiceOffer("I can optimize the current site."), true);
  assert.equal(containsDisallowedExistingSiteServiceOffer("Want me to repair the existing homepage?"), true);
  assert.equal(containsDisallowedExistingSiteServiceOffer("I provide website maintenance."), true);
  assert.equal(containsDisallowedExistingSiteServiceOffer("I don't offer optimization; I build new custom websites."), false);
  assert.equal(containsDisallowedExistingSiteServiceOffer("I'm not suggesting a repair to the current site."), false);
  assert.equal(containsDisallowedExistingSiteServiceOffer("I build new custom websites for service businesses."), false);
});

test("implementation and CTA restrictions are read from canonical policy", () => {
  assert.equal(containsProspectFacingImplementationStack("I build sites with Astro."), true);
  assert.equal(containsProspectFacingImplementationStack("I build custom websites for service businesses."), false);
  assert.equal(containsProhibitedTouch1Ask("Could we book a quick call?"), true);
  assert.equal(containsProhibitedTouch1Ask("Want me to send the details?"), false);
});

test("subject restrictions are read from canonical policy", () => {
  assert.equal(containsProhibitedSubjectLanguage("Quick question"), true);
  assert.equal(containsProhibitedSubjectLanguage("Weatherford roofing page"), false);
});
