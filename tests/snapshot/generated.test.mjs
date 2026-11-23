// CSS generated content and text-transform in page.snapshot, as Ego prints
// them: ::before and ::after text around
// the element's content, with counters, quotes and attr() resolved and
// table-cell boxes in their rows; text-transform on the page's text and on
// generated text. Left out, unlike Ego: an icon font's glyphs and a
// clearfix's empty table (docs/PARITY.md). Boxes come from Gecko's layout,
// so a cross-origin sheet, a shadow root's sheet and a CSSOM change count.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let other;
let sheetUrl;

before(async () => {
  h = await setup("generated");
  // A stylesheet from another origin, as sites serve theirs from CDNs.
  other = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/css" });
    res.end(".xo::before { content: \"Cross-origin\"; }");
  });
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  sheetUrl = `http://127.0.0.1:${other.address().port}/sheet.css`;
});

after(async () => {
  await h?.assertUserViewUnchanged();
  await h?.close();
  await new Promise(resolve => (other ? other.close(resolve) : resolve()));
});

const snap = scope => h.call("page.snapshot", { space: h.space, page: "p1", options: { scope } }).then(r => r.text);

/** Whether `text` has `block`'s lines in a row, indented as in `block` relative to its first line. */
function hasBlock(text, block) {
  const want = block.split("\n").filter(l => l.trim());
  const base = want[0].search(/\S/);
  const rel = want.map(l => [l.search(/\S/) - base, l.trim()]);
  const lines = text.split("\n");
  return lines.some((line, i) => {
    const indent = line.search(/\S/);
    return rel.every(([d, t], k) => lines[i + k]?.trim() === t && lines[i + k].search(/\S/) - indent === d);
  });
}

const assertBlock = (text, block) => assert.ok(hasBlock(text, block), `expected\n${block}\nin\n${text}`);

const PAGE = `
  <style>
    .pre::before { content: "Pre"; } .pre::after { content: "post"; }
    .sep li + li::before { content: "\\00a0·"; }
    .req::after { content: " *"; }
    .attr::before { content: attr(data-label) ": "; }
    table.rank { counter-reset: rank; }
    table.rank tr::before { display: table-cell; counter-increment: rank; content: counter(rank); }
    .icon::before { content: "\\f002"; }
    .clear::after { content: ""; display: table; clear: both; }
    .hid::before { content: "Hidden"; visibility: hidden; }
    .up { text-transform: uppercase; } .low { text-transform: lowercase; }
    .cap { text-transform: capitalize; } .none { text-transform: none; }
    .gen::before { content: "gen "; }
    .far { position: relative; } .far::before { content: "Far away"; position: absolute; top: 5000px; }
    .contents { display: contents; } .contents::before { content: "In contents"; }
  </style>
  <p class="pre">middle</p>
  <ul class="sep"><li>One</li><li>Two</li></ul>
  <label class="req">Email</label>
  <p class="attr" data-label="Note">text</p>
  <table class="rank"><tr><td>Alpha</td></tr><tr><td>Beta</td></tr></table>
  <p><span class="icon"></span>Search</p>
  <div class="clear"><span>Floated</span></div>
  <p class="hid">Shown</p>
  <p class="up">Shout <span>inner</span> <span class="none">Quiet</span></p>
  <p class="low">WHISPER</p>
  <p class="cap">hello wide&nbsp;world</p>
  <p class="up gen">body</p>
  <p><span style="text-transform: uppercase">inline</span></p>
  <p><q>Quoted</q></p>
  <div class="far">Anchor</div>
  <div class="contents">Child</div>`;

async function load(html) {
  await h.goto("/nav-target");
  await h.page(`document.body.innerHTML = ${JSON.stringify(html)}; return true;`);
}

test("::before and ::after print around the element's content, resolved, as Ego prints them", async () => {
  await load(PAGE);
  for (const scope of ["full_page", "viewport"]) {
    const text = await snap(scope);
    assertBlock(text, `
      paragraph
        text "Pre"
        text "middle"
        text "post"`);
    // Wikipedia's hlist separator: a no-break space and a middle dot.
    assertBlock(text, `
      list_item
        text "\u00a0·"
        text "Two"`);
    assertBlock(text, `
      container
        text "Email"
        text "*"`);
    assertBlock(text, `
      paragraph
        text "Note:"
        text "text"`);
    // A tr::before laid out as a cell gets its own table_cell, as
    // Wikipedia's rank column does in Ego.
    assertBlock(text, `
      table_row
        table_cell
          text "2"
        table_cell
          text "Beta"`);
    assertBlock(text, `
      paragraph
        text "“"
        text "Quoted"
        text "”"`);
    assertBlock(text, `
      text "In contents"
      text "Child"`);
  }
});

test("an icon font's glyphs, a clearfix's empty table and a hidden box print nothing", async () => {
  await load(PAGE);
  const text = await snap("full_page");
  assertBlock(text, `
    paragraph
      text "Search"`);
  assert.ok(!/[\ue000-\uf8ff]/.test(text), "no private-use glyph");
  // The rank table is the page's only table.
  assert.equal(text.split("\n").filter(l => l.trim() === "table").length, 1, text);
  assert.ok(text.includes('text "Floated"'), text);
  assert.ok(!text.includes("Hidden"), text);
  assert.ok(text.includes('text "Shown"'), text);
});

test("text-transform applies to the page's text and to generated text, inherited and reset", async () => {
  await load(PAGE);
  for (const scope of ["full_page", "viewport"]) {
    const text = await snap(scope);
    assertBlock(text, `
      paragraph
        text "SHOUT"
        text "INNER"
        text "Quiet"`);
    assert.ok(text.includes('text "whisper"'), text);
    // No-break spaces separate words for capitalize too, as in Chromium.
    assert.match(text, /text "Hello Wide\s+World"/);
    assertBlock(text, `
      paragraph
        text "GEN"
        text "BODY"`);
    assert.ok(text.includes('text "INLINE"'), text);
  }
  // Only what prints changes: the page's own text stays as written.
  assert.equal(await h.page(`return document.querySelector(".up").firstChild.data;`), "Shout ");
});

test("a box outside the viewport prints only in full_page", async () => {
  await load(PAGE);
  assertBlock(await snap("full_page"), `
    container
      text "Far away"
      text "Anchor"`);
  const viewport = await snap("viewport");
  assert.ok(viewport.includes('text "Anchor"'), viewport);
  assert.ok(!viewport.includes("Far away"), viewport);
});

test("boxes from a cross-origin sheet, open and closed shadow roots and the CSSOM print", async () => {
  await load(`<p class="xo">styled</p><div id="open"></div><div id="closed"></div><p class="late">later</p>`);
  await h.page(`
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = ${JSON.stringify(sheetUrl)};
    const loaded = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = reject; });
    document.head.append(link);
    await loaded;
    for (const mode of ["open", "closed"]) {
      document.getElementById(mode).attachShadow({ mode }).innerHTML =
        "<style>p::before { content: '" + mode + " shadow: '; }</style><p>inside</p>";
    }
    return true;`);
  let text = await snap("full_page");
  assertBlock(text, `
    paragraph
      text "Cross-origin"
      text "styled"`);
  assert.ok(hasBlock(text, `text "open shadow:"\ntext "inside"`), text);
  assert.ok(hasBlock(text, `text "closed shadow:"\ntext "inside"`), text);
  assert.ok(!text.includes("Late"), text);
  await h.page(`
    const style = document.createElement("style");
    document.head.append(style);
    style.sheet.insertRule(".late::after { content: ' Late'; }");
    return true;`);
  text = await snap("full_page");
  assertBlock(text, `
    paragraph
      text "later"
      text "Late"`);
});

test("in a shadow root whose sheets give boxes no text, hosts, parts, quotes and slotted nodes still print theirs", async () => {
  await load(`<style>#outer::part(label)::before { content: "Part:"; }</style><div id="outer"></div>`);
  await h.page(`
    const outer = document.getElementById("outer").attachShadow({ mode: "open" });
    // No ::before or ::after with text in this root's sheet: only rules from
    // other trees, and the UA's quotes, can give its elements boxes.
    outer.innerHTML = '<style>p { margin: 0; } span::after { content: ""; }</style>' +
      '<p><q>Quoted</q></p><span part="label">named</span><p>plain</p>' +
      '<x-inner><span>slotted</span></x-inner><x-closed></x-closed>' +
      '<x-item style="display: list-item">' + "<b>unslotted</b>".repeat(7) + "</x-item>";
    outer.querySelector("x-inner").attachShadow({ mode: "open" }).innerHTML =
      '<style>:host::before { content: "Host:"; } ::slotted(span)::before { content: "Slot:"; }</style><slot></slot>';
    outer.querySelector("x-closed").attachShadow({ mode: "closed" }).innerHTML =
      '<style>:host::after { content: "Closed host"; }</style><b>in closed</b>';
    // Gecko lists a host's root, its ::marker, then its ::before, here ahead
    // of seven light children.
    outer.querySelector("x-item").attachShadow({ mode: "open" }).innerHTML =
      '<style>:host::before { content: "Item:"; }</style><i>item</i>';
    return true;`);
  const text = await snap("full_page");
  assertBlock(text, `
    paragraph
      text "“"
      text "Quoted"
      text "”"`);
  assert.ok(hasBlock(text, `text "Part:"\ntext "named"`), text);
  assert.ok(hasBlock(text, `text "Slot:"\ntext "slotted"`), text);
  assert.ok(text.includes('text "Host:"'), text);
  assert.ok(hasBlock(text, `text "in closed"\ntext "Closed host"`), text);
  assert.ok(text.includes('text "Item:"') && text.includes('text "item"'), text);
  assert.ok(!text.includes("unslotted"), text);
});
