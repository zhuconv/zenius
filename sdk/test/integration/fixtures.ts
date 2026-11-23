// Pages the integration suites drive. Each notes what happened to it in the
// DOM, as JSON in a data-* attribute on <html> (note(), below), so a script
// reads the outcome back with page.evaluate() and noted(). Page code runs in
// zenius's sandbox, which sees the DOM but not the page's globals.

/** A 1×1 PNG, served at /image.png. */
export const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwTpv5HwAENAIyWy0K4AAAAABJRU5ErkJggg==",
  "base64",
);

// The pages' own helper, in the page's world: note(name, value), or
// note(name, (old) => value) to change what's there.
const NOTE = `<script>function note(name, change) {
  const data = document.documentElement.dataset;
  const value = typeof change === "function" ? change(data[name] === undefined ? undefined : JSON.parse(data[name])) : change;
  data[name] = JSON.stringify(value);
}</script>`;

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>${body.includes("note(") ? NOTE : ""}${body}`;

/**
 * Page code that reads what a fixture page noted, as window.<name> read it
 * before: the JSON value, or undefined when nothing was noted.
 */
export const noted = (name: string) =>
  `(document.documentElement.dataset.${name} === undefined ? undefined : JSON.parse(document.documentElement.dataset.${name}))`;

export const FIXTURE_PAGES: Record<string, string> = {
  "/": page(
    "sdk fixture",
    `<h1 id="greeting">hello from the fixture</h1>
<a id="next" href="/two">two</a>
<script>note("answer", 6 * 7);</script>`,
  ),
  "/two": page("sdk fixture two", `<h1>page two</h1>`),

  "/form": page(
    "sdk form",
    `<form id="form" onsubmit="event.preventDefault(); note('submitted', true);">
  <input id="name" name="name">
  <textarea id="bio"></textarea>
  <select id="month">${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    .map((month, index) => `<option value="m${index + 1}">${month}</option>`)
    .join("")}</select>
  <button id="submit">Submit</button>
</form>
<button id="clicker" onclick="note('clicks', (n) => (n || 0) + 1)">Count clicks</button>
<button id="doubler" ondblclick="note('doubles', (n) => (n || 0) + 1)">Count double clicks</button>
<div id="hover" style="width:120px;height:40px;background:#ddd" onmouseenter="note('hovered', true)">hover me</div>
<div id="source" style="width:80px;height:40px;background:#cde" onmousedown="note('dragFrom', 'source')">drag</div>
<div id="target" style="width:80px;height:40px;background:#edc;margin-top:40px" onmouseup="note('dropOn', 'target')">drop</div>`,
  ),

  "/keys": page(
    "sdk keys",
    `<button id="corner" style="position:fixed;left:10px;top:10px;width:100px;height:40px"
  onclick="note('cornerClicks', (n) => (n || 0) + 1)">corner</button>
<input id="keys" style="margin-top:80px" onkeydown="note('keyLog', (log) => [...(log || []), event.key])">
<div id="editor" contenteditable="true" style="min-height:40px;border:1px solid #888"></div>
<div style="height:3000px"></div>`,
  ),

  "/popup": page("sdk popup", `<a id="open" href="/two" target="_blank">open page two</a>`),

  "/dialogs": page(
    "sdk dialogs",
    `<button id="alert" onclick="alert('hi from the fixture')">alert</button>
<button id="confirm" onclick="note('confirmed', confirm('sure?'))">confirm</button>
<button id="prompt" onclick="note('answer', prompt('name?', 'x'))">prompt</button>`,
  ),

  // Dialogs that open while the page loads: goto's receipt reports them.
  "/prompt-on-load": page("sdk prompt on load", `<script>note("answer", prompt("name?", "guest"));</script>`),
  "/confirm-on-load": page("sdk confirm on load", `<script>note("confirmed", confirm("sure?"));</script>`),

  "/files": page(
    "sdk files",
    `<a id="download" href="/file.txt">download the report</a>
<input id="file" type="file">
<input id="hidden" type="file" style="display:none">
<button id="pick" onclick="document.querySelector('#hidden').click()">pick a file</button>`,
  ),

  // Folder uploads: an input with webkitdirectory, and a
  // hidden one whose folder chooser a button opens.
  "/folders": page(
    "sdk folders",
    `<input id="dir" type="file" webkitdirectory>
<input id="hiddenDir" type="file" webkitdirectory style="display:none">
<button id="pickDir" onclick="document.querySelector('#hiddenDir').click()">pick a folder</button>`,
  ),

  "/late": page(
    "sdk late",
    `<script>setTimeout(() => {
  document.body.insertAdjacentHTML("beforeend", '<p id="late">arrived late</p>');
  note("ready", true);
}, 300);</script>`,
  ),

  // A control that appears late inside a same-origin frame, as in Ego's
  // iframe snapshot cases.
  // Browser UI zenius refuses in agent pages: a print dialog, an app link,
  // and the date, select and color pickers. A click inside a date input only
  // focuses a field; its calendar button or showPicker() opens the picker.
  // /auth (context.ts) asks for an HTTP sign-in.
  "/refusals": page(
    "sdk refusals",
    `<button id="print" onclick="window.print(); note('printed', (n) => (n ?? 0) + 1)">print</button>
<a id="mail" href="mailto:zenius@example.invalid">mail us</a>
<input id="when" type="date"><button id="pick" onclick="document.getElementById('when').showPicker()">pick a date</button>
<select id="size"><option value="s">small</option><option value="l">large</option></select>
<input id="tint" type="color" value="#336699">`,
  ),
  // The Skill's code examples (examples.it.ts): each page has what its
  // example's selectors name, and records the outcome in window globals.
  "/ex-example": page(
    "Example Domain",
    `<h1>Example Domain</h1><p>This domain is for use in documentation examples.</p><a href="/two">Learn more</a>`,
  ),
  "/ex-signin": page(
    "sdk sign-in",
    `<label>Email <input type="email" name="email"></label>
<button onclick="if (document.querySelector('input[name=email]').value) document.querySelector('#account-home').hidden = false">Sign in</button>
<section id="account-home" hidden><h2>Account home</h2></section>`,
  ),
  "/ex-month": page(
    "sdk month",
    `<select name="month">${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
      .map((month, index) => `<option value="m${index + 1}">${month}</option>`)
      .join("")}</select>`,
  ),
  // (420, 260) lands in the textarea, and the page scrolls 600 px further.
  "/ex-visual": page(
    "sdk visual",
    `<textarea id="cell" style="position:absolute;left:300px;top:200px;width:300px;height:120px"></textarea>
<div style="height:3000px"></div>`,
  ),
  "/ex-articles": page(
    "sdk articles",
    [1, 2, 3].map((n) => `<article><a href="/two?n=${n}">Story ${n}</a></article>`).join("\n"),
  ),
  "/ex-upload": page("sdk upload", `<input type="file" onchange="note('picked', [...this.files].map((file) => file.name + ':' + file.size))">`),
  // The file input exists only once the button makes it.
  "/ex-chooser": page(
    "sdk chooser",
    `<button class="upload" onclick="const input = document.createElement('input'); input.type = 'file';
  input.onchange = () => { note('chosen', [...input.files].map((file) => file.name)); }; input.click();">Upload</button>`,
  ),
  "/ex-download": page("sdk download", `<button class="download" onclick="location.href = '/file.txt'">Download</button>`),
  // Dialogs that interrupt a call (next-steps.it.ts): a select whose change
  // alerts, and an input whose keydown alerts at "b".
  "/ex-month-alert": page(
    "sdk month alert",
    `<select name="month" onchange="alert('saved ' + this.value)"><option value="m9">September</option><option value="m10">October</option></select>`,
  ),
  "/ex-typing-alert": page("sdk typing alert", `<input id="typed" onkeydown="if (event.key === 'b') alert('b pressed')">`),
  // An origin for clearing-state.md's example; its check seeds the storage.
  "/ex-storage": page("sdk storage", `<h1>storage</h1>`),
  "/framed": page("sdk framed", `<h1>outer</h1><iframe id="inner" src="/framed-inner"></iframe>`),
  "/framed-inner": page(
    "sdk framed inner",
    `<script>setTimeout(() => {
  document.body.insertAdjacentHTML("beforeend", '<button id="in-frame">inside the frame</button>');
}, 300);</script>`,
  ),
};
