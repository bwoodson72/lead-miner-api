import test from "node:test";
import assert from "node:assert/strict";
import { stripStaticHiddenMarkup } from "../src/lib/research-visible-html.js";

test("hidden placeholder sections are removed before representative-page research", () => {
  const html = `
    <main>
      <h1>Foundation Repair</h1>
      <section style="display:none"><h2>Lorem ipsum dolor sit amet</h2></section>
      <div hidden>Placeholder text should not reach research.</div>
      <div aria-hidden="true">Demo content</div>
      <p>Serving homeowners across Fort Worth.</p>
    </main>`;

  const visible = stripStaticHiddenMarkup(html);
  assert.match(visible, /Foundation Repair/);
  assert.match(visible, /Serving homeowners/);
  assert.doesNotMatch(visible, /Lorem ipsum/i);
  assert.doesNotMatch(visible, /Placeholder text/i);
  assert.doesNotMatch(visible, /Demo content/i);
});

test("common builder and accessibility hidden classes are removed", () => {
  const html = `
    <div class="elementor-hidden-desktop">Lorem ipsum</div>
    <p class="d-none">Sample content</p>
    <span class="sr-only">Placeholder copy</span>
    <p>Visible service copy</p>`;

  const visible = stripStaticHiddenMarkup(html);
  assert.doesNotMatch(visible, /Lorem ipsum/i);
  assert.doesNotMatch(visible, /Sample content/i);
  assert.doesNotMatch(visible, /Placeholder copy/i);
  assert.match(visible, /Visible service copy/);
});
