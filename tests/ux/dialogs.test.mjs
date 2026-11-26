// JS dialogs the agent intercepted (the observe layer's observe/dialogs.sys.mjs)
// go to Firefox's own prompt UI once the user has control, so the page isn't
// left frozen. Only on a page a window shows: releasing can select the
// dialog's tab, which mustn't move the user's view (I1).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup } from "./lib.mjs";

let h;
let space;
let P;
let userView;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "zen-ux dialogs test" }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const D = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/dialogs.sys.mjs");
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    /** Tab-modal dialogs Firefox shows for the agent's page. */
    const firefoxDialogs = () => {
      const box = gBrowser.getTabDialogBox(browser);
      return [...(box._contentDialogManager?._dialogs ?? []), ...(box._tabDialogManager?._dialogs ?? [])];
    };
    /** The user clicks OK in Firefox's dialog. */
    const acceptFirefoxDialog = async () => {
      await until(() => firefoxDialogs().length);
      const dialog = firefoxDialogs()[0];
      // Its document sets its buttons up once it has loaded.
      await until(() => {
        try {
          return dialog._frame.contentDocument.querySelector("dialog").getButton("accept");
        } catch {
          return null;
        }
      });
      dialog._frame.contentDocument.querySelector("dialog").getButton("accept").click();
      await until(() => !firefoxDialogs().length);
    };
    const showAgentPage = async () => {
      Pages.landOn(tab);
      await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      await until(() => gBrowser.selectedTab === tab);
    };
    const showUserSpace = async () => {
      if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
    };
    const sameView = () => gZenWorkspaces.activeWorkspace === userWs;
  `;
});

after(async () => {
  await h?.chrome(`${P}
    if (D.currentDialog(browser)) D.answerDialog(browser, false);
    if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    await showUserSpace();
  `).catch(() => {});
  await h?.close();
});

/** The agent's page asks confirm(); the observe layer holds it for the agent. */
async function openConfirm() {
  await h.call("dev.evalContent", {
    space,
    page: "p1",
    code: "window.answer = undefined; setTimeout(() => { window.answer = confirm('Go on?'); }, 0); return true;",
  });
  await h.chrome(`${P} await until(() => D.currentDialog(browser));`);
}

const answer = () => h.call("dev.evalContent", { space, page: "p1", code: "return window.answer ?? null;" });

test("Take over hands the agent's dialog on the page the user sees to Firefox's prompt", async () => {
  await h.chrome(`${P} await showAgentPage();`);
  await openConfirm();
  const out = await h.chrome(`${P}
    const before = firefoxDialogs().length;
    await UI.takeOverByUser(rec);
    const held = !!D.currentDialog(browser);
    await acceptFirefoxDialog();
    return { before, held };
  `);
  assert.equal(out.before, 0, "Firefox showed nothing while the agent held it");
  assert.equal(out.held, false, "the agent no longer holds it");
  assert.equal(await answer(), true, "the user's OK reached the page");
  await h.chrome(`${P} ctx.spaces.setOwnership(rec, "agent", { source: "user" }); await showUserSpace();`);
});

test("on a page the user doesn't see, the dialog waits until they open it (I1)", async () => {
  await openConfirm();
  const out = await h.chrome(`${P}
    UI.stopByUser(rec);
    await sleep(200);
    const whileHidden = { held: !!D.currentDialog(browser), shown: firefoxDialogs().length, view: sameView() };
    await UI.openSpace(rec);
    await until(() => firefoxDialogs().length);
    const opened = { held: !!D.currentDialog(browser), shown: firefoxDialogs().length };
    await acceptFirefoxDialog();
    return { whileHidden, opened };
  `);
  assert.deepEqual(out.whileHidden, { held: true, shown: 0, view: true });
  assert.deepEqual(out.opened, { held: false, shown: 1 });
  assert.equal(await answer(), true);
  await h.chrome(`${P} ctx.spaces.setOwnership(rec, "agent", { source: "user" }); await showUserSpace();`);
});

test("if the agent has control again before the user looks, the dialog stays the agent's", async () => {
  await openConfirm();
  const out = await h.chrome(`${P}
    await UI.takeOverByUser(rec);
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    await showAgentPage();
    await sleep(200);
    const result = { held: !!D.currentDialog(browser), shown: firefoxDialogs().length };
    D.answerDialog(browser, false);
    await showUserSpace();
    return result;
  `);
  assert.deepEqual(out, { held: true, shown: 0 });
  assert.equal(await answer(), false, "the agent answered it");
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
