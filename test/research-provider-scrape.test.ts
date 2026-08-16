import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderScrapeResponse } from "../src/lib/research-provider-scrape.js";

test("provider scrape accepts current same-domain page text", () => {
  const result = parseProviderScrapeResponse("https://crownqualityroofing.com/", {
    url: "https://www.crownqualityroofing.com/",
    title: "Crown Quality Roofing",
    markdown: "# Crown Quality Roofing\n\nCommercial and residential roofing in Granbury, Fort Worth and Dallas. Roof repair, replacement, storm damage, metal roofing, gutters and siding. Contact Crown Quality Roofing for roofing services. ".repeat(4),
  });

  assert.equal(result.succeeded, true);
  assert.equal(result.title, "Crown Quality Roofing");
  assert.match(result.text, /commercial and residential roofing/i);
  assert.ok(result.wordCount >= 40);
});

test("provider scrape rejects content returned for another domain", () => {
  const result = parseProviderScrapeResponse("https://crownqualityroofing.com/", {
    url: "https://unrelated.example/",
    title: "Unrelated Company",
    text: "This is intentionally long enough that content length alone would otherwise pass the provider evidence threshold. ".repeat(8),
  });

  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /different domain/i);
});

test("provider scrape rejects thin extraction", () => {
  const result = parseProviderScrapeResponse("https://crownqualityroofing.com/", {
    url: "https://www.crownqualityroofing.com/",
    text: "Crown Quality Roofing",
  });

  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /insufficient/i);
});
