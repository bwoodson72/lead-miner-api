import test from "node:test";
import assert from "node:assert/strict";
import { getContactIdentityRiskReason, isObviousNonProspectEmail } from "../src/lib/contact-safety.js";

test("telemetry, placeholder, and vendor addresses are blocked", () => {
  assert.equal(isObviousNonProspectEmail("605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com"), true);
  assert.equal(isObviousNonProspectEmail("jane.doe@tcecreative.co.uk"), true);
  assert.equal(isObviousNonProspectEmail("support@prophone.com"), true);
  assert.equal(isObviousNonProspectEmail("info@realroofer.com"), false);
});

test("same-domain and ordinary consumer-mail recipients are eligible", () => {
  assert.equal(getContactIdentityRiskReason({ email: "info@rturleyroofing.com", domain: "rturleyroofing.com", contacts: [] }), null);
  assert.equal(getContactIdentityRiskReason({ email: "dfwpremiumroofing@yahoo.com", domain: "dfwpremiumroofingandsolar.com", contacts: [] }), null);
});

test("ordinary custom cross-domain recipients are eligible without identity verification", () => {
  assert.equal(getContactIdentityRiskReason({ email: "office@reyesroofingllc.com", domain: "thomasroofing.example", contacts: [] }), null);
  assert.equal(getContactIdentityRiskReason({ email: "owner@oldcompanydomain.com", domain: "currentcompany.com", contacts: [] }), null);
});

test("obvious provider infrastructure remains blocked even when the domain differs", () => {
  assert.match(getContactIdentityRiskReason({ email: "support@prophone.com", domain: "targetroofer.com", contacts: [] }) ?? "", /provider infrastructure/);
});
