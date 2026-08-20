import test from "node:test";
import assert from "node:assert/strict";
import { analyzeContentDepth, extractSubstantiveHtml } from "../src/lib/research-content-depth.js";

const grimeServicesCopy = "At Grime Construction, our services include remodels, concrete, interior and exterior painting, new roof installations, and commercial projects of all sizes. From small repairs to large-scale builds, we do it all with quality craftsmanship, integrity, and attention to detail.";

test("multi-service hub ignores generic and CTA headings when scoring service detail", () => {
  const html = `
    <html><body>
      <header><nav>${"Home About Services Gallery Contact ".repeat(8)}</nav></header>
      <main>
        <h2>Services</h2>
        <p>${grimeServicesCopy}</p>
        <h2>Call for a free estimate!</h2>
        <p>817-648-9437</p>
      </main>
      <footer>${"Phone Email DFW Roofing Construction ".repeat(8)}</footer>
    </body></html>
  `;

  const result = analyzeContentDepth(html, "service");
  assert.equal(result.rating, "thin");
  assert.equal(result.materialityHint, "strong");
  assert.equal(result.meaningfulParagraphCount, 1);
  assert.equal(result.detailHeadingCount, 0);
  assert.ok(result.substantiveWordCount < result.wholePageWordCount);
  assert.ok(result.substantiveWordCount < 60);
  assert.ok(result.serviceTopics.length >= 5);
  assert.match(result.reason, /distinct service topics/i);
});

test("real service and process headings still count as service detail", () => {
  const html = `<main>
    <h1>Services</h1>
    <h2>Kitchen Remodeling</h2>
    <h3>Our Process</h3>
    <p>We plan kitchen remodeling projects around layout, cabinetry, countertops, lighting, flooring, and the construction sequence from demolition through final walkthrough.</p>
  </main>`;
  const result = analyzeContentDepth(html, "service");
  assert.equal(result.detailHeadingCount, 2);
});

test("page chrome is excluded from the substantive region when a main element exists", () => {
  const html = `<body><header>${"Navigation ".repeat(50)}</header><main><h1>Roof Repair</h1><p>We repair storm-damaged residential roofs and explain the repair scope before work begins.</p></main><footer>${"Footer ".repeat(50)}</footer></body>`;
  const substantive = extractSubstantiveHtml(html);
  assert.doesNotMatch(substantive, /Navigation/);
  assert.doesNotMatch(substantive, /Footer/);
  assert.match(substantive, /storm-damaged residential roofs/);
});

test("short focused service page is not promoted to strong material thin content by word count alone", () => {
  const html = `<main><h1>Roof Repair</h1><p>We repair storm-damaged residential roofs, replace damaged shingles and flashing, inspect leak areas, and explain the repair scope before work begins. Homeowners receive clear options for the damaged area and a direct way to request an estimate.</p></main>`;
  const result = analyzeContentDepth(html, "service");
  assert.notEqual(result.materialityHint, "strong");
  assert.ok(result.serviceTopics.length <= 2);
});

test("substantive multi-service page with real detail does not meet thin-content criteria", () => {
  const html = `<main>
    <h1>Services</h1>
    <h2>Kitchen Remodeling</h2><p>We plan kitchen remodels around layout changes, cabinet installation, countertop replacement, lighting, flooring, and finish work. Our team coordinates the construction sequence and keeps the homeowner informed from demolition through final walkthrough.</p>
    <h2>Roofing</h2><p>Our roofing work includes inspections, storm repairs, full roof replacement, flashing, ventilation, and cleanup. We document the condition of the roof, explain the available scope, and provide a clear estimate before construction begins.</p>
    <h2>Concrete</h2><p>We build and replace driveways, patios, walkways, slabs, and other residential concrete. Projects include site preparation, forming, placement, finishing, and cleanup with the scope explained before work starts.</p>
    <h2>Interior and Exterior Painting</h2><p>Painting projects include preparation, repairs, interior walls and trim, exterior surfaces, and finish coats. The project scope identifies the surfaces being painted and the preparation required for a durable result.</p>
  </main>`;
  const result = analyzeContentDepth(html, "service");
  assert.equal(result.rating, "adequate");
  assert.equal(result.materialityHint, "none");
  assert.ok(result.substantiveWordCount >= 120);
  assert.ok(result.serviceTopics.length >= 4);
});

test("non-service representative pages do not become thin-service findings", () => {
  const result = analyzeContentDepth(`<main><h1>About</h1><p>Local company.</p></main>`, "about");
  assert.equal(result.materialityHint, "none");
});
