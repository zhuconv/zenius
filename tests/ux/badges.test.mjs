// Agent Space badges (runtime/JS/zenius/ui/badges.sys.mjs): a dot on the
// Space's switcher button and a status pill in its header, kept through Zen's
// own re-renders, without touching the user's view.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, iso } from "./lib.mjs";

let h;
let space;
let P;
let userView;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  // A Space of the task's own, which a claimed user Space is: the Agents
  // Space's shared badge is tests/ux/agentsspace.test.mjs's.
  let page;
  ({ id: space, page } = await h.claimedSpace("zen-ux badge test"));
  P = prelude(space, page);
});

after(async () => {
  await h?.chrome(`${P} B.clearSpaceBadges();`).catch(() => {});
  await h?.close();
});

const READ = `
  const btn = win.document.querySelector('#zen-workspaces-button toolbarbutton[zen-workspace-id="' + rec.uuid + '"]');
  // The status line under the Space's header.
  const statusEl = () => win.document.getElementById(rec.uuid)?.querySelector(":scope > .zenius-space-status");
  const read = () => ({
    attr: btn?.getAttribute("zenius-agent") ?? null,
    dots: btn?.querySelectorAll(":scope > .zenius-space-badge").length ?? -1,
    tooltip: btn?.getAttribute("tooltiptext") ?? null,
    status: statusEl()?.querySelector(".zenius-space-status-text")?.textContent ?? null,
    statusState: statusEl()?.getAttribute("state") ?? null,
  });
`;

// The UI controller derives each badge from the Space's state, so the tests
// change that state rather than set badges directly.
test("a badge shows the state, the state text and the current action", async () => {
  const out = await h.chrome(`${P}${READ}
    ctx.spaces.setStateText(rec, "Finding a table for 2");
    await C.moveCursor(tab, { x: 20, y: 20 }, { label: "Click Submit", kind: "click" });
    return read();
  `);
  assert.equal(out.attr, "working");
  assert.equal(out.dots, 1);
  assert.equal(out.tooltip, `${iso("zen-ux badge test")} — Agent working ${iso("Finding a table for 2")}, ${iso("Click Submit")}`);
  assert.equal(out.status, `Agent working ${iso("Finding a table for 2")}, ${iso("Click Submit")}`);
  assert.equal(out.statusState, "working");
});

test("the badge survives Zen re-rendering the switcher", async () => {
  const out = await h.chrome(`${P}${READ}
    const ws = gZenWorkspaces.getWorkspaceFromId(rec.uuid);
    const updated = new Promise(r => win.addEventListener("ZenWorkspacesUIUpdate", r, { once: true }));
    await gZenWorkspaces.saveWorkspace({ ...ws, name: "zen-ux badge test renamed" });
    await updated;
    await sleep(50);
    return read();
  `);
  assert.equal(out.attr, "working");
  assert.equal(out.dots, 1, "still exactly one badge");
  assert.ok(out.tooltip.startsWith(`${iso("zen-ux badge test renamed")} — Agent working`), out.tooltip);
});

test("state changes restyle the badge; the end of the task removes it", async () => {
  const out = await h.chrome(`${P}${READ}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    ctx.spaces.setStateText(rec, "Log in to continue");
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
    const needs = read();
    UI.stopByUser(rec);
    const cleared = read();
    return { needs, cleared };
  `);
  assert.equal(out.needs.attr, "needs-user");
  assert.equal(out.needs.status, `Agent needs you ${iso("Log in to continue")}`);
  assert.equal(out.cleared.attr, null);
  assert.equal(out.cleared.dots, 0);
  assert.equal(out.cleared.status, null);
  assert.equal(out.cleared.tooltip, "zen-ux badge test renamed", "Zen's own tooltip is back");
  assert.deepEqual(await h.call("dev.viewState"), userView, "the user's view is unchanged");
});
