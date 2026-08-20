import test from "node:test";
import assert from "node:assert/strict";
import { IMPORT_ROW_LIMIT, normalizeImportWebsite, prepareImportRows } from "../src/lib/website-import-routes.js";

test("website import accepts bare domains and preserves useful paths while stripping tracking", () => {
  const normalized = normalizeImportWebsite("www.example.com/services/roofing/?utm_source=test#top");
  assert.equal(normalized.domain, "example.com");
  assert.equal(normalized.normalizedUrl, "https://www.example.com/services/roofing");
  assert.equal(normalized.suppliedUrl, "www.example.com/services/roofing/?utm_source=test#top");
});

test("duplicate domains inside one import are rejected before persistence", () => {
  const rows = prepareImportRows([
    { website: "https://example.com" },
    { website: "https://www.example.com/services" },
  ]);
  assert.equal(rows[0]?.status, "ready");
  assert.equal(rows[1]?.status, "duplicate");
  assert.match(rows[1]?.reason ?? "", /row 1/i);
});

test("non-http and unsafe local targets are rejected", () => {
  assert.throws(() => normalizeImportWebsite("mailto:owner@example.com"), /http and https/i);
  assert.throws(() => normalizeImportWebsite("localhost"), /local or internal/i);
  assert.throws(() => normalizeImportWebsite("127.0.0.1:3000"), /IP-address URLs/i);
  assert.throws(() => normalizeImportWebsite("https://admin:secret@example.com"), /embedded credentials/i);
});

test("CSV import hard limit remains explicit", () => {
  assert.equal(IMPORT_ROW_LIMIT, 1000);
});
