import test from "node:test";
import assert from "node:assert/strict";
import {
  assessSiteBusinessIdentity,
  domainsMatch,
  emailMatchesDomain,
  searchResultSupportsLead,
} from "../src/lib/enrichment-identity.js";

const outdoorKitchen = {
  domain: "outdoorkitchenremodels.com",
  businessName: "Outdoor Kitchen Remodels",
  phone: "(469) 993-0408",
  address: "311 S Oak St, Roanoke, TX 76262",
};

test("compromised or unrelated site identity conflicts with the source business", () => {
  assert.equal(assessSiteBusinessIdentity("Outdoor Kitchen Remodels", "BAKAR77 | Toto Macau Terkini"), "conflict");
  assert.equal(assessSiteBusinessIdentity("Heroic Roofing", "Heroic Roofing | Fort Worth Roofing Contractor"), "match");
});

test("off-domain competitor result is rejected even when service wording is semantically similar", () => {
  const dmbResult = {
    title: "Outdoor Kitchen Remodeling in Carlsbad CA | dmb Builders Inc",
    snippet: "DMB Builders offers outdoor kitchen and BBQ remodeling in Carlsbad, California. info@dmbbuildersinc.com",
    link: "https://www.dmbbuildersinc.com/outdoor-kitchen-bbq-remodel-carlsbad/",
  };

  assert.equal(searchResultSupportsLead(dmbResult, outdoorKitchen), false);
  assert.equal(emailMatchesDomain("info@dmbbuildersinc.com", outdoorKitchen.domain), false);
});

test("same-domain result is valid identity evidence", () => {
  assert.equal(searchResultSupportsLead({
    title: "Contact Outdoor Kitchen Remodels",
    snippet: "Email info@outdoorkitchenremodels.com",
    link: "https://outdoorkitchenremodels.com/contact",
  }, outdoorKitchen), true);
  assert.equal(emailMatchesDomain("info@outdoorkitchenremodels.com", outdoorKitchen.domain), true);
});

test("directory result can corroborate identity with exact phone", () => {
  assert.equal(searchResultSupportsLead({
    title: "Outdoor Kitchen Remodels",
    snippet: "Roanoke, TX · (469) 993-0408 · outdoor kitchens and remodeling",
    link: "https://directory.example/contractors/outdoor-kitchen-remodels",
  }, outdoorKitchen), true);
});

test("directory result can corroborate identity with exact business name and location", () => {
  assert.equal(searchResultSupportsLead({
    title: "Outdoor Kitchen Remodels - Roanoke, TX",
    snippet: "Outdoor Kitchen Remodels serves Roanoke TX. Email: hello@gmail.com",
    link: "https://directory.example/outdoor-kitchen-remodels",
  }, outdoorKitchen), true);
});

test("off-domain redirect is not treated as the lead domain", () => {
  assert.equal(domainsMatch("outdoorkitchenremodels.com", "photoglade.com"), false);
  assert.equal(domainsMatch("www.heroicroof.com", "heroicroof.com"), true);
});
