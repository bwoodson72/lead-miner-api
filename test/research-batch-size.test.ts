import test from "node:test";
import assert from "node:assert/strict";
import { SAFETY_LIMITS, capRequestedLimit } from "../src/lib/safety-limits.js";

test("configured research batches can exceed the old implicit cap of ten", () => {
  assert.ok(SAFETY_LIMITS.automationResearchMax >= 50);
  assert.equal(capRequestedLimit(50, 10, SAFETY_LIMITS.automationResearchMax), 50);
});
