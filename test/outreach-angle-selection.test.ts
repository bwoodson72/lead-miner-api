import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyHousekeepingFinding } from "../src/lib/ai-outreach-angle.js";

test("contact-detail cleanup is recognized as housekeeping rather than a preferred development angle", () => {
  assert.equal(isLikelyHousekeepingFinding({
    category: "customer_action",
    title: "Multiple phone numbers and placeholder email addresses",
    evidence: "The site presents several phone numbers and placeholder email text.",
    assetCapability: "Contact details should be made consistent.",
  }), true);
});

test("material performance constraint remains eligible as a development angle", () => {
  assert.equal(isLikelyHousekeepingFinding({
    category: "performance",
    title: "The site loads severely slowly on mobile",
    evidence: "Measured performance is poor.",
    assetCapability: "The delay materially constrains the acquisition experience.",
  }), false);
});
