import test from "node:test";
import assert from "node:assert/strict";
import { hashAiPacket } from "../src/lib/ai-budget.js";

test("AI packet hashes are deterministic across object key order", () => {
  assert.equal(hashAiPacket({ b: 2, a: { d: 4, c: 3 } }), hashAiPacket({ a: { c: 3, d: 4 }, b: 2 }));
});

test("AI packet hashes change when evidence changes", () => {
  assert.notEqual(hashAiPacket({ evidence: "one" }), hashAiPacket({ evidence: "two" }));
});
