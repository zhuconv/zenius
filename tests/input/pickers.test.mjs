// Picker panels in agent tabs (input/pickers.sys.mjs): an agent click on a
// date, time or color input, or a <select>, opens no browser UI, hidden or
// watched, and the agent hears of the refusal. page.fill and
// page.selectOption set the values. A page's own showPicker() after an agent
// click is refused the same way. Keys typed into date and time inputs set
// them as with system focus (content/input.sys.mjs, syncDateTimeFocus).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";

let h;
let task;

before(async () => {
  h = await openHarness("pickers");
  task = await h.taskSpace("zen-input pickers");
});

after(async () => {
  await h?.finish();
});

const PAGE =
  "data:text/html,<!doctype html><input id=date type=date>" +
  "<select id=sel><option value=a>a</option><option value=b>b</option><option value=c>c</option></select>" +
  "<input id=color type=color value='%23123456'><button id=pick onclick='date.showPicker()'>pick</button>";

const PICKER_POPUPS = ["DateTimePickerPanel", "ColorPickerPanel", "ContentSelectDropdownPopup", "ContentSelectDropdown"];
const pickerStats = () =>
  h.call("dev.evalChrome", { code: `return ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/pickers.sys.mjs").pickerStats();` });

/** Pickers open asynchronously in the parent: give one time to show. */
async function noPickerOpens(how) {
  await h.sleep(300);
  const open = (await h.openPopups()).filter(id => PICKER_POPUPS.includes(id) || /picker|select/i.test(id));
  assert.deepEqual(open, [], `${how}: no picker panel or dropdown opened`);
}

const kinds = receipt => (receipt.refused ?? []).map(r => r.kind);

test("a date input opens no picker panel, hidden or watched; fill sets it", () =>
  h.bothViews(task, PAGE, async (page, how) => {
    // The picker opens from the calendar button at the input's end; a click
    // on the day, month or year opens nothing. (Time inputs have no picker
    // unless dom.forms.datetime.timepicker is on.)
    const box = await page.evaluate(() => {
      const r = document.querySelector("#date").getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const onButton = { position: { x: box.w - 8, y: box.h / 2 } };
    assert.deepEqual(kinds(await page.click("#date", onButton)), ["datePicker"], `${how}: the click's receipt says the picker was refused`);
    await noPickerOpens(how);
    // The page's own showPicker(), with the activation of the agent's click.
    assert.deepEqual(kinds(await page.click("#pick")), ["datePicker"], `${how}: showPicker()`);
    await noPickerOpens(how);
    await page.fill("#date", "2026-11-20");
    assert.equal(await page.evaluate(() => document.querySelector("#date").value), "2026-11-20");
    const events = (await h.call("page.events", { space: page.spaceId, page: page.label })).filter(e => e.method === "Zenius.refused");
    assert.ok(events.some(e => e.params.kind === "datePicker" && /page\.fill/.test(e.params.message)), `${how}: a Zenius.refused event names page.fill`);
  }));

test("a select opens no dropdown, hidden or watched; selectOption chooses", () =>
  h.bothViews(task, PAGE, async (page, how) => {
    assert.deepEqual(kinds(await page.click("#sel")), ["selectDropdown"], `${how}: the click's receipt says the dropdown was refused`);
    await noPickerOpens(how);
    assert.equal(await page.evaluate(() => document.querySelector("#sel").value), "a", `${how}: the select is unchanged`);
    await page.selectOption("#sel", "c");
    assert.equal(await page.evaluate(() => document.querySelector("#sel").value), "c");
    // A second click still gets no dropdown: the first left no state behind.
    assert.deepEqual(kinds(await page.click("#sel")), ["selectDropdown"], `${how}: again`);
    await noPickerOpens(how);
  }));

/** Logs what the page sees: focus moving among its elements, and each input's input and change events. */
const LOG_SCRIPT = `<script>
  window.focusLog = [];
  for (const type of ["focus", "blur"]) addEventListener(type, e => e.target.id && focusLog.push(type + ":" + e.target.id), true);
  window.commits = [];
  for (const el of document.querySelectorAll("input")) for (const type of ["input", "change"]) el.addEventListener(type, () => commits.push(type + ":" + el.id + "=" + el.value));
</script>`;
const TYPING_PAGE =
  "data:text/html," +
  encodeURIComponent(`<!doctype html><input id=date type=date><input id=time type=time><input id=local type=datetime-local><button id=after>after</button>${LOG_SCRIPT}`);
const ONE_DATE = "data:text/html," + encodeURIComponent(`<!doctype html><input id=date type=date><button id=after>after</button>${LOG_SCRIPT}`);

/** The fields of input `id`'s widget in its (the locale's) order: year, month, day, hour, minute, dayperiod. */
const fieldsOf = (page, id) =>
  page.privileged(
    `return [...document.getElementById(arg).openOrClosedShadowRoot.querySelectorAll(".datetime-edit-field")].map(f => f.getAttribute("data-l10n-id").replace("datetime-", ""));`,
    id
  );
/** The widget field that has focus, by the focus manager. */
const focusedField = page =>
  page.privileged(`const f = Services.focus.getFocusedElementForWindow(content, true, {}); return f?.getAttribute?.("data-l10n-id")?.replace("datetime-", "") ?? f?.id ?? null;`);
const valueOf = (page, id) => page.evaluate(id => document.getElementById(id).value, id);
/** Where a user clicks into input `id`'s first field, in the input's box. */
const firstField = (page, id) =>
  page.privileged(
    `const input = document.getElementById(arg);
     const a = input.getBoundingClientRect();
     const b = input.openOrClosedShadowRoot.querySelector(".datetime-edit-field").getBoundingClientRect();
     return { x: b.x - a.x + b.width / 2, y: b.y - a.y + b.height / 2 };`,
    id
  );
/** 2024-01-02 and 21:30 (09 and PM on a 12-hour clock), field by field. */
const typedFor = fields =>
  fields.map(f => ({ year: "2024", month: "01", day: "02", hour: fields.includes("dayperiod") ? "09" : "21", minute: "30", dayperiod: "P" })[f]).join("");

test("digits typed into a date or time input after a click set it, hidden or watched", () =>
  h.bothViews(task, TYPING_PAGE, async (page, how) => {
    const wants = [
      ["date", "2024-01-02"],
      ["time", "21:30"],
      ["local", "2024-01-02T21:30"],
    ];
    for (const [id, want] of wants) {
      const fields = await fieldsOf(page, id);
      // The middle of a time input is its minutes: click into the first field.
      await page.click(`#${id}`, { position: await firstField(page, id) });
      assert.equal(await focusedField(page), fields[0], `${how}: the click focused #${id}'s first field`);
      await page.keyboard.type(typedFor(fields));
      assert.equal(await valueOf(page, id), want, `${how}: #${id}, fields ${fields.join(", ")}`);
    }
    await page.click("#after");
    const seen = await page.evaluate(() => ({ focus: window.focusLog, commits: window.commits }));
    // Focus entered and left each input once, never moving among its fields as far as the page knows.
    assert.deepEqual(seen.focus, ["focus:date", "blur:date", "focus:time", "blur:time", "focus:local", "blur:local", "focus:after"], `${how}: what the page saw of focus`);
    for (const [id, want] of wants) {
      for (const type of ["input", "change"]) {
        assert.ok(seen.commits.includes(`${type}:${id}=${want}`), `${how}: #${id} fired ${type} with its value; saw ${seen.commits.join(" ")}`);
      }
    }
  }));

// Ego prints a date's fields as spinbutton refs (zen-snapshot's dfe0775).
test("a date typed field by field at its spinbutton refs commits in any order, hidden or watched", () =>
  h.bothViews(task, ONE_DATE, async (page, how) => {
    const text = await page.snapshot({ includeRefs: true, scope: "full_page" });
    const NAMES = { year: "Year", month: "Month", day: "Day" };
    const ref = f => {
      const m = new RegExp(`spinbutton "${NAMES[f]}" \\[ref=(\\d+)\\]`).exec(text);
      assert.ok(m, `${how}: a ${NAMES[f]} ref in:\n${text}`);
      return `@${m[1]}`;
    };
    // Last field first: the date commits only as the field that completes it loses focus.
    const fields = (await fieldsOf(page, "date")).reverse();
    for (const f of fields) {
      await page.click(ref(f));
      await page.keyboard.type({ year: "2024", month: "01", day: "02" }[f]);
    }
    assert.equal(await valueOf(page, "date"), "2024-01-02", `${how}: typed ${fields.join(", ")}`);
    // A month left after one digit starts afresh when typed again, as after a user's blur.
    await page.click(ref("month"));
    await page.keyboard.type("1");
    await page.click(ref("day"));
    await page.keyboard.type("15");
    await page.click(ref("month"));
    await page.keyboard.type("2");
    await page.click("#after");
    assert.equal(await valueOf(page, "date"), "2024-02-15", `${how}: the month typed again`);
    assert.deepEqual(await page.evaluate(() => window.focusLog), ["focus:date", "blur:date", "focus:after"], `${how}: what the page saw of focus`);
  }));

test("digits typed after the page focused a date input itself set it, hidden or watched", () =>
  h.bothViews(task, ONE_DATE, async (page, how) => {
    await page.evaluate(() => document.getElementById("date").focus());
    // A month's 9 completes the field at once: the widget must know its focus before that first key.
    const fields = await fieldsOf(page, "date");
    await page.keyboard.type(fields.map(f => ({ year: "2024", month: "9", day: "02" })[f]).join(""));
    assert.equal(await valueOf(page, "date"), "2024-09-02", `${how}: fields ${fields.join(", ")}`);
  }));

test("a color input opens no color picker, hidden or watched; fill sets it", () =>
  h.bothViews(task, PAGE, async (page, how) => {
    const before = await pickerStats();
    assert.deepEqual(kinds(await page.click("#color")), ["colorPicker"], `${how}: the click's receipt says the picker was refused`);
    await noPickerOpens(how);
    const now = await pickerStats();
    assert.equal(now.colorNative, before.colorNative, `${how}: no native color picker opened`);
    assert.equal(now.colorRefused, before.colorRefused + 1, `${how}: the color picker was refused once`);
    assert.equal(await page.evaluate(() => document.querySelector("#color").value), "#123456", `${how}: the color is unchanged`);
    await page.fill("#color", "#ff0000");
    assert.equal(await page.evaluate(() => document.querySelector("#color").value), "#ff0000");
  }));
