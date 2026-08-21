import test from "node:test";
import assert from "node:assert/strict";
import { getContactIdentityRiskReason, isObviousNonProspectEmail } from "../src/lib/contact-safety.js";

test("telemetry, placeholder, and vendor addresses are blocked", () => {
  assert.equal(isObviousNonProspectEmail("605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com"), true);
  assert.equal(isObviousNonProspectEmail("jane.doe@tcecreative.co.uk"), true);
  assert.equal(isObviousNonProspectEmail("support@prophone.com"), true);
  assert.equal(isObviousNonProspectEmail("info@realroofer.com"), false);
});

test("same-domain and consumer-mail recipients are eligible automatically", () => {
  assert.equal(getContactIdentityRiskReason({ email: "info@rturleyroofing.com", domain: "rturleyroofing.com", contacts: [] }), null);
  assert.equal(getContactIdentityRiskReason({ email: "dfwpremiumroofing@yahoo.com", domain: "dfwpremiumroofingandsolar.com", contacts: [] }), null);
  assert.equal(getContactIdentityRiskReason({ email: "owner@sbcglobal.net", domain: "currentcompany.com", contacts: [] }), null);
});

test("unverified custom cross-domain recipients remain blocked for automation", () => {
  assert.match(getContactIdentityRiskReason({ email: "office@reyesroofingllc.com", domain: "thomasroofing.example", contacts: [] }) ?? "", /not identity-verified/);
});

test("manual recipient authorization allows a custom cross-domain address", () => {
  assert.equal(getContactIdentityRiskReason({
    email: "office@managementco.com",
    domain: "targetroofer.com",
    contacts: [{ type: "email", value: "office@managementco.com", isPrimary: true, source: "manual_outreach", verificationStatus: "manually_verified" }],
  }), null);
});

test("obvious provider infrastructure cannot be overridden by stored verification", () => {
  assert.match(getContactIdentityRiskReason({
    email: "support@prophone.com",
    domain: "targetroofer.com",
    contacts: [{ type: "email", value: "support@prophone.com", isPrimary: true, source: "manual_outreach", verificationStatus: "manually_verified" }],
  }) ?? "", /provider infrastructure/);
});
