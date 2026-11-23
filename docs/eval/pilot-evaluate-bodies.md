# The pilot's page.evaluate and waitForFunction bodies

For measuring page code in an isolated world: the code the pilot's agents ran
in pages, reduced to its shape. zen-eval, 2026-11-20.

## Where they come from

- **The zenius half of the pilot**: tasks T2, T8 and T13 of
  `docs/eval/live-tasks.md`, rounds 1 to 3 (`docs/eval/live-pilot.md`).
  Round 1 ran T2 only.
- **The Ego half hasn't run.** It waits until its profile is chosen
  (`live-pilot.md`), so there are no Ego transcripts. The zenius
  half's agents wrote the same Ego-style API calls (`page.evaluate`,
  `page.waitForFunction`) that they would write against Ego.
- **What was taken:** every `evaluate(` and `waitForFunction(` call in
  the agents' own tool calls (their Bash commands), and nothing from the
  skill's text or the tool results.
  - 30 calls: 26 `page.evaluate` and 4 `page.waitForFunction`.
  - 26 distinct bodies, listed below. All were on `page`; there
    was no frame or handle.

## How they were scrubbed

- **Removed:** comments.
- **Replaced by a placeholder for its role:** every string, template and
  regex literal.
  - `"<sel>"`: a selector given to `querySelector`, `querySelectorAll`,
    `closest` or `matches`.
  - `"<id>"`: an id given to `getElementById`.
  - `"<text>"`: any other string.
  - `/<regex>/`: a regex.
- **Kept:**
  - attribute names given to `getAttribute`;
  - an upper-case tag name compared with `tagName`;
  - the whitespace regex `/\s+/`;
  - numbers, identifiers and the code's structure.
- **Not left in:** URLs, page text, anything typed into pages, names,
  accounts and paths. Checked by search, and read once by hand.

The classes below were decided on the raw text, before scrubbing.

## Counts by pattern

| Pattern | Bodies (of 26) |
|---|---|
| Page globals (`window.<name>`, or a bare global other than `document`) | 0 |
| Framework internals (`__react*`, `__vue__`, `__NEXT_DATA__`, …) | 0 |
| Expandos (`el.__<name>`) | 0 |
| Wrapped prototypes (a prototype, `fetch`, XHR or `history` replaced) | 0 |
| DOM only | 26 |

A search of the raw bodies found no `window`, `self`, `globalThis`,
`location`, `navigator`, `history`, storage, `fetch`, XHR, `performance`,
`customElements`, timers, `console`, `__` key or `prototype`. The only
free global is `document`.

## DOM features used

| Feature | Bodies (of 26) |
|---|---|
| querySelector/All | 23 |
| rendered text (innerText) | 10 |
| text (textContent) | 9 |
| tree walking (closest, parentElement, nextElementSibling, children) | 7 |
| form state (value, checked, options, form, elements) | 7 |
| attributes (getAttribute, href, className) | 6 |
| open shadow roots (shadowRoot) | 5 |
| regex on text | 4 |
| side effect (scrollIntoView) | 2 |
| markup (innerHTML/outerHTML) | 2 |
| getElementById | 1 |

DOM properties and methods touched: `ach`, `action`, `body`, `checked`,
`children`, `className`, `closest`, `elements`, `form`, `getAttribute`,
`getElementById`, `href`, `id`, `innerHTML`, `innerText`, `method`, `name`,
`nextElementSibling`, `options`, `outerHTML`, `parentElement`,
`querySelector`, `querySelectorAll`, `scrollIntoView`, `selected`,
`shadowRoot`, `tagName`, `text`, `textContent`, `type`, `value`. (`ach` is a
form control read by name, `form.<name>`.)

JavaScript built-ins: `filter`, `find`, `includes`, `indexOf`, `join`,
`map`, `replace`, `slice`, `test`, `trim`.

## What it means for an isolated world

Every body reads or acts on the DOM alone, so each should give the same
result in an isolated world as in the page's own. None reads the page's own
JavaScript state. Four things are worth having in the measurement:
- **Open shadow roots (5 bodies).** They walk `element.shadowRoot`
  recursively, to find a table inside a custom element (`tagName`
  containing `-`).
- **Form controls' live state (7).** `value`, `checked`, `options`,
  `selected`, `form`, `form.elements`, and one named access, `form.<name>`
  (#15). That one is a WebIDL named getter. Check that it resolves through
  Gecko's Xrays as it does in the page.
- **`innerText` (10).** It needs layout.
- **Side effects (2).** `scrollIntoView` moves the page.

`waitForFunction` was always called as `(fn, undefined, { timeout })`,
with 15 000 or 30 000 ms.

## The bodies

### 1. `evaluate`: T2, rounds 1, 3 (2 calls)

```js
() => document.querySelector("<sel>").scrollIntoView()
```

Uses: querySelector/All, side effect.

### 2. `evaluate`: T2, round 1

```js
() => {
  const findTable = (root) => {
    const t = root.querySelector("<sel>");
    if (t) return t;
    for (const el of root.querySelectorAll("<sel>")) {
      if (el.shadowRoot) { const r = findTable(el.shadowRoot); if (r) return r; }
    }
    return null;
  };
  const t = findTable(document);
  if (!t) return null;
  return [...t.querySelectorAll("<sel>")].map(tr => [...tr.querySelectorAll("<sel>")].map(c => c.innerText.replace(/\s+/g,"<text>").trim()));
}
```

Uses: querySelector/All, rendered text, open shadow roots.

### 3. `evaluate`: T13, round 2

```js
() => {
  return [...document.querySelectorAll("<sel>")].slice(0, 12).map((tr) => {
    const sub = tr.nextElementSibling;
    const links = sub ? [...sub.querySelectorAll("<sel>")] : [];
    const commentsLink = links.find((a) => /<regex>/i.test(a.textContent));
    return {
      id: tr.id,
      rank: tr.querySelector("<sel>")?.textContent.trim(),
      title: tr.querySelector("<sel>")?.textContent.trim(),
      score: sub?.querySelector("<sel>")?.textContent.trim(),
      comments: commentsLink?.textContent.replace(/<regex>/g, "<text>").trim(),
      commentsHref: commentsLink?.href,
    };
  });
}
```

Uses: querySelector/All, text, attributes, tree walking, regex on text.

### 4. `evaluate`: T13, round 2

```js
() => {
  const title = document.querySelector("<sel>")?.textContent.trim();
  const score = document.querySelector("<sel>")?.textContent.trim();
  const subLinks = [...document.querySelectorAll("<sel>")].map(a => a.textContent.replace(/<regex>/g, "<text>").trim());
  const comments = [...document.querySelectorAll("<sel>")].slice(0, 5).map((tr) => ({
    id: tr.id,
    indent: tr.querySelector("<sel>")?.getAttribute("indent"),
    user: tr.querySelector("<sel>")?.textContent.trim(),
    snippet: tr.querySelector("<sel>")?.textContent.trim().slice(0, 80),
  }));
  return { title, score, subLinks, comments };
}
```

Uses: querySelector/All, text, attributes.

### 5. `evaluate`: T13, round 2

```js
() => {
  const tr = document.getElementById("<id>");
  const head = tr?.querySelector("<sel>");
  return {
    comheadText: head?.textContent.replace(/\s+/g, "<text>").trim(),
    comheadHTML: head?.innerHTML.slice(0, 600),
  };
}
```

Uses: querySelector/All, getElementById, text, markup.

### 6. `evaluate`: T2, round 2

```js
() => document.querySelector("<sel>")?.scrollIntoView()
```

Uses: querySelector/All, side effect.

### 7. `waitForFunction`: T2, round 2

```js
() => {
  const find = (root) => { const t = root.querySelector("<sel>"); if (t) return t; for (const el of root.querySelectorAll("<sel>")) if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; } return null; };
  const sec = document.querySelector("<sel>")?.closest("<sel>") || document;
  return !!find(sec);
}, undefined, { timeout: 15000 }
```

Uses: querySelector/All, open shadow roots, tree walking.

### 8. `evaluate`: T2, round 2

```js
() => {
  const find = (root) => { const t = root.querySelector("<sel>"); if (t) return t; for (const el of root.querySelectorAll("<sel>")) if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; } return null; };
  const sec = document.querySelector("<sel>")?.closest("<sel>") || document;
  const t = find(sec);
  if (!t) return "<text>";
  const heads = [...t.querySelectorAll("<sel>")].map(x => x.textContent.trim().replace(/\s+/g,"<text>"));
  const rows = [...t.querySelectorAll("<sel>")].map(r => [...r.children].map(c => c.textContent.trim().replace(/\s+/g,"<text>")));
  return { heads, rows };
}
```

Uses: querySelector/All, text, open shadow roots, tree walking.

### 9. `evaluate`: T8, rounds 2, 3 (3 calls)

```js
() => document.querySelector('<sel>').checked
```

Uses: querySelector/All, form state.

### 10. `evaluate`: T8, round 2

```js
() => {
  const r = document.querySelector("<sel>") || document.querySelector("<sel>");
  return {
    ti: document.querySelector('<sel>')?.checked,
    text: (document.querySelector("<sel>")?.closest("<sel>")?.parentElement || document.body).innerText.slice(0, 2000),
  };
}
```

Uses: querySelector/All, rendered text, form state, tree walking.

### 11. `evaluate`: T8, round 2

```js
() => {
  const form = document.querySelector('<sel>').form;
  return [...form.elements].filter(e => e.name).map(e => ({ name: e.name, type: e.type, value: e.value, checked: e.checked, label: (e.closest("<sel>")?.innerText || e.parentElement?.innerText || "<text>").trim().slice(0, 80), opts: e.tagName === "SELECT" ? [...e.options].map(o => o.value + "<text>" + o.text + (o.selected ? "<text>" : "<text>")) : undefined }));
}
```

Uses: querySelector/All, rendered text, form state, tree walking.

### 12. `evaluate`: T8, round 2

```js
() => ({ atyp: document.querySelector('<sel>').value, ach: document.querySelector('<sel>').value, ti: document.querySelector('<sel>').checked, btns: [...document.querySelector('<sel>').form.querySelectorAll('<sel>')].map(b => b.innerText || b.value) })
```

Uses: querySelector/All, rendered text, form state.

### 13. `waitForFunction`: T8, round 2

```js
() => /<regex>/.test(document.body.innerText), undefined, { timeout: 30000 }
```

Uses: rendered text, regex on text.

### 14. `evaluate`: T8, round 2

```js
() => { const t = document.body.innerText; const i = t.indexOf("<text>"); return t.slice(i, i + 900); }
```

Uses: rendered text.

### 15. `evaluate`: T8, round 2

```js
() => { const f = document.querySelector('<sel>').form; const t = document.body.innerText; const i = t.indexOf("<text>"); return { method: f.method, action: f.action, ach: f.ach.value, res: t.slice(i, i + 400) }; }
```

Uses: querySelector/All, rendered text, form state.

### 16. `evaluate`: T13, round 3

```js
() => {
  return [...document.querySelectorAll("<sel>")].slice(0, 12).map((tr) => {
    const sub = tr.nextElementSibling;
    const links = sub ? [...sub.querySelectorAll("<sel>")] : [];
    const commentsLink = links.find((a) => /<regex>/i.test(a.textContent));
    return {
      id: tr.id,
      rank: tr.querySelector("<sel>")?.textContent,
      title: tr.querySelector("<sel>")?.textContent,
      points: sub?.querySelector("<sel>")?.textContent,
      comments: commentsLink?.textContent,
      commentsHref: commentsLink?.href,
    };
  });
}
```

Uses: querySelector/All, text, attributes, tree walking, regex on text.

### 17. `evaluate`: T13, round 3

```js
() => {
  const title = document.querySelector("<sel>")?.textContent;
  const score = document.querySelector("<sel>")?.textContent;
  const comms = [...document.querySelectorAll("<sel>")].slice(0, 5).map((tr) => ({
    indent: tr.querySelector("<sel>")?.getAttribute("indent"),
    user: tr.querySelector("<sel>")?.textContent,
    text: tr.querySelector("<sel>")?.textContent?.slice(0, 80),
  }));
  return { title, score, comms };
}
```

Uses: querySelector/All, text, attributes.

### 18. `evaluate`: T13, round 3

```js
() => {
  const tr = document.querySelector("<sel>");
  const head = tr?.querySelector("<sel>");
  return {
    id: tr?.id,
    headHTML: head?.outerHTML?.slice(0, 1200),
    links: [...(head?.querySelectorAll("<sel>") ?? [])].map((a) => ({ cls: a.className, text: a.textContent, href: a.getAttribute("href") })),
  };
}
```

Uses: querySelector/All, text, markup, attributes.

### 19. `waitForFunction`: T2, round 3

```js
() => document.querySelector("<sel>") !== null, undefined, { timeout: 15000 }
```

Uses: querySelector/All.

### 20. `evaluate`: T2, round 3

```js
() => {
  const out = {};
  const h = document.querySelector("<sel>");
  out.heading = h?.textContent;
  const tables = [...document.querySelectorAll("<sel>")].map(t => t.className);
  out.tables = tables;
  const els = [...document.querySelectorAll("<sel>")].filter(e => e.tagName.includes("<text>") && /<regex>/i.test(e.tagName)).map(e => e.tagName);
  out.custom = els;
  return out;
}
```

Uses: querySelector/All, text, attributes, regex on text.

### 21. `waitForFunction`: T2, round 3

```js
() => {
  const el = document.querySelector("<sel>");
  const find = (root) => { if (!root) return null; const t = root.querySelector("<sel>"); if (t) return t; for (const e of root.querySelectorAll("<sel>")) { if (e.shadowRoot) { const r = find(e.shadowRoot); if (r) return r; } } return null; };
  return !!find(el.shadowRoot || el) || !!find(el);
}, undefined, { timeout: 15000 }
```

Uses: querySelector/All, open shadow roots.

### 22. `evaluate`: T2, round 3

```js
() => {
  const el = document.querySelector("<sel>");
  const find = (root) => { if (!root) return null; const t = root.querySelector("<sel>"); if (t) return t; for (const e of root.querySelectorAll("<sel>")) { if (e.shadowRoot) { const r = find(e.shadowRoot); if (r) return r; } } return null; };
  const t = find(el.shadowRoot) || find(el);
  if (!t) return "<text>";
  return [...t.querySelectorAll("<sel>")].map(r => [...r.querySelectorAll("<sel>")].map(c => c.innerText.replace(/\s+/g, "<text>").trim()).join("<text>")).join("<text>");
}
```

Uses: querySelector/All, rendered text, open shadow roots.

### 23. `evaluate`: T8, round 3

```js
() => (document.querySelector("<sel>") || document.body).innerText.slice(0, 2500)
```

Uses: querySelector/All, rendered text.

### 24. `evaluate`: T8, round 3

```js
() => [...document.querySelectorAll('<sel>')].map(o => ({ sel: o.parentElement.name, value: o.value, text: o.textContent.trim(), selected: o.selected }))
```

Uses: querySelector/All, text, form state, tree walking.

### 25. `evaluate`: T8, round 3 (2 calls)

```js
() => {
  const t = document.body.innerText;
  const i = t.indexOf("<text>");
  return t.slice(i, i + 700);
}
```

Uses: rendered text.

### 26. `evaluate`: T8, round 3

```js
() => ({ ach: document.querySelector('<sel>').value, form: document.querySelector('<sel>').form?.action })
```

Uses: querySelector/All, form state.
