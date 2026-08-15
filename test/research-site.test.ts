import test from "node:test";
import assert from "node:assert/strict";
import { extractWebsitePacket, mergeWebsitePackets } from "../src/lib/research-site.js";

test("contact/request page forms are aggregated into the website research packet", () => {
  const landing = extractWebsitePacket(`
    <html>
      <head><title>Heroic Roofing</title></head>
      <body>
        <a href="/contact.htm">Get a Free Inspection</a>
      </body>
    </html>
  `, "https://www.heroicroof.com/", "https://www.heroicroof.com/", 200);

  const contact = extractWebsitePacket(`
    <html>
      <body>
        <h1>Get a Free Inspection</h1>
        <p>Please complete the form provided below.</p>
        <form action="/submit">
          <input name="firstName" />
          <input name="email" type="email" />
          <button type="submit">Request Inspection</button>
        </form>
      </body>
    </html>
  `, "https://www.heroicroof.com/contact.htm", "https://www.heroicroof.com/contact.htm", 200);

  assert.equal(landing.contactSignals.hasForm, false);
  assert.equal(landing.discoveredPages.some((page) => page.type === "contact" && page.url.endsWith("/contact.htm")), true);

  const merged = mergeWebsitePackets(landing, [contact]);
  assert.equal(merged.contactSignals.hasForm, true);
  assert.equal(merged.contactSignals.formCount, 1);
  assert.equal(merged.contactSignals.checkedContactPages.length, 1);
  assert.equal(merged.contactSignals.checkedContactPages[0]?.hasForm, true);
  assert.equal(merged.callsToAction.some((cta) => cta.kind === "form"), true);
});
