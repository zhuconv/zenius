// A React-style form, for the hand-off form-reset bug (MANAGER.md, 2026-11-21
// 13:54): an agent filled a token form built with React, the page reloaded
// at the user's first press, and the form came back at its defaults. This
// page behaves the way React's controlled components do, without React:
//   - Its state is the truth, and each render writes it to the DOM.
//   - A text input tracks its value as React's inputValueTracking does. A
//     page script that sets .value moves the tracker, so its input event
//     changes nothing. Typing, the native setter, and autofill's
//     setUserInput leave the tracker behind, so their input event updates
//     the state.
//   - The custom select (a button and a listbox) and the multi-select (a
//     listbox of toggles) aren't form fields, so a reload's form carry-over
//     can't bring them back.
//   - Submit records what it sent: body's data-submits counts, and
//     data-submitted holds the state it sent as JSON. data-state is the
//     state now, and data-doc tells this document from a reload of it.
// Tests read all of it through the DOM, which every world sees.
import { createServer } from "node:http";

/** The form as it loads. */
export const DEFAULTS = { name: "", perm: "read", zones: [] };

const FORM = load => `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Create API token</title>
<style>
  body { font: 15px system-ui, sans-serif; margin: 24px; }
  label, .label { display: block; margin-top: 12px; }
  [role=listbox] { list-style: none; padding: 0; margin: 4px 0; border: 1px solid #888; width: 220px; }
  [role=option] { padding: 4px 8px; cursor: pointer; }
  [role=option][aria-selected=true] { background: #cde; }
  #perm-list { position: absolute; background: white; }
  #submit { margin-top: 16px; }
</style>
<body data-load="${load}" data-submits="0">
<form id="token-form">
  <label for="name">Token name</label>
  <input id="name" name="name">
  <span class="label" id="perm-label">Permissions</span>
  <div id="perm">
    <button type="button" id="perm-button" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="perm-label">Read</button>
    <ul role="listbox" id="perm-list" aria-labelledby="perm-label" hidden>
      <li role="option" data-value="read">Read</li>
      <li role="option" data-value="edit">Edit</li>
      <li role="option" data-value="admin">Admin</li>
    </ul>
  </div>
  <span class="label" id="zones-label">Zones</span>
  <ul role="listbox" id="zones" aria-multiselectable="true" aria-labelledby="zones-label">
    <li role="option" data-value="example.com">example.com</li>
    <li role="option" data-value="example.org">example.org</li>
    <li role="option" data-value="example.net">example.net</li>
  </ul>
  <button type="submit" id="submit">Create token</button>
</form>
<output id="result"></output>
<script>
(() => {
  const DEFAULTS = ${JSON.stringify(DEFAULTS)};
  const PERMS = { read: "Read", edit: "Edit", admin: "Admin" };
  const $ = s => document.querySelector(s);
  const body = document.body;
  body.dataset.doc = String(Math.random()).slice(2);
  let state = structuredClone(DEFAULTS);
  let submits = 0;

  // React's inputValueTracking: the node's own value property moves the
  // tracker on every script set, and an input event counts only when the
  // value got away from it.
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  function controlled(input, key) {
    let tracked = native.get.call(input);
    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return native.get.call(this);
      },
      set(v) {
        tracked = String(v);
        native.set.call(this, v);
      },
    });
    input.addEventListener("input", () => {
      const v = native.get.call(input);
      if (v !== tracked) {
        tracked = v;
        setState({ [key]: v });
      }
    });
    // The render's write, as React's: only when the DOM differs.
    return v => {
      if (native.get.call(input) !== v) {
        tracked = v;
        native.set.call(input, v);
      }
    };
  }
  const writeName = controlled($("#name"), "name");

  function setState(patch) {
    state = { ...state, ...patch };
    render();
  }
  function render() {
    writeName(state.name);
    $("#perm-button").textContent = PERMS[state.perm];
    for (const o of document.querySelectorAll("#perm-list [role=option]")) {
      o.setAttribute("aria-selected", String(o.dataset.value === state.perm));
    }
    for (const o of document.querySelectorAll("#zones [role=option]")) {
      o.setAttribute("aria-selected", String(state.zones.includes(o.dataset.value)));
    }
    body.dataset.state = JSON.stringify(state);
  }

  const list = $("#perm-list");
  const open = shown => {
    list.hidden = !shown;
    $("#perm-button").setAttribute("aria-expanded", String(shown));
  };
  $("#perm-button").addEventListener("click", () => open(list.hidden));
  list.addEventListener("click", e => {
    const o = e.target.closest("[role=option]");
    if (o) {
      open(false);
      setState({ perm: o.dataset.value });
    }
  });
  $("#zones").addEventListener("click", e => {
    const o = e.target.closest("[role=option]");
    if (o) {
      const v = o.dataset.value;
      setState({ zones: state.zones.includes(v) ? state.zones.filter(z => z !== v) : [...state.zones, v] });
    }
  });
  $("#token-form").addEventListener("submit", e => {
    e.preventDefault();
    submits++;
    body.dataset.submits = String(submits);
    body.dataset.submitted = JSON.stringify(state);
    $("#result").textContent = "Token created";
  });
  render();
})();
</script>`;

/**
 * Serves the form at /form on a free loopback port, counting each URL's
 * loads (a query string makes a URL of its own).
 *
 * @returns {Promise<{url: (path: string) => string, loadsOf: (path: string) => number, close: () => Promise<void>}>}
 */
export async function reactFormSite() {
  const loads = new Map();
  const server = createServer((req, res) => {
    const n = (loads.get(req.url) ?? 0) + 1;
    loads.set(req.url, n);
    const path = req.url.split("?")[0];
    if (path !== "/form") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(FORM(n));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: path => `http://127.0.0.1:${port}${path}`,
    loadsOf: path => loads.get(path) ?? 0,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/**
 * Page code that fills the form as agents' page.evaluate fills of React forms
 * do: the value attribute and the native setter, then an input event, for the
 * text; clicks for the custom controls. The attribute is a write
 * (content/agentworld.sys.mjs), so the page is written, as Cloudflare's was.
 * None of it is evidence: it leaves nothing in the page that outlives the
 * agent's world (zen-observe's hooked), so the page isn't hooked. With
 * `hook`, the code also leaves something that is: "script", a script element
 * in the page; "handler", an inline handler on the text field.
 *
 * @param {{name: string, perm: string, zones: string[]}} values
 * @param {{hook?: "script"|"handler"|null}} [opts]
 * @returns {string} the code, which returns the form's state as JSON
 */
export function fillByCode({ name, perm, zones }, { hook = null } = {}) {
  const hooks = {
    script: `d.head.append(Object.assign(d.createElement("script"), { textContent: "window.__agentHook = 1" }));`,
    handler: `input.setAttribute("onfocus", "window.__agentHook = 1");`,
  };
  return `(() => {
    const d = document;
    const input = d.querySelector("#name");
    input.setAttribute("value", ${JSON.stringify(name)});
    Object.getOwnPropertyDescriptor(d.defaultView.HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new d.defaultView.Event("input", { bubbles: true }));
    d.querySelector("#perm-button").click();
    d.querySelector('#perm-list [data-value="${perm}"]').click();
    for (const z of ${JSON.stringify(zones)}) d.querySelector('#zones [data-value="' + z + '"]').click();
    ${hook ? hooks[hook] : ""}
    return d.body.dataset.state;
  })()`;
}
